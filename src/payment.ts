// Payment + access-grant flow.
// Two entry points:
//  - startSubscriptionFlow: called from the bot when a user wants to subscribe; creates KIRAPAY link.
//  - grantAccess: called from the webhook handler when KIRAPAY confirms a transaction succeeded.

import { Bot, InlineKeyboard } from "grammy";
import type { Channel, Payment } from "@prisma/client";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { log } from "./log.js";
import { createPaymentLink } from "./kirapay.js";
import { buildCustomOrderId } from "./slug.js";
import { fmtExpiry, mdEscape } from "./format.js";

export type SubscriptionFlowResult = {
  payment: Payment;
  checkoutUrl: string;
};

// Always create a fresh KIRAPAY link on each subscribe click.
// KIRAPAY single-use links lock to one viewer at a time; reusing across browser
// sessions yields "Payment Link Busy". Cheaper to mint a new link per attempt.
// Old pending payments for the same (channel, subscriber) are marked failed
// so they don't pile up in /channels listings.
export async function startSubscriptionFlow(
  channel: Channel,
  subscriberTelegramUserId: bigint,
  subscriber?: { username?: string; displayName?: string },
): Promise<SubscriptionFlowResult> {
  await prisma.payment.updateMany({
    where: {
      channelId: channel.id,
      subscriberTelegramUserId,
      status: "pending",
    },
    data: { status: "failed" },
  });

  const customOrderId = buildCustomOrderId(
    subscriberTelegramUserId,
    channel.id,
    channel.durationDays,
  );

  const payment = await prisma.payment.create({
    data: {
      customOrderId,
      channelId: channel.id,
      subscriberTelegramUserId,
      subscriberUsername: subscriber?.username ?? null,
      subscriberDisplayName: subscriber?.displayName ?? null,
      amountUsd: channel.priceUsd,
      durationDays: channel.durationDays,
      status: "pending",
    },
  });

  const link = await createPaymentLink({
    receiver: channel.settlementAddress,
    settlementChainId: channel.settlementChainId,
    settlementTokenAddress: channel.settlementTokenAddress,
    priceUsd: channel.priceUsd,
    customOrderId,
    name: `Subscribe: ${channel.title} (${channel.durationDays}d)`,
    redirectUrl: `https://t.me/${config.BOT_USERNAME}?start=paid_${payment.id}`,
  });

  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: { kirapayLinkCode: link.code, kirapayLinkUrl: link.url },
  });

  return { payment: updated, checkoutUrl: link.url };
}

