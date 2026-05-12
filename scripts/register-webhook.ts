// One-shot: register this server's webhook URL with KIRAPAY for the configured API key.
// Run after `pnpm dev` is up and you have a public URL (ngrok in dev).
//
//   pnpm kirapay:register-webhook
//
// Per docs, POST /api/webhooks is upsert — safe to re-run.

import { config } from "../src/config.js";
import { configureWebhook } from "../src/kirapay.js";
import { log } from "../src/log.js";

async function main() {
  const url = `${config.PUBLIC_BASE_URL}/webhooks/kirapay`;
  log.info({ url }, "Registering webhook with KIRAPAY");
  await configureWebhook(url, config.KIRAPAY_WEBHOOK_SECRET);
  log.info("Webhook registered ✅");
}

main().catch((err) => {
  log.error({ err }, "Failed to register webhook");
  process.exit(1);
});
