import { Bot, GrammyError, HttpError, InlineKeyboard, session, type Context, type SessionFlavor } from "grammy";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { log } from "./log.js";
import { generateSlug } from "./slug.js";
import { startSubscriptionFlow } from "./payment.js";
import { fmtExpiry, mdEscape, isValidSolanaAddress } from "./format.js";

// --- Setup wizard session: walk new owners through title → price → duration → wallet ---
// First-time owners get all 4 steps; returning owners (already have a saved wallet) skip
// the wallet step and run a 3-step flow.
type SetupStep =
  | "idle"
  | "awaiting_title"
  | "awaiting_price"
  | "awaiting_duration"
  | "awaiting_settlement_address";
type SessionData = {
  setup: {
    step: SetupStep;
    telegramChatId?: number;
    title?: string;
    priceUsd?: number;
    durationDays?: number;
    totalSteps?: number;
  };
  // Standalone "update my settlement wallet" flow, used by the /wallet command.
  // Independent of the setup wizard above.
  walletUpdate?: { awaiting: boolean };
};
type Ctx = Context & SessionFlavor<SessionData>;

export function createBot(): Bot<Ctx> {
  const bot = new Bot<Ctx>(config.TELEGRAM_BOT_TOKEN);

  bot.use(
    session<SessionData, Ctx>({
      initial: () => ({ setup: { step: "idle" } }),
    }),
  );

  // ---- /start: subscribe deep-links land here as `/start sub_<slug>` and `/start paid_<paymentId>` ----
  bot.command("start", async (ctx) => {
    const arg = ctx.match?.toString().trim();

    if (arg?.startsWith("sub_")) {
      const slug = arg.slice(4);
      return handleSubscribe(ctx, slug);
    }

    if (arg?.startsWith("paid_")) {
      const kb = new InlineKeyboard()
        .text("My subscriptions", "menu:mysubs")
        .text("Home", "menu:home");
      return ctx.reply(
        [
          "⏳ *Payment processing*",
          "",
          "Hang tight — once your transaction confirms on-chain, I'll DM you a one-time join link here.",
          "",
          "Cross-chain settlements typically land in under 60 seconds.",
        ].join("\n"),
        { parse_mode: "Markdown", reply_markup: kb },
      );
    }

    await sendMainMenu(ctx);
  });

  bot.command("help", (ctx) => sendHelp(ctx));

  bot.command("cancel", async (ctx) => {
    ctx.session.setup = { step: "idle" };
    await ctx.reply("Setup cancelled. Run /setup anytime to start over.");
  });

  // ---- /wallet: view or update the owner's Solana settlement wallet ----
  bot.command("wallet", async (ctx) => sendWallet(ctx));

  // ---- bot promoted to admin in a channel: kick off setup automatically ----
  bot.on("my_chat_member", async (ctx) => {
    const update = ctx.myChatMember;
    const chat = update.chat;
    if (chat.type !== "channel") return;
    const newStatus = update.new_chat_member.status;
    if (newStatus !== "administrator") return;

    // Identify the human who promoted us — they become the channel owner in our DB.
    const promoter = update.from;
    if (!promoter || promoter.is_bot) return;

    const owner = await prisma.owner.upsert({
      where: { telegramUserId: BigInt(promoter.id) },
      update: { telegramUsername: promoter.username },
      create: {
        telegramUserId: BigInt(promoter.id),
        telegramUsername: promoter.username,
      },
    });

    // If a Channel row already exists for this chat, the bot was re-promoted on a
    // channel that's already configured — nothing to do.
    const existing = await prisma.channel.findUnique({
      where: { telegramChatId: BigInt(chat.id) },
    });
    if (existing) {
      log.info({ chatId: chat.id }, "Re-promoted on already-configured channel; skipping pending");
      return;
    }

    // Upsert a PendingChannel record so it survives bot restarts.
    await prisma.pendingChannel.upsert({
      where: { telegramChatId: BigInt(chat.id) },
      update: {
        telegramUserId: BigInt(promoter.id),
        channelTitle: chat.title ?? null,
      },
      create: {
        telegramUserId: BigInt(promoter.id),
        telegramChatId: BigInt(chat.id),
        channelTitle: chat.title ?? null,
      },
    });

    try {
      const channelTitle = mdEscape(chat.title ?? "your channel");
      const totalSteps = owner.settlementAddress ? 3 : 4;
      const startKb = new InlineKeyboard().text("Set up channel", "start-setup");
      await ctx.api.sendMessage(
        promoter.id,
        [
          `🎉 *Connected to ${channelTitle}*`,
          ``,
          `I'm now an admin and ready to accept payments.`,
          ``,
          `Tap below to register this channel — ${totalSteps} quick steps and you'll have a subscribe URL to share.`,
        ].join("\n"),
        { parse_mode: "Markdown", reply_markup: startKb },
      );
    } catch {
      log.warn(
        { promoterId: promoter.id },
        "Could not DM promoter — they probably haven't started the bot. Pending channel saved; ask them to /start the bot.",
      );
    }
  });

  // ---- /setup: launches the wizard. Requires the bot to be admin in at least one channel. ----
  bot.command("setup", (ctx) => startSetup(ctx));

  // Same as /setup but triggered by the "Set up channel" button in the connected DM.
  bot.callbackQuery("start-setup", async (ctx) => {
    await ctx.answerCallbackQuery();
    await startSetup(ctx);
  });

  // Picker: owner has 2+ pending channels and chose one to register first.
  bot.callbackQuery(/^pick-pending:(.+)$/, async (ctx) => {
    const pendingId = ctx.match[1];
    if (!pendingId) return;
    const tgUserId = ctx.from?.id;
    if (!tgUserId) {
      await ctx.answerCallbackQuery({ text: "Cannot identify user.", show_alert: true });
      return;
    }
    const pending = await prisma.pendingChannel.findUnique({
      where: { id: pendingId },
    });
    if (!pending || pending.telegramUserId !== BigInt(tgUserId)) {
      await ctx.answerCallbackQuery({ text: "That option is no longer available.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await launchWizardFor(ctx, tgUserId, Number(pending.telegramChatId));
  });

  // ---- /channels: list owner's channels with subscriber counts + delete buttons ----
  bot.command("channels", async (ctx) => sendChannels(ctx));

  // ---- Channel deletion (in-place edit flow) ----
  // Delete button on the channels list edits the message into a confirmation view.
  // Confirm: cascade-deletes and edits the same message back to the (now updated)
  //   channels list. Cancel: re-renders the channels list. No new bubbles, ever.
  bot.callbackQuery(/^delete:(.+)$/, async (ctx) => {
    const channelId = ctx.match[1];
    if (!channelId) return;
    const verified = await verifyOwnsChannel(ctx, channelId);
    if (!verified) return;

    const subCount = await prisma.subscription.count({
      where: { channelId, expiresAt: { gt: new Date() } },
    });

    const lines = [
      `*Delete this channel?*`,
      ``,
      `*${mdEscape(verified.channel.title)}*`,
      `${subCount} active subscriber${subCount === 1 ? "" : "s"}`,
      ``,
      `This permanently removes the channel, its subscribe URL, and all subscription + payment records.`,
    ];
    if (subCount > 0) {
      lines.push(
        ``,
        `⚠️ Active subscribers will keep their Telegram channel membership but won't be auto-removed at expiry.`,
      );
    }
    lines.push(``, `_This cannot be undone._`);

    const kb = new InlineKeyboard()
      .text("Yes, delete permanently", `confirm-delete:${channelId}`)
      .row()
      .text("Cancel", "menu:channels");

    await viewReply(ctx, lines.join("\n"), { reply_markup: kb });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^confirm-delete:(.+)$/, async (ctx) => {
    const channelId = ctx.match[1];
    if (!channelId) return;
    const verified = await verifyOwnsChannel(ctx, channelId);
    if (!verified) return;

    try {
      await prisma.channel.delete({ where: { id: channelId } });
    } catch (err) {
      log.warn({ err, channelId }, "delete failed; channel may have already been removed");
    }
    await ctx.answerCallbackQuery({ text: `${verified.channel.title} deleted` });
    // Re-render the channels list in the same message — reflects the deletion immediately.
    await sendChannels(ctx);
  });

  // ---- Main-menu navigation callbacks ----
  bot.callbackQuery("menu:channels", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendChannels(ctx);
  });
  bot.callbackQuery("menu:mysubs", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendMysubs(ctx);
  });
  bot.callbackQuery("menu:wallet", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendWallet(ctx);
  });
  bot.callbackQuery("menu:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendHelp(ctx);
  });
  bot.callbackQuery("menu:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendMainMenu(ctx);
  });

  // ---- Cancel button under setup wizard steps ----
  bot.callbackQuery("cancel-setup", async (ctx) => {
    ctx.session.setup = { step: "idle" };
    await ctx.editMessageText("Setup cancelled. Run /setup anytime to start over.");
    await ctx.answerCallbackQuery({ text: "Setup cancelled" });
  });

  // ---- Update wallet button: arm session and prompt for new address ----
  bot.callbackQuery("update-wallet", async (ctx) => {
    ctx.session.walletUpdate = { awaiting: true };
    await viewReply(
      ctx,
      [
        `*Update settlement wallet*`,
        ``,
        `Reply with a new Solana wallet address.`,
        ``,
        `_Future channels will settle here. Existing channels keep their original wallet._`,
      ].join("\n"),
      { reply_markup: new InlineKeyboard().text("Cancel", "cancel-wallet-update") },
    );
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("cancel-wallet-update", async (ctx) => {
    ctx.session.walletUpdate = { awaiting: false };
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    await sendWallet(ctx);
  });

  // ---- /mysubs: list a subscriber's active subscriptions with Join/Renew buttons ----
  bot.command("mysubs", async (ctx) => sendMysubs(ctx));

  // ---- Setup wizard message handler ----
  bot.on("message:text", async (ctx, next) => {
    if (ctx.chat?.type !== "private") return next();
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return next();

    const tgUserId = ctx.from?.id;
    if (!tgUserId) return;

    // Standalone wallet-update flow (armed by /wallet or the Update wallet button).
    // Takes precedence over the setup wizard so a user updating their wallet doesn't
    // accidentally trigger setup auto-recovery.
    if (ctx.session.walletUpdate?.awaiting) {
      const addr = text.trim();
      if (!isValidSolanaAddress(addr)) {
        return ctx.reply(
          "That doesn't look like a valid Solana address. Reply with a base58 address (32–44 chars, no `0`/`O`/`I`/`l`), or tap Cancel.",
          { parse_mode: "Markdown" },
        );
      }
      await prisma.owner.upsert({
        where: { telegramUserId: BigInt(tgUserId) },
        update: { settlementAddress: addr },
        create: { telegramUserId: BigInt(tgUserId), settlementAddress: addr },
      });
      ctx.session.walletUpdate = { awaiting: false };
      const kb = new InlineKeyboard()
        .text("My channels", "menu:channels")
        .text("Home", "menu:home");
      return ctx.reply(
        [
          `*Settlement wallet saved*`,
          ``,
          `\`${addr}\``,
          ``,
          `_Future channels will settle here. Existing channels keep their original wallet._`,
        ].join("\n"),
        { parse_mode: "Markdown", reply_markup: kb },
      );
    }

    // Auto-recovery: if the user has a pending setup (bot was just added as admin)
    // but their DM session is still idle, initialize the wizard so the message they
    // typed is treated as the title. Reads from the DB so it survives bot restarts.
    if (ctx.session.setup.step === "idle") {
      const pending = await prisma.pendingChannel.findFirst({
        where: { telegramUserId: BigInt(tgUserId) },
        orderBy: { createdAt: "desc" },
      });
      if (pending) {
        const owner = await prisma.owner.findUnique({
          where: { telegramUserId: BigInt(tgUserId) },
        });
        ctx.session.setup = {
          step: "awaiting_title",
          telegramChatId: Number(pending.telegramChatId),
          totalSteps: owner?.settlementAddress ? 3 : 4,
        };
      }
    }

    const setup = ctx.session.setup;
    const totalSteps = setup.totalSteps ?? 4;

    if (setup.step === "awaiting_title") {
      if (text.length > 80) {
        return ctx.reply("Title is too long. Send something under 80 characters.");
      }
      ctx.session.setup = { ...setup, title: text, step: "awaiting_price" };
      return ctx.reply(
        [
          `*Step 2 of ${totalSteps}* — Subscription price`,
          "",
          "Reply with the amount in USD.",
          "",
          "_Examples: 9.99, 30, 1_",
        ].join("\n"),
        { parse_mode: "Markdown", reply_markup: cancelSetupKb() },
      );
    }

    if (setup.step === "awaiting_price") {
      const price = Number(text);
      if (!Number.isFinite(price) || price <= 0 || price > 10000) {
        return ctx.reply(
          "That doesn't look right. Send a USD amount between 0.01 and 10000.",
        );
      }
      ctx.session.setup = { ...setup, priceUsd: price, step: "awaiting_duration" };
      return ctx.reply(
        [
          `*Step 3 of ${totalSteps}* — Subscription duration`,
          "",
          "Reply with the number of days each subscription lasts.",
          "",
          "_Examples: 7, 30, 365_",
        ].join("\n"),
        { parse_mode: "Markdown", reply_markup: cancelSetupKb() },
      );
    }

    if (setup.step === "awaiting_duration") {
      const days = parseInt(text, 10);
      if (!Number.isFinite(days) || days <= 0 || days > 3650) {
        return ctx.reply("Duration must be a positive number of days (max 3650).");
      }

      if (!setup.telegramChatId || !setup.title || !setup.priceUsd) {
        ctx.session.setup = { step: "idle" };
        return ctx.reply(
          "Setup state was lost — please re-promote me to admin and try again.",
        );
      }

      const owner = await prisma.owner.findUnique({
        where: { telegramUserId: BigInt(tgUserId) },
      });
      if (!owner) {
        ctx.session.setup = { step: "idle" };
        return ctx.reply("Couldn't find your owner record. Please re-promote me to admin.");
      }

      // Returning owner (wallet on file) skips the wallet step.
      if (owner.settlementAddress) {
        return finalizeChannelSetup(ctx, tgUserId, owner.id, {
          title: setup.title,
          priceUsd: setup.priceUsd,
          telegramChatId: setup.telegramChatId,
          durationDays: days,
          settlementAddress: owner.settlementAddress,
        });
      }

      // First-time owner: ask for their Solana wallet.
      ctx.session.setup = {
        ...setup,
        durationDays: days,
        step: "awaiting_settlement_address",
      };
      return ctx.reply(
        [
          `*Step 4 of ${totalSteps}* — Solana settlement wallet`,
          "",
          "Reply with the Solana wallet address where you want to receive subscription revenue.",
          "",
          "All payments — regardless of which chain or token a subscriber uses — settle to this wallet as native SOL.",
          "",
          "_Example: GnFnBDwsmJJLNQB5NRnwKawZKq7s1yHJsKmwTyxFaU3o_",
        ].join("\n"),
        { parse_mode: "Markdown", reply_markup: cancelSetupKb() },
      );
    }

    if (setup.step === "awaiting_settlement_address") {
      const addr = text.trim();
      if (!isValidSolanaAddress(addr)) {
        return ctx.reply(
          "That doesn't look like a valid Solana address. Please paste a base58 wallet address (32–44 chars, no `0`/`O`/`I`/`l`).",
          { parse_mode: "Markdown" },
        );
      }

      if (
        !setup.telegramChatId ||
        !setup.title ||
        !setup.priceUsd ||
        !setup.durationDays
      ) {
        ctx.session.setup = { step: "idle" };
        return ctx.reply(
          "Setup state was lost — please re-promote me to admin and try again.",
        );
      }

      const owner = await prisma.owner.findUnique({
        where: { telegramUserId: BigInt(tgUserId) },
      });
      if (!owner) {
        ctx.session.setup = { step: "idle" };
        return ctx.reply("Couldn't find your owner record. Please re-promote me to admin.");
      }

      // Save the wallet on the Owner so future channels skip this step.
      await prisma.owner.update({
        where: { id: owner.id },
        data: { settlementAddress: addr },
      });

      return finalizeChannelSetup(ctx, tgUserId, owner.id, {
        title: setup.title,
        priceUsd: setup.priceUsd,
        telegramChatId: setup.telegramChatId,
        durationDays: setup.durationDays,
        settlementAddress: addr,
      });
    }

    return next();
  });

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) log.error({ err: e }, "grammY API error");
    else if (e instanceof HttpError) log.error({ err: e }, "Telegram fetch error");
    else log.error({ err: e }, "Unhandled bot error");
  });

  return bot;
}

