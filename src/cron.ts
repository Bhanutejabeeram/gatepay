import { Bot, InlineKeyboard } from "grammy";
import cron from "node-cron";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { log } from "./log.js";
import { startSubscriptionFlow } from "./payment.js";
import { daysUntil, fmtDate, mdEscape } from "./format.js";

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

// Once per hour, scan for two things:
//  1) Subs expiring within the next 3 days that haven't been reminded yet → DM a renewal link
//  2) Subs already expired → kick the user from the channel and clear isMember
export function startCron(bot: Bot<any>) {
  cron.schedule("17 * * * *", () => runOnce(bot).catch((err) => log.error({ err }, "cron run failed")), {
    timezone: "UTC",
  });
  log.info("Renewal cron scheduled (hourly at :17)");
}

export async function runOnce(bot: Bot<any>) {
  await sendRenewalReminders(bot);
  await kickExpired(bot);
}

async function sendRenewalReminders(bot: Bot<any>) {
  const now = new Date();
  const cutoff = new Date(now.getTime() + THREE_DAYS_MS);

  const subs = await prisma.subscription.findMany({
    where: {
      expiresAt: { gt: now, lte: cutoff },
      renewalReminderSent: false,
    },
    include: { channel: true },
  });

  for (const sub of subs) {
    if (!sub.channel.active) continue;

    try {
      const { checkoutUrl } = await startSubscriptionFlow(
        sub.channel,
        sub.subscriberTelegramUserId,
      );
      const kb = new InlineKeyboard().url("Renew with KIRAPAY", checkoutUrl);
      const titleEsc = mdEscape(sub.channel.title);
      const days = daysUntil(sub.expiresAt!);
      const dateStr = fmtDate(sub.expiresAt!);
      const horizon = days === 0 ? "expires *today*" : days === 1 ? "expires *tomorrow*" : `expires in *${days} days*`;
      await bot.api.sendMessage(
        Number(sub.subscriberTelegramUserId),
        [
          `⏰ *Subscription expiring soon*`,
          ``,
          `Your *${titleEsc}* subscription ${horizon} (${dateStr}).`,
          ``,
          `Tap below to renew. Pay any token on any chain — the owner gets SOL.`,
        ].join("\n"),
        { parse_mode: "Markdown", reply_markup: kb },
      );
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { renewalReminderSent: true },
      });
      log.info({ subId: sub.id }, "Renewal reminder sent");
    } catch (err) {
      log.warn({ err, subId: sub.id }, "Failed to send renewal reminder");
    }
  }
}

async function kickExpired(bot: Bot<any>) {
  const now = new Date();
  const expired = await prisma.subscription.findMany({
    where: { expiresAt: { lt: now }, isMember: true },
    include: { channel: true },
  });

  for (const sub of expired) {
    try {
      // banChatMember + unbanChatMember = "kick" without permanent ban (they can rejoin if they pay again).
      await bot.api.banChatMember(
        Number(sub.channel.telegramChatId),
        Number(sub.subscriberTelegramUserId),
        { until_date: Math.floor(Date.now() / 1000) + 35 },
      );
      await bot.api.unbanChatMember(
        Number(sub.channel.telegramChatId),
        Number(sub.subscriberTelegramUserId),
        { only_if_banned: true },
      );
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { isMember: false },
      });
      log.info({ subId: sub.id }, "Kicked expired subscriber");

      try {
        const titleEsc = mdEscape(sub.channel.title);
        const subUrl = `${config.PUBLIC_BASE_URL}/c/${sub.channel.slug}`;
        const kb = new InlineKeyboard().url("Resubscribe", subUrl);
        await bot.api.sendMessage(
          Number(sub.subscriberTelegramUserId),
          [
            `*Subscription expired*`,
            ``,
            `Your access to *${titleEsc}* has ended.`,
            ``,
            `Tap below to resubscribe — same chain-agnostic checkout, instant SOL settlement to the creator.`,
          ].join("\n"),
          {
            parse_mode: "Markdown",
            link_preview_options: { is_disabled: true },
            reply_markup: kb,
          },
        );
      } catch {
        // User may have blocked the bot — ignore.
      }
    } catch (err) {
      log.warn({ err, subId: sub.id }, "Failed to kick expired subscriber");
    }
  }
}
