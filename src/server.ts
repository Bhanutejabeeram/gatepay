import express, { type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { Bot } from "grammy";
import { z } from "zod";
import { config } from "./config.js";
import { log } from "./log.js";
import { prisma } from "./db.js";
import { getTransactionById } from "./kirapay.js";
import { grantAccess } from "./payment.js";
import { parseCustomOrderId } from "./slug.js";

// KIRAPAY's actual webhook payload (observed live, differs from the published docs):
//   {
//     id: "evt_...", type: "transaction.created" | "transaction.succeeded",
//     createdAt: "...",
//     data: { transaction, hash, status, amount, customOrderId, code, name, ... }
//   }
// Headers include X-Kirapay-Event, X-Kirapay-Signature (sha256=base64(hmac)), X-Kirapay-Timestamp.
// We keep backward compat with the published `event` + `data._id` shape just in case.
const WebhookEvent = z.object({
  type: z.string().optional(),
  event: z.string().optional(),
  data: z
    .object({
      // New shape names the field "transaction"; old docs called it "_id".
      transaction: z.string().optional(),
      _id: z.string().optional(),
      status: z.string().optional(),
      hash: z.string().optional(),
      amount: z.number().optional(),
      price: z.number().optional(),
      settlementAmount: z.number().optional(),
      customOrderId: z.string().optional(),
      code: z.string().optional(),
      name: z.string().optional(),
      summary: z
        .object({
          customOrderId: z.string().optional(),
          code: z.string().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
});

export function createServer(bot: Bot<any>) {
  const app = express();

  // Capture the raw body for webhook signature verification before JSON parsing.
  app.use(
    "/webhooks/kirapay",
    express.raw({ type: "application/json", limit: "1mb" }),
  );
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // ---- Public subscribe redirect ----
  // /c/<slug> deep-links into the bot with `start=sub_<slug>`. Telegram opens the bot,
  // the bot's /start handler picks it up and creates the KIRAPAY checkout link.
  app.get("/c/:slug", async (req: Request, res: Response) => {
    const slug = String(req.params.slug ?? "");
    if (!slug) return res.status(400).send("Missing slug.");
    const channel = await prisma.channel.findUnique({ where: { slug } });
    if (!channel || !channel.active) {
      return res.status(404).send("Subscription link not found.");
    }
    const tgUrl = `https://t.me/${config.BOT_USERNAME}?start=sub_${slug}`;
    res.redirect(302, tgUrl);
  });

  // ---- Pay redirect ----
  // The "Pay with KIRAPAY" button in the bot points here, NOT directly at KIRAPAY.
  // This lets us re-check the subscription state at click time and block double-pay
  // when an old payment-link bubble is tapped from chat history after the user has
  // already subscribed.
  app.get("/pay/:paymentId", async (req: Request, res: Response) => {
    const paymentId = String(req.params.paymentId ?? "");
    if (!paymentId) return res.status(400).send("Missing paymentId.");

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { channel: true },
    });
    if (!payment) return res.status(404).send("Payment link not found.");

    // If the subscriber already has active access to this channel, bounce them back
    // to the bot — the bot's handleSubscribe will show the "Already subscribed" view
    // with their existing join link.
    const existing = await prisma.subscription.findUnique({
      where: {
        channelId_subscriberTelegramUserId: {
          channelId: payment.channelId,
          subscriberTelegramUserId: payment.subscriberTelegramUserId,
        },
      },
    });
    if (existing?.expiresAt && existing.expiresAt > new Date()) {
      const tgUrl = `https://t.me/${config.BOT_USERNAME}?start=sub_${payment.channel.slug}`;
      return res.redirect(302, tgUrl);
    }

    if (!payment.kirapayLinkUrl) {
      return res.status(410).send("Payment link expired. Re-open the subscribe URL to get a fresh one.");
    }
    res.redirect(302, payment.kirapayLinkUrl);
  });

  // ---- KIRAPAY webhook ----
  app.post("/webhooks/kirapay", async (req: Request, res: Response) => {
    const raw = req.body as Buffer;

    if (!verifySignature(req, raw)) {
      log.warn({ headers: redactHeaders(req.headers) }, "Webhook signature mismatch");
      return res.status(401).json({ error: "invalid_signature" });
    }

    let parsed;
    try {
      parsed = WebhookEvent.parse(JSON.parse(raw.toString("utf8")));
    } catch (err) {
      log.warn({ err }, "Invalid webhook payload");
      return res.status(400).json({ error: "invalid_payload" });
    }

    const eventType = parsed.type ?? parsed.event ?? "unknown";
    const txId = parsed.data.transaction ?? parsed.data._id;

    log.info({ event: eventType, txId, status: parsed.data.status }, "Webhook received");

    // We act on either:
    //  - transaction.succeeded events, or
    //  - transaction.created events whose data.status indicates success
    //    (KIRAPAY sometimes ships the success state inside the .created webhook).
    const statusLower = (parsed.data.status ?? "").toLowerCase();
    const isSucceeded =
      eventType === "transaction.succeeded" ||
      (eventType === "transaction.created" && statusLower === "success");

    if (!isSucceeded) {
      // Could be transaction.created with Pending status, transaction.refund, etc.
      // Acknowledge so KIRAPAY doesn't retry, but don't grant access yet.
      return res.json({ ok: true, ignored: true });
    }

    if (!txId) {
      log.warn("Webhook missing transaction id");
      return res.status(202).json({ ok: true, unmatched: true });
    }

    // Resolve customOrderId — prefer top-level, then summary, then fetch by id.
    let customOrderId =
      parsed.data.customOrderId ?? parsed.data.summary?.customOrderId;

    if (!customOrderId) {
      try {
        const tx = await getTransactionById(txId);
        customOrderId = tx.summary?.customOrderId;
      } catch (err) {
        log.error({ err, txId }, "Failed to fetch transaction for customOrderId");
      }
    }

    if (!customOrderId) {
      log.warn({ txId }, "No customOrderId — cannot reconcile");
      return res.status(202).json({ ok: true, unmatched: true });
    }

    if (!parseCustomOrderId(customOrderId)) {
      log.warn({ customOrderId }, "customOrderId did not parse — not one of ours");
      return res.status(202).json({ ok: true, unmatched: true });
    }

    try {
      await grantAccess(bot, {
        kirapayTxId: txId,
        customOrderId,
        sourceChainHash: parsed.data.hash,
        settlementAmount: parsed.data.settlementAmount,
      });
    } catch (err) {
      log.error({ err, txId }, "grantAccess failed");
      // Return 500 so KIRAPAY retries.
      return res.status(500).json({ error: "grant_failed" });
    }

    res.json({ ok: true });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error({ err }, "Unhandled server error");
    res.status(500).json({ error: "internal" });
  });

  return app;
}

// KIRAPAY's real signing scheme (observed live):
//   Header: X-Kirapay-Signature: sha256=<base64(HMAC-SHA256(secret, rawBody))>
//   Also sends: X-Kirapay-Timestamp (ms), X-Kirapay-Event, X-Kirapay-Id.
// We try base64 first, then fall back to hex (in case they change format) and a few
// legacy header names for safety. Set KIRAPAY_WEBHOOK_VERIFY=off to bypass during dev.
function verifySignature(req: Request, raw: Buffer): boolean {
  if (process.env.KIRAPAY_WEBHOOK_VERIFY === "off") return true;

  const secret = config.KIRAPAY_WEBHOOK_SECRET;
  // Hmac digests are one-shot — compute once and re-encode for both forms.
  const digest = crypto.createHmac("sha256", secret).update(raw).digest();
  const expectedB64 = digest.toString("base64");
  const expectedHex = digest.toString("hex");

  const candidates = [
    req.header("x-kirapay-signature"),
    req.header("x-webhook-signature"),
    req.header("x-signature"),
  ].filter((v): v is string => typeof v === "string" && v.length > 0);

  for (const c of candidates) {
    const value = c.startsWith("sha256=") ? c.slice("sha256=".length) : c;
    // Try base64 (KIRAPAY's actual scheme).
    try {
      const a = Buffer.from(value, "base64");
      const b = Buffer.from(expectedB64, "base64");
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    } catch {
      // fall through to hex
    }
    // Try hex (the documented scheme).
    try {
      if (
        value.length === expectedHex.length &&
        crypto.timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(expectedHex, "hex"))
      ) {
        return true;
      }
    } catch {
      // Length mismatch on Buffer.from in timingSafeEqual — fall through.
    }
  }

  // Plain shared-secret header fallback.
  const plain = req.header("x-kirapay-secret");
  if (plain && plain === secret) return true;

  return false;
}

function redactHeaders(h: Record<string, string | string[] | undefined>) {
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase().includes("auth") || k.toLowerCase().includes("secret")) continue;
    if (typeof v === "string") safe[k] = v;
  }
  return safe;
}