// PendingChannel rows in Postgres replace the old in-memory `pendingSetup` Map.
// They survive bot restarts and let us show a picker when an owner has multiple
// pending channels.

// ---- View helpers — shared between commands and menu callbacks ----
//
// All navigation views (sendMainMenu, sendChannels, sendMysubs, sendWallet, sendHelp)
// route through `viewReply`. When the trigger is a callback button, it edits the
// existing message — so the chat stays as a single, in-place view instead of stacking
// up duplicate cards. When the trigger is a text command, it replies normally.

function cancelSetupKb(): InlineKeyboard {
  return new InlineKeyboard().text("Cancel setup", "cancel-setup");
}

function homeKb(): InlineKeyboard {
  return new InlineKeyboard().text("Home", "menu:home");
}

type ViewOptions = {
  reply_markup?: InlineKeyboard;
  parse_mode?: "Markdown" | "HTML";
  link_preview_disabled?: boolean;
};

async function viewReply(ctx: Ctx, text: string, options: ViewOptions = {}) {
  const sendOpts = {
    parse_mode: options.parse_mode ?? ("Markdown" as const),
    link_preview_options: { is_disabled: options.link_preview_disabled ?? true },
    reply_markup: options.reply_markup,
  };

  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, sendOpts);
      return;
    } catch (err) {
      // Edit fails when message is too old, unchanged, or has different media type.
      // Fall through to reply so the user always sees the new view.
      log.debug({ err }, "viewReply edit failed; falling back to reply");
    }
  }
  await ctx.reply(text, sendOpts);
}

