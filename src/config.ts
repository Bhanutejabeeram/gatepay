import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  BOT_USERNAME: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url(),

  KIRAPAY_API_KEY: z.string().min(1),
  KIRAPAY_BASE_URL: z.string().url().default("https://api.kira-pay.com/api"),
  KIRAPAY_WEBHOOK_SECRET: z.string().min(1),

  DEFAULT_SETTLEMENT_CHAIN_ID: z.string().default("sol"),
  DEFAULT_SETTLEMENT_TOKEN_ADDRESS: z.string().default("SOL"),
  DEFAULT_SETTLEMENT_ADDRESS: z.string().optional(),

  DATABASE_URL: z.string().min(1),

  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;
