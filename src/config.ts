import { existsSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import type { LogLevel } from "./logger.js";
import type { CodexApprovalsReviewer } from "./types.js";

dotenv.config();

export interface AppConfig {
  discordBotToken: string;
  discordClientId?: string;
  allowedDiscordUserIds: Set<string>;
  codexWorkdir: string;
  codexApprovalsReviewer: CodexApprovalsReviewer;
  logLevel: LogLevel;
  reminderTimeZone: string;
  openAiApiKey?: string;
  progressSummaryModel: string;
  realtimeSessionModel: string;
  realtimeTranscriptionModel: string;
  meetingMinutesModel: string;
}

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseAllowedUserIds(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function parseLogLevel(value: string | undefined): LogLevel {
  switch (value?.trim().toLowerCase()) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return value.trim().toLowerCase() as LogLevel;
    default:
      return "info";
  }
}

export function loadConfig(): AppConfig {
  const codexWorkdir = path.resolve(getRequiredEnv("CODEX_WORKDIR"));
  const codexApprovalsReviewer =
    process.env.CODEX_APPROVALS_REVIEWER?.trim() || "user";
  if (
    codexApprovalsReviewer !== "user" &&
    codexApprovalsReviewer !== "auto_review"
  ) {
    throw new Error("CODEX_APPROVALS_REVIEWER must be user or auto_review");
  }
  const reminderTimeZone =
    process.env.REMINDER_TIME_ZONE?.trim() || "Asia/Tokyo";

  if (!existsSync(codexWorkdir)) {
    throw new Error(`CODEX_WORKDIR does not exist: ${codexWorkdir}`);
  }
  try {
    new Intl.DateTimeFormat("ja-JP", { timeZone: reminderTimeZone }).format();
  } catch {
    throw new Error(`Invalid REMINDER_TIME_ZONE: ${reminderTimeZone}`);
  }

  return {
    discordBotToken: getRequiredEnv("DISCORD_BOT_TOKEN"),
    discordClientId: process.env.DISCORD_CLIENT_ID?.trim() || undefined,
    allowedDiscordUserIds: parseAllowedUserIds(
      getRequiredEnv("ALLOWED_DISCORD_USER_IDS"),
    ),
    codexWorkdir,
    codexApprovalsReviewer,
    logLevel: parseLogLevel(process.env.LOG_LEVEL),
    reminderTimeZone,
    openAiApiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
    progressSummaryModel:
      process.env.PROGRESS_SUMMARY_MODEL?.trim() || "gpt-6.2-sol",
    realtimeSessionModel:
      process.env.REALTIME_SESSION_MODEL?.trim() || "gpt-realtime-2.1-mini",
    realtimeTranscriptionModel:
      process.env.REALTIME_TRANSCRIPTION_MODEL?.trim() || "gpt-live-transcribe",
    meetingMinutesModel:
      process.env.MEETING_MINUTES_MODEL?.trim() || "gpt-6-luna",
  };
}