async function sendMainMenu(ctx: Ctx) {
  const kb = new InlineKeyboard()
    .text("My channels", "menu:channels")
    .text("My subscriptions", "menu:mysubs")
    .row()
    .text("Wallet", "menu:wallet")
    .text("Help", "menu:help");

  await viewReply(
    ctx,
    [
      "👋 *Welcome to GatePay*",
      "",
      "Monetize private Telegram channels with crypto. Subscribers pay any token on any chain — you receive SOL on Solana, settled in seconds via KIRAPAY.",
      "",
      "*Creators:* add me as admin in your channel, then run /setup.",
      "*Subscribers:* tap *My subscriptions* below.",
    ].join("\n"),
    { reply_markup: kb },
  );
}

async function sendHelp(ctx: Ctx) {
  const kb = new InlineKeyboard()
    .text("My channels", "menu:channels")
    .text("My subscriptions", "menu:mysubs")
    .row()
    .text("Wallet", "menu:wallet")
    .text("Home", "menu:home");

  await viewReply(
    ctx,
    [
      "*GatePay — Commands*",
      "",
      "*Creators*",
      "/setup — register a new gated channel",
      "/channels — list, share, and delete your channels",
      "/wallet — view or update your Solana settlement wallet",
      "",
      "*Subscribers*",
      "/mysubs — view your active subscriptions",
      "",
      "*Other*",
      "/cancel — abort the current setup",
      "/help — show this menu",
      "",
      "_Creators: add me as admin in your private channel before running /setup._",
    ].join("\n"),
    { reply_markup: kb },
  );
}