// Called from the webhook handler after a successful payment.
// Idempotent: safe to call multiple times for the same kirapayTxId.
export async function grantAccess(
  bot: Bot,
  args: {
    kirapayTxId: string;
    customOrderId: string;
    sourceChainHash: string | undefined;
    settlementAmount: number | undefined;
  },
): Promise<{ already: boolean }> {
  const { kirapayTxId, customOrderId, sourceChainHash, settlementAmount } = args;

  const existing = await prisma.payment.findUnique({ where: { kirapayTxId } });
  if (existing && existing.status === "succeeded") {
    log.info({ kirapayTxId }, "Payment already processed; skipping");
    return { already: true };
  }

  const payment = await prisma.payment.findUnique({ where: { customOrderId } });
  if (!payment) {
    log.warn({ customOrderId, kirapayTxId }, "No matching payment for customOrderId — ignoring");
    return { already: false };
  }

  const channel = await prisma.channel.findUnique({ where: { id: payment.channelId } });
  if (!channel) {
    log.error({ channelId: payment.channelId }, "Channel missing for payment");
    return { already: false };
  }

  // Compute new expiry: extend from the later of (now, current expiry).
  const now = new Date();
  const existingSub = await prisma.subscription.findUnique({
    where: {
      channelId_subscriberTelegramUserId: {
        channelId: channel.id,
        subscriberTelegramUserId: payment.subscriberTelegramUserId,
      },
    },
  });

  const baseDate =
    existingSub?.expiresAt && existingSub.expiresAt > now ? existingSub.expiresAt : now;
  const newExpiresAt = new Date(baseDate.getTime() + payment.durationDays * 24 * 60 * 60 * 1000);

  // Generate a fresh one-time invite link (member_limit=1).
  let inviteLink: string;
  try {
    const invite = await bot.api.createChatInviteLink(Number(channel.telegramChatId), {
      member_limit: 1,
      name: `gp-${payment.id.slice(0, 8)}`,
    });
    inviteLink = invite.invite_link;
  } catch (err) {
    log.error({ err, channelId: channel.id }, "Failed to create invite link — bot needs admin rights");
    throw err;
  }

  const subscription = await prisma.subscription.upsert({
    where: {
      channelId_subscriberTelegramUserId: {
        channelId: channel.id,
        subscriberTelegramUserId: payment.subscriberTelegramUserId,
      },
    },
    create: {
      channelId: channel.id,
      subscriberTelegramUserId: payment.subscriberTelegramUserId,
      startedAt: now,
      expiresAt: newExpiresAt,
      lastInviteLink: inviteLink,
      renewalReminderSent: false,
    },
    update: {
      expiresAt: newExpiresAt,
      lastInviteLink: inviteLink,
      renewalReminderSent: false,
    },
  });

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: "succeeded",
      kirapayTxId,
      sourceChainHash,
      settlementAmount,
      subscriptionId: subscription.id,
    },
  });

  // DM the subscriber with their join link — both as a button (one-tap join) and
  // visible in the text body (copy/verify/share).
  try {
    const titleEsc = mdEscape(channel.title);
    const kb = new InlineKeyboard()
      .url("Join channel", inviteLink)
      .row()
      .text("My subscriptions", "menu:mysubs");
    await bot.api.sendMessage(
      Number(payment.subscriberTelegramUserId),
      [
        `✅ *Payment confirmed*`,
        ``,
        `Subscribed to *${titleEsc}* until *${fmtExpiry(newExpiresAt)}*.`,
        ``,
        `*Your join link (single-use)*`,
        `${inviteLink}`,
        ``,
        `Tap *Join channel* below or open the link directly. It admits one user — use it now.`,
        ``,
        `_I'll DM a renewal reminder 3 days before expiry. Run /mysubs anytime._`,
      ].join("\n"),
      {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      },
    );
  } catch (err) {
    log.warn(
      { err, subscriberId: String(payment.subscriberTelegramUserId) },
      "Could not DM subscriber — they may not have started the bot",
    );
  }

  // Sweep up stale "Pay with KIRAPAY" message bubbles in the subscriber's DM —
  // anything we sent them for this channel that still has a payMessageId. Tidying
  // these prevents accidental double-pay clicks from chat history.
  const staleMessages = await prisma.payment.findMany({
    where: {
      channelId: channel.id,
      subscriberTelegramUserId: payment.subscriberTelegramUserId,
      payMessageId: { not: null },
    },
    select: { id: true, payMessageId: true },
  });
  for (const m of staleMessages) {
    if (!m.payMessageId) continue;
    try {
      await bot.api.deleteMessage(
        Number(payment.subscriberTelegramUserId),
        m.payMessageId,
      );
    } catch (err) {
      // Telegram refuses to delete messages older than 48 hours, or already deleted
      // by the user — treat as no-op so a single stale row doesn't block the rest.
      log.debug(
        { err, paymentId: m.id, messageId: m.payMessageId },
        "Could not delete stale Pay message; ignoring",
      );
    }
    await prisma.payment.update({
      where: { id: m.id },
      data: { payMessageId: null },
    });
  }

  // Notify the channel owner with a "new subscription" message + live metrics.
  try {
    const owner = await prisma.owner.findUnique({ where: { id: channel.ownerId } });
    if (owner) {
      const [activeCount, agg] = await Promise.all([
        prisma.subscription.count({
          where: { channelId: channel.id, expiresAt: { gt: now } },
        }),
        prisma.payment.aggregate({
          where: { channelId: channel.id, status: "succeeded" },
          _count: { _all: true },
          _sum: { settlementAmount: true, amountUsd: true },
        }),
      ]);

      const subscriberLabel = payment.subscriberUsername
        ? `@${payment.subscriberUsername}`
        : payment.subscriberDisplayName
          ? mdEscape(payment.subscriberDisplayName)
          : "A new subscriber";
      const settledSol = settlementAmount != null ? `${settlementAmount} SOL` : "SOL";
      const lifetimeUsd = agg._sum.amountUsd != null ? `~$${agg._sum.amountUsd.toFixed(2)}` : "—";
      const totalPayments = agg._count._all;

      const channelEsc = mdEscape(channel.title);
      const kb = new InlineKeyboard().text("My channels", "menu:channels");
      await bot.api.sendMessage(
        Number(owner.telegramUserId),
        [
          `💰 *New subscription — ${channelEsc}*`,
          ``,
          `${subscriberLabel} subscribed for *${payment.durationDays} days*.`,
          ``,
          `*This payment*  ${settledSol}`,
          `*Active subscribers*  ${activeCount}`,
          `*Lifetime revenue*  ${lifetimeUsd} across ${totalPayments} payment${totalPayments === 1 ? "" : "s"}`,
          ``,
          `Their access runs until *${fmtExpiry(newExpiresAt)}*.`,
        ].join("\n"),
        { parse_mode: "Markdown", reply_markup: kb },
      );
    }
  } catch (err) {
    log.warn(
      { err, channelId: channel.id, ownerId: channel.ownerId },
      "Could not DM channel owner about new subscription",
    );
  }

  log.info(
    { paymentId: payment.id, channelId: channel.id, expiresAt: newExpiresAt },
    "Granted access",
  );
  return { already: false };
}
