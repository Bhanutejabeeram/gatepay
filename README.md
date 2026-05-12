# GatePay

> A Telegram bot that gates private channels behind crypto payments. Subscribers pay any token on any chain — owners receive **SOL on Solana** via [KIRAPAY](https://www.kira-pay.com).

Submission for the **Frontier Hackathon — Cross-Chain Checkout track** (KIRAPAY).

---

## Why this matters

Telegram has the largest creator-monetization gap in social. Paid groups are run on spreadsheets and ad-hoc PayPal links because creators have no good way to:

1. Charge crypto payments without forcing every subscriber to bridge to one chain
2. Auto-grant access on payment without DMs and screenshots
3. Auto-revoke on expiry

GatePay closes that gap by putting KIRAPAY's cross-chain checkout in front of every Telegram channel admin in the world. **A subscriber on Polygon, BSC, Base, or Solana pays once. The owner always gets SOL.**

## Why KIRAPAY is the core enabler (not bolted on)

GatePay is structurally impossible without intent-based cross-chain payments:

- **The subscriber experience** — "any token on any chain" is what unlocks Telegram's global, chain-fragmented user base. Forcing one chain at checkout cuts the addressable audience by an order of magnitude.
- **The owner experience** — uniform SOL settlement means a single Solana wallet, single tax basis, no treasury fragmentation.
- **The grant flow** — KIRAPAY's webhook (`transaction.succeeded`) is the trigger that issues a one-time Telegram invite link. Without it we'd need to run RPC indexers across 11 chains.

KIRAPAY is the rails; GatePay is the consumer surface.

## How it works

```
                                               ┌────────────────────────┐
  Subscriber clicks /c/<slug> in browser       │  Telegram bot          │
  ─────────────────────────────────────────▶   │  /start sub_<slug>     │
                                               │                        │
                                               │  POST /api/link/generate
                                               │  customOrderId =       │
                                               │   "{userId}:{chId}:{d}"│
                                               │           │            │
                                               │           ▼            │
                                               │  KIRAPAY checkout URL  │
                                               └───────────┬────────────┘
                                                           │ DM with
                                                           ▼ pay button
                              ┌────────────────────────────────┐
                              │  KIRAPAY hosted checkout       │
                              │  (any chain / any token)       │
                              └────────────────┬───────────────┘
                                               │ on success
                                               ▼
                              ┌────────────────────────────────┐
                              │  Webhook → /webhooks/kirapay   │
                              │  Verify signature              │
                              │  Fetch tx by id → customOrderId│
                              │  Create one-time invite link   │
                              │  DM subscriber                 │
                              │  Upsert Subscription           │
                              └────────────────────────────────┘
```

The `customOrderId` field — `{telegramUserId}:{channelId}:{durationDays}` — is the reconciliation key. KIRAPAY ships it back on the webhook so we can grant the right subscription to the right person without holding any custodial state.

## Stack

- **TypeScript** — strict, ESM, `tsx` for dev
- **grammY** — Telegram bot framework
- **Express** — webhook receiver + public subscribe redirect (`/c/:slug`)
- **Prisma + Postgres** (Neon) — owners, channels, subscriptions, payments
- **node-cron** — hourly renewal-reminder + kick-on-expiry job
- **zod** — strict request/webhook schema validation

## Repository layout

```
src/
├── index.ts          entry — boots bot, server, cron
├── bot.ts            grammY bot, /start /setup /channels, setup wizard
├── server.ts         Express: /webhooks/kirapay, /c/:slug, /healthz
├── payment.ts        startSubscriptionFlow + grantAccess (idempotent)
├── kirapay.ts        REST client: createPaymentLink, getTransactionById, configureWebhook
├── cron.ts           hourly job: renewal reminders, kick expired
├── slug.ts           slug + customOrderId codec
├── config.ts         zod-validated env
├── log.ts            pino logger
└── db.ts             prisma client
prisma/schema.prisma  Owner, Channel, Subscription, Payment
scripts/register-webhook.ts   one-shot to register webhook URL with KIRAPAY
```

## Setup

### 1. Prerequisites

- Node 20+
- A Telegram bot from [@BotFather](https://t.me/BotFather) — copy the token
- A Neon Postgres connection string ([console.neon.tech](https://console.neon.tech))
- A KIRAPAY API key from [dashboard.kira-pay.com](https://dashboard.kira-pay.com)
- A Solana wallet address (SOL settlement target)
- `ngrok` (or any HTTPS tunnel) for local KIRAPAY webhook delivery

### 2. Install

```bash
npm install
cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN, BOT_USERNAME, KIRAPAY_API_KEY,
#         KIRAPAY_WEBHOOK_SECRET, DATABASE_URL, DEFAULT_SETTLEMENT_ADDRESS
npm run db:push
```

### 3. Run

```bash
# terminal 1 — the bot + server
npm run dev

# terminal 2 — expose webhook publicly
ngrok http 3000
# paste the https URL into PUBLIC_BASE_URL in .env, then re-run terminal 1

# terminal 3 — register the webhook with KIRAPAY (one-shot, upsert)
npm run kirapay:register-webhook
```

In your Telegram bot's [@BotFather settings](https://t.me/BotFather), enable:

- `/setcommands` — `start`, `setup`, `channels`, `cancel`, `help`
- `/setprivacy` — **Disabled** (so the bot can read group/channel updates)
- `/setjoingroups` — **Enabled**

## Demo script (≤ 5 min video)

1. **Owner setup** (≈ 60s)
   - Create a private Telegram channel called *"Alpha Signals"*
   - Add the bot as an admin with *invite users via link* permission
   - Bot DMs the owner: send the title → price (e.g. `9.99`) → duration (`30`)
   - Bot replies with `https://gatepay.app/c/<slug>`

2. **Subscriber pays** (≈ 90s)
   - Click the subscribe URL → opens bot → pay button
   - KIRAPAY checkout opens; pay USDC on Base (different chain than settlement)
   - Show owner's Solana wallet balance going up in SOL

3. **Auto-grant** (≈ 30s)
   - Bot DMs subscriber the one-time invite link, click → joined
   - Show DB: `Subscription.expiresAt` = now + 30d

4. **Renewal cron** (≈ 30s)
   - Manually advance `expiresAt` to 2 days from now in Prisma Studio
   - Run cron once → subscriber gets renewal DM

5. **Expiry kick** (≈ 30s)
   - Set `expiresAt` to past, run cron → subscriber kicked + DM'd resubscribe link

## Production hardening (out of MVP scope, but architected for)

- **Webhook signing** — the verifier in `src/server.ts` tries HMAC-SHA256 across common header conventions; once KIRAPAY publishes the exact scheme, lock to that one header.
- **Webhook idempotency** — `Payment.kirapayTxId` is unique; replays are no-ops.
- **Retries** — non-2xx response causes KIRAPAY to retry; `grantAccess` is idempotent.
- **Multi-region scaling** — bot uses long polling for the demo; switch to webhook mode (`bot.api.setWebhook`) for horizontal scaling.
- **Settlement failure handling** — `transaction.refund` events are acknowledged but not yet processed; full refund flow is the obvious next milestone.

## License

MIT