async function sendChannels(ctx: Ctx) {
  if (ctx.chat?.type !== "private") return;
  const tgUserId = ctx.from?.id;
  if (!tgUserId) return;

  const owner = await prisma.owner.findUnique({
    where: { telegramUserId: BigInt(tgUserId) },
    include: {
      channels: {
        orderBy: { createdAt: "desc" },
        include: {
          subscriptions: {
            where: { expiresAt: { gt: new Date() } },
            select: { id: true },
          },
          payments: {
            where: { status: "succeeded" },
            select: { amountUsd: true },
          },
        },
      },
    },
  });

  if (!owner || owner.channels.length === 0) {
    return viewReply(
      ctx,
      [
        "*No channels yet*",
        "",
        "Add me as admin in a private channel and run /setup to register your first one.",
      ].join("\n"),
      { reply_markup: homeKb() },
    );
  }

  const channels = owner.channels;
  const blocks = channels.map((c) => {
    const subUrl = `${config.PUBLIC_BASE_URL}/c/${c.slug}`;
    const activeSubs = c.subscriptions.length;
    const totalPayments = c.payments.length;
    const revenueUsd = c.payments.reduce((s, p) => s + p.amountUsd, 0);
    const subsLabel =
      activeSubs === 1 ? "1 active subscriber" : `${activeSubs} active subscribers`;
    const revenueLabel =
      totalPayments > 0
        ? `~$${revenueUsd.toFixed(2)} across ${totalPayments} payment${totalPayments === 1 ? "" : "s"}`
        : "no payments yet";
    return [
      `*${mdEscape(c.title)}*`,
      `\`$${c.priceUsd}\` for *${c.durationDays} days*`,
      `${subsLabel} · ${revenueLabel}`,
      `${subUrl}`,
    ].join("\n");
  });

  const kb = new InlineKeyboard();
  for (const c of channels) {
    kb.text(`Delete: ${shortTitle(c.title)}`, `delete:${c.id}`).row();
  }
  kb.text("Home", "menu:home");

  await viewReply(
    ctx,
    [`*Your channels* (${channels.length})`, "", blocks.join("\n\n")].join("\n"),
    { reply_markup: kb },
  );
}

