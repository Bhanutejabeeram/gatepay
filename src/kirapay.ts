import { z } from "zod";
import { config } from "./config.js";
import { log } from "./log.js";

const CreateLinkResponse = z.object({
  message: z.string(),
  code: z.number(),
  data: z.object({
    url: z.string().url(),
    price: z.number().optional(),
    originalPrice: z.number().optional(),
    code: z.string().optional(),
  }),
});

const TransactionDetailResponse = z.object({
  message: z.string(),
  code: z.number(),
  data: z.object({
    _id: z.string(),
    status: z.string(),
    hash: z.string().optional(),
    price: z.number().optional(),
    settlementAmount: z.number().optional(),
    summary: z
      .object({
        sender: z.string().optional(),
        recipient: z.string().optional(),
        code: z.string().optional(),
        name: z.string().optional(),
        customOrderId: z.string().optional(),
      })
      .optional(),
  }),
});

export type CreateLinkInput = {
  receiver: string;
  settlementChainId: string;
  settlementTokenAddress: string;
  priceUsd: number;
  customOrderId: string;
  name: string;
  redirectUrl: string;
};

export type CreatedLink = {
  url: string;
  code: string;
  price: number | undefined;
};

async function kirapayRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${config.KIRAPAY_BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.KIRAPAY_API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    log.error({ method, path, status: res.status, body: text }, "KIRAPAY request failed");
    throw new Error(`KIRAPAY ${method} ${path} failed: ${res.status} ${text}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`KIRAPAY ${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

// POST /api/link/generate — creates a hosted checkout URL.
// customOrderId is our reconciliation key, of the form "{tgUserId}:{channelId}:{durationDays}".
export async function createPaymentLink(input: CreateLinkInput): Promise<CreatedLink> {
  const raw = await kirapayRequest<unknown>("POST", "/link/generate", {
    tokenOut: {
      chainId: input.settlementChainId,
      address: input.settlementTokenAddress,
    },
    receiver: input.receiver,
    originalPrice: input.priceUsd,
    fiatCurrency: "USD",
    name: input.name,
    customOrderId: input.customOrderId,
    redirectUrl: input.redirectUrl,
    type: "single_use",
    isViewAsCrypto: false,
  });

  const parsed = CreateLinkResponse.parse(raw);
  // KIRAPAY URLs look like https://checkout.kira-pay.com/<code>; derive code from URL if not returned.
  const code = parsed.data.code ?? parsed.data.url.split("/").pop() ?? "";
  return { url: parsed.data.url, code, price: parsed.data.price };
}

// GET /api/wallet/transactions/{id} — fetch full transaction including summary.customOrderId.
// We call this from the webhook handler because the webhook payload itself only ships top-level fields.
export async function getTransactionById(id: string) {
  const raw = await kirapayRequest<unknown>("GET", `/wallet/transactions/${id}`);
  return TransactionDetailResponse.parse(raw).data;
}

// POST /api/webhooks — registers our public webhook URL with KIRAPAY.
// Idempotent per docs ("Create or Update Webhook").
export async function configureWebhook(url: string, secret: string): Promise<void> {
  await kirapayRequest("POST", "/webhooks", { url, secret });
}
