import { config } from "./config.js";
import { log } from "./log.js";
import { createBot } from "./bot.js";
import { createServer } from "./server.js";
import { startCron } from "./cron.js";
import { Bot } from "grammy";

async function main() {
  const bot = createBot();
  const app = createServer(bot as unknown as Bot<any>);

  // Track join events so we know whether to kick a user when they expire.
  bot.on("chat_member", async (ctx) => {
    const status = ctx.chatMember.new_chat_member.status;
    const userId = ctx.chatMember.new_chat_member.user.id;
    const chatId = ctx.chat.id;
    if (status === "member") {
      // best-effort: mark this subscription as joined
      await markMember(BigInt(chatId), BigInt(userId), true);
    } else if (["left", "kicked"].includes(status)) {
      await markMember(BigInt(chatId), BigInt(userId), false);
    }
  });

  app.listen(config.PORT, () => {
    log.info({ port: config.PORT, baseUrl: config.PUBLIC_BASE_URL }, "Server listening");
  });

  startCron(bot as unknown as Bot<any>);

  // Use long polling. Switch to webhook mode for production deployments.
  bot.start({
    allowed_updates: ["message", "callback_query", "my_chat_member", "chat_member"],
    onStart: (info) => log.info({ username: info.username }, "Bot started"),
  });

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      log.info({ sig }, "Shutting down");
      bot.stop();
      process.exit(0);
    });
  }
}

async function markMember(chatId: bigint, userId: bigint, isMember: boolean) {
  const { prisma } = await import("./db.js");
  const channel = await prisma.channel.findUnique({ where: { telegramChatId: chatId } });
  if (!channel) return;
  await prisma.subscription
    .updateMany({
      where: { channelId: channel.id, subscriberTelegramUserId: userId },
      data: { isMember },
    })
    .catch(() => {});
}

main().catch((err) => {
  log.error({ err }, "Fatal");
  process.exit(1);
});