async function sendMysubs(ctx: Ctx) {
  if (ctx.chat?.type !== "private") return;
  const tgUserId = ctx.from?.id;
  if (!tgUserId) return;

  const subs = await prisma.subscription.findMany({
    where: { subscriberTelegramUserId: BigInt(tgUserId) },
    include: { channel: true },
    orderBy: { expiresAt: "asc" },
  });

  const now = new Date();
  const active = subs.filter((s) => s.expiresAt && s.expiresAt > now);

  if (active.length === 0) {
    return viewReply(
      ctx,
      [
        "*No active subscriptions*",
        "",
        "When a creator shares a GatePay subscribe link with you, click it to subscribe. Your active passes will appear here with days remaining.",
      ].join("\n"),
      { reply_markup: homeKb() },
    );
  }

  // Single consolidated view: all subs in one message body, all action buttons in one
  // inline keyboard. Each row pairs a Join button with a Renew button per subscription.
  const lines: string[] = [`*Your subscriptions* (${active.length})`, ""];
  active.forEach((s, i) => {
    lines.push(`*${i + 1}. ${mdEscape(s.channel.title)}*`);
    lines.push(`Active until *${fmtExpiry(s.expiresAt!)}*`);
    if (i < active.length - 1) lines.push("");
  });

  const kb = new InlineKeyboard();
  active.forEach((s, i) => {
    const subUrl = `${config.PUBLIC_BASE_URL}/c/${s.channel.slug}`;
    const label = `${i + 1}. ${shortTitle(s.channel.title, 18)}`;
    if (s.lastInviteLink) {
      kb.url(`Join ${label}`, s.lastInviteLink).row();
    }
    kb.url(`Renew ${label}`, subUrl).row();
  });
  kb.text("Home", "menu:home");

  await viewReply(ctx, lines.join("\n"), { reply_markup: kb });
}

