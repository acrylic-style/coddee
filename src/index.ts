import { Client, GatewayIntentBits, Partials } from "discord.js";
import { createCodexInput, isImageAttachment } from "./attachmentUtils.js";
import { loadConfig } from "./config.js";
import {
  buildHelpMessage,
  splitDiscordMessage,
  stripBotMention,
} from "./discordMessageUtils.js";
import { DiscordProgressRelay } from "./discordProgressRelay.js";
import { Logger } from "./logger.js";
import { OpenAiProgressSummarizer } from "./openAiProgressSummarizer.js";
import {
  fetchRecentContext,
  prependContextToInput,
} from "./recentMessageContext.js";
import { CodexSdkRuntimeAdapter } from "./runtime/codexSdkRuntimeAdapter.js";
import { CodexSessionManager } from "./sessionManager.js";
import { SessionPersistenceStore } from "./sessionPersistenceStore.js";
import { prependReminderInstructions } from "./reminderProtocol.js";
import { ReminderStore } from "./reminderStore.js";

function startTypingIndicator(sendTyping: () => Promise<unknown>): () => void {
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    try {
      await sendTyping();
    } catch {
      return;
    }

    setTimeout(() => {
      void tick();
    }, 8000);
  };

  void tick();

  return () => {
    stopped = true;
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  const progressSummarizer = new OpenAiProgressSummarizer({
    apiKey: config.openAiApiKey,
    model: config.progressSummaryModel,
    logger,
  });
  const runtime = new CodexSdkRuntimeAdapter({
    logger,
    progressSummarizer,
  });
  const persistenceStore = new SessionPersistenceStore(
    "data/session-state.json",
  );
  const persistedSessions = await persistenceStore.load();
  const sessions = new CodexSessionManager(
    runtime,
    config.codexWorkdir,
    persistenceStore,
    persistedSessions,
  );
  const reminderStore = new ReminderStore("data/reminders.json");
  await reminderStore.load();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  client.once("clientReady", () => {
    logger.info("Discord bot ready", {
      botUserId: client.user?.id,
    });

    const checkReminders = async (): Promise<void> => {
      const due = await reminderStore.claimDue(
        new Date(),
        config.reminderTimeZone,
      );
      for (const reminder of due) {
        let delivered = false;
        try {
          const channel = await client.channels.fetch(reminder.channelId);
          if (!channel?.isTextBased() || !("send" in channel)) {
            throw new Error("Reminder channel is not sendable");
          }
          await channel.send(`⏰ ${reminder.message}`);
          delivered = true;
          logger.info("Delivered reminder", {
            reminderId: reminder.id,
            channelId: reminder.channelId,
          });
        } catch (error) {
          logger.error("Failed to deliver reminder", {
            reminderId: reminder.id,
            channelId: reminder.channelId,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          await reminderStore.completeDelivery(reminder.id, delivered);
        }
      }
    };

    void checkReminders().catch((error) => {
      logger.error("Reminder check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    setInterval(() => {
      void checkReminders().catch((error) => {
        logger.error("Reminder check failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 60_000);
  });

  client.on("messageCreate", async (message) => {
    if (message.author.bot || !client.user) {
      return;
    }

    if (!message.mentions.users.has(client.user.id)) {
      return;
    }

    const sessionKey = message.channelId;

    if (!config.allowedDiscordUserIds.has(message.author.id)) {
      await message.reply("この Bot の利用は許可ユーザーに限定されています。");
      return;
    }

    const content = stripBotMention(message.content, client.user.id);
    const attachments = [...message.attachments.values()];
    const hasImageAttachment = attachments.some(isImageAttachment);

    if (!content && !hasImageAttachment) {
      await message.reply(buildHelpMessage());
      return;
    }

    const normalized = content.trim();
    const lower = normalized.toLowerCase();

    if (lower === "reset") {
      await sessions.resetSession(sessionKey);
      await message.reply(
        "このチャンネルの Codex セッションをリセットしました。",
      );
      return;
    }

    if (lower === "status") {
      const status = await sessions.getStatus(sessionKey);
      await message.reply(
        [
          `state: ${status.busy ? "busy" : "idle"}`,
          `session: ${status.hasSession ? "present" : "none"}`,
          `codex: ${status.ok ? "ok" : "not-started"}`,
          `workdir: ${status.workdir}`,
        ].join("\n"),
      );
      return;
    }

    const startedAt = Date.now();
    logger.info("Starting Codex turn", {
      userId: message.author.id,
      channelId: message.channelId,
      messageId: message.id,
      attachmentCount: attachments.length,
    });

    const stopTyping = startTypingIndicator(() => message.channel.sendTyping());
    const progressRelay = new DiscordProgressRelay((content) =>
      message.reply(content),
    );
    let cleanupAttachments: (() => Promise<void>) | null = null;

    try {
      const recentContext = await fetchRecentContext(message);
      const codexInput = await createCodexInput(normalized, attachments);
      cleanupAttachments = codexInput.cleanup;
      const inputWithContext = prependContextToInput(
        codexInput.input,
        recentContext,
      );
      const inputWithReminders = prependReminderInstructions(
        inputWithContext,
        reminderStore.listByChannel(message.channelId),
        new Date(),
        config.reminderTimeZone,
      );

      const result = await sessions.enqueueTurn(
        sessionKey,
        {
          messageId: message.id,
          channelId: message.channelId,
          input: inputWithReminders,
          requestedAt: startedAt,
        },
        async (progress) => {
          try {
            await progressRelay.publish(progress.text);
          } catch (error) {
            logger.warn("Failed to relay Codex progress", {
              userId: message.author.id,
              channelId: message.channelId,
              messageId: message.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      );

      const actionResults = await reminderStore.applyActions({
        channelId: message.channelId,
        creatorUserId: message.author.id,
        actions: result.reminderActions ?? [],
      });
      const actionSummary = actionResults.map((entry) => entry.text).join("\n");
      const attachmentNotice =
        (result.omittedAttachmentCount ?? 0) > 0
          ? `サイズまたは添付数の制限により、${result.omittedAttachmentCount} 件の画像を添付できませんでした。`
          : "";
      const replyBody =
        [result.text.trim(), actionSummary, attachmentNotice]
          .filter(Boolean)
          .join("\n\n") || "Codex から空の応答が返りました。";
      const chunks = splitDiscordMessage(replyBody);
      for (const [index, chunk] of chunks.entries()) {
        if (index === 0 && result.attachments?.length) {
          const replyOptions = {
            content: chunk,
            files: result.attachments.map((attachment) => ({
              attachment: attachment.data,
              name: attachment.name,
            })),
          };
          const editedProgress = await progressRelay.complete(replyOptions);
          if (!editedProgress) {
            await message.reply(replyOptions);
          }
        } else if (index === 0) {
          const editedProgress = await progressRelay.complete(chunk);
          if (!editedProgress) {
            await message.reply(chunk);
          }
        } else {
          await message.reply(chunk);
        }
      }

      logger.info("Completed Codex turn", {
        userId: message.author.id,
        channelId: message.channelId,
        messageId: message.id,
        durationMs: Date.now() - startedAt,
        imageCount: codexInput.imageCount,
        outputAttachmentCount: result.attachments?.length ?? 0,
      });
    } catch (error) {
      logger.error("Codex turn failed", {
        userId: message.author.id,
        channelId: message.channelId,
        messageId: message.id,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });

      const errorMessage =
        "Codex の実行中にエラーが発生しました。少し待ってから再試行してください。";
      const editedProgress = await progressRelay.complete(errorMessage);
      if (!editedProgress) {
        await message.reply(errorMessage);
      }
    } finally {
      if (cleanupAttachments) {
        await cleanupAttachments();
      }
      stopTyping();
    }
  });

  await client.login(config.discordBotToken);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