// Initialize the wizard session and prompt for the display title. Called by both
// the /setup command and the "Set up channel" inline button on the connected DM.
//
// Reads pending channels from the DB. If there's exactly one, starts the wizard for
// that channel. If there are 2+, shows a picker keyboard. If there are zero, shows
// the "no channel waiting" empty state.
async function startSetup(ctx: Ctx) {
  if (ctx.chat?.type !== "private") {
    return ctx.reply("Please run /setup in a DM with me.");
  }
  const tgUserId = ctx.from?.id;
  if (!tgUserId) return;

  const pendingList = await prisma.pendingChannel.findMany({
    where: { telegramUserId: BigInt(tgUserId) },
    orderBy: { createdAt: "desc" },
  });

  if (pendingList.length === 0) {
    return viewReply(
      ctx,
      [
        "*No channel waiting on setup*",
        "",
        "Add me as admin in your private channel first:",
        "• Channel info → *Administrators* → *Add Admin*",
        `• Search *@${config.BOT_USERNAME}*`,
        "• Enable *Invite Users via Link*",
        "",
        "I'll DM you the moment I'm in.",
      ].join("\n"),
      { reply_markup: homeKb() },
    );
  }

  if (pendingList.length > 1) {
    const kb = new InlineKeyboard();
    for (const p of pendingList) {
      const label = shortTitle(p.channelTitle ?? `Channel ${p.telegramChatId}`, 30);
      kb.text(label, `pick-pending:${p.id}`).row();
    }
    kb.text("Home", "menu:home");
    return viewReply(
      ctx,
      [
        `*Choose a channel to set up* (${pendingList.length})`,
        "",
        "You've added me as admin in multiple channels. Pick which one to register first — you can configure the others later by running /setup again.",
      ].join("\n"),
      { reply_markup: kb },
    );
  }

  // Exactly one pending — start its wizard immediately.
  const only = pendingList[0]!;
  await launchWizardFor(ctx, tgUserId, Number(only.telegramChatId));
}

// Begin the wizard for a specific pending channel. Sets the session state and shows
// the Step 1 prompt. Used by both startSetup (single pending) and the picker callback.
async function launchWizardFor(ctx: Ctx, tgUserId: number, telegramChatId: number) {
  const owner = await prisma.owner.findUnique({
    where: { telegramUserId: BigInt(tgUserId) },
  });
  const totalSteps = owner?.settlementAddress ? 3 : 4;
  ctx.session.setup = {
    step: "awaiting_title",
    telegramChatId,
    totalSteps,
  };
  await viewReply(
    ctx,
    [
      `*Step 1 of ${totalSteps}* — Display title`,
      "",
      "Reply with what subscribers should see at checkout (max 80 chars).",
      "",
      "_Example: Daily Alpha Signals_",
    ].join("\n"),
    { reply_markup: cancelSetupKb() },
  );
}

async function sendWallet(ctx: Ctx) {
  if (ctx.chat?.type !== "private") return;
  const tgUserId = ctx.from?.id;
  if (!tgUserId) return;

  const owner = await prisma.owner.findUnique({
    where: { telegramUserId: BigInt(tgUserId) },
  });

  if (!owner?.settlementAddress) {
    // No wallet on file — arm the session to capture the next plain-text message as
    // a Solana address and reply with a simple prompt.
    ctx.session.walletUpdate = { awaiting: true };
    return viewReply(
      ctx,
      [
        `*No settlement wallet set*`,
        ``,
        `Reply with your Solana wallet address — I'll save it and use it for all your channels.`,
        ``,
        `_Example: GnFnBDwsmJJLNQB5NRnwKawZKq7s1yHJsKmwTyxFaU3o_`,
      ].join("\n"),
      { reply_markup: homeKb() },
    );
  }

  // Wallet set — show it with an Update button.
  const kb = new InlineKeyboard()
    .text("Update wallet", "update-wallet")
    .row()
    .text("Home", "menu:home");
  return viewReply(
    ctx,
    [
      `*Settlement wallet*`,
      ``,
      `\`${owner.settlementAddress}\``,
      ``,
      `_Existing channels keep their original wallet — delete and recreate to switch._`,
    ].join("\n"),
    { reply_markup: kb },
  );
}

// Final step of the wizard (for both 3-step and 4-step paths). Creates the channel and
// renders the "is live" confirmation. Idempotent failure handling: if the row already
// exists we tell the owner clearly and reset state.
async function finalizeChannelSetup(
  ctx: Ctx,
  _tgUserId: number,
  ownerId: string,
  data: {
    title: string;
    priceUsd: number;
    telegramChatId: number;
    durationDays: number;
    settlementAddress: string;
  },
): Promise<void> {
  try {
    const channel = await prisma.channel.create({
      data: {
        slug: generateSlug(),
        title: data.title,
        telegramChatId: BigInt(data.telegramChatId),
        ownerId,
        priceUsd: data.priceUsd,
        durationDays: data.durationDays,
        settlementAddress: data.settlementAddress,
        settlementChainId: config.DEFAULT_SETTLEMENT_CHAIN_ID,
        settlementTokenAddress: config.DEFAULT_SETTLEMENT_TOKEN_ADDRESS,
      },
    });

    ctx.session.setup = { step: "idle" };
    // Drop the PendingChannel row — this chat is now configured.
    await prisma.pendingChannel
      .delete({ where: { telegramChatId: BigInt(data.telegramChatId) } })
      .catch(() => {
        // Already deleted (race) — safe to ignore.
      });

    const subUrl = `${config.PUBLIC_BASE_URL}/c/${channel.slug}`;
    const titleEsc = mdEscape(channel.title);
    const kb = new InlineKeyboard()
      .url("Open subscribe URL", subUrl)
      .row()
      .text("My channels", "menu:channels")
      .text("Home", "menu:home");
    await ctx.reply(
      [
        `🚀 *${titleEsc} is live*`,
        ``,
        `*Pricing*`,
        `\`$${channel.priceUsd}\` for *${channel.durationDays} days*`,
        ``,
        `*Settlement*`,
        `SOL on Solana`,
        `\`${channel.settlementAddress}\``,
        ``,
        `*Subscribe URL*`,
        `${subUrl}`,
        ``,
        `Share that URL anywhere — bio, tweets, newsletters. I'll auto-grant access the moment a subscriber pays.`,
      ].join("\n"),
      {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      },
    );
  } catch (err) {
    log.error({ err }, "Channel create failed");
    ctx.session.setup = { step: "idle" };
    await ctx.reply("Couldn't create that channel — it may already be registered.");
  }
}

// Truncate a channel title for an inline button label (Telegram caps button text and
// long titles look broken). Keep it readable at a glance.
function shortTitle(t: string, max = 28): string {
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Confirm the user pressing a callback owns the target channel. Tells Telegram to flash
// an error toast and silently drops the action otherwise.
async function verifyOwnsChannel(ctx: Ctx, channelId: string) {
  const fromId = ctx.from?.id;
  if (!fromId) {
    await ctx.answerCallbackQuery({ text: "Cannot identify user.", show_alert: true });
    return null;
  }
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) {
    await ctx.answerCallbackQuery({ text: "Channel not found.", show_alert: true });
    return null;
  }
  const owner = await prisma.owner.findUnique({
    where: { telegramUserId: BigInt(fromId) },
  });
  if (!owner || channel.ownerId !== owner.id) {
    await ctx.answerCallbackQuery({ text: "Not your channel.", show_alert: true });
    return null;
  }
  return { channel, owner };
}

async function handleSubscribe(ctx: Ctx, slug: string) {
  const tgUserId = ctx.from?.id;
  if (!tgUserId) return;
  const channel = await prisma.channel.findUnique({ where: { slug } });
  if (!channel || !channel.active) {
    return ctx.reply("That subscription link is invalid or has been disabled.");
  }

  const subscriberId = BigInt(tgUserId);
  const existing = await prisma.subscription.findUnique({
    where: {
      channelId_subscriberTelegramUserId: {
        channelId: channel.id,
        subscriberTelegramUserId: subscriberId,
      },
    },
  });

  const now = new Date();
  const titleEsc = mdEscape(channel.title);
  if (existing?.expiresAt && existing.expiresAt > now) {
    const lines = [
      `*Already subscribed to ${titleEsc}*`,
      ``,
      `Active until *${fmtExpiry(existing.expiresAt)}*`,
    ];
    if (existing.lastInviteLink) {
      lines.push(``, `*Your join link*`, `${existing.lastInviteLink}`);
    }
    return ctx.reply(lines.join("\n"), {
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
    });
  }

  const displayName = [ctx.from?.first_name, ctx.from?.last_name]
    .filter(Boolean)
    .join(" ");
  const { payment } = await startSubscriptionFlow(channel, subscriberId, {
    username: ctx.from?.username,
    displayName: displayName || undefined,
  });
  // Pay button targets our redirect endpoint — the redirect re-checks subscription
  // state at click-time so stale buttons in chat history can't trigger double-pay.
  const payUrl = `${config.PUBLIC_BASE_URL}/pay/${payment.id}`;
  const kb = new InlineKeyboard().url("Pay with KIRAPAY", payUrl);
  const sent = await ctx.reply(
    [
      `*${titleEsc}*`,
      ``,
      `*Price*`,
      `\`$${channel.priceUsd}\` for *${channel.durationDays} days*`,
      ``,
      `*How it works*`,
      `• Pay any supported token on any chain via KIRAPAY`,
      `• The creator receives SOL on Solana automatically`,
      `• Once your payment confirms (~30s), I'll DM you a one-time join link`,
    ].join("\n"),
    { parse_mode: "Markdown", reply_markup: kb },
  );
  // Remember this message so we can delete it from chat after successful payment.
  await prisma.payment.update({
    where: { id: payment.id },
    data: { payMessageId: sent.message_id },
  });
}
