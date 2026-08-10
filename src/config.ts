import { existsSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import type { LogLevel } from "./logger.js";

dotenv.config();

export interface AppConfig {
  discordBotToken: string;
  discordClientId?: string;
  allowedDiscordUserIds: Set<string>;
  codexWorkdir: string;
  logLevel: LogLevel;
  reminderTimeZone: string;
  openAiApiKey?: string;
  progressSummaryModel: string;
  realtimeSessionModel: string;
  realtimeTranscriptionModel: string;
  voiceConversationModel: string;
  voicevoxBaseUrl: string;
  voicevoxSpeakerId: number;
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

function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

export function loadConfig(): AppConfig {
  const codexWorkdir = path.resolve(getRequiredEnv("CODEX_WORKDIR"));
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
    logLevel: parseLogLevel(process.env.LOG_LEVEL),
    reminderTimeZone,
    openAiApiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
    progressSummaryModel:
      process.env.PROGRESS_SUMMARY_MODEL?.trim() || "gpt-5.6-luna",
    realtimeSessionModel:
      process.env.REALTIME_SESSION_MODEL?.trim() || "gpt-realtime-2.1-mini",
    realtimeTranscriptionModel:
      process.env.REALTIME_TRANSCRIPTION_MODEL?.trim() || "gpt-live-transcribe",
    voiceConversationModel:
      process.env.VOICE_CONVERSATION_MODEL?.trim() || "gpt-5.6-luna",
    voicevoxBaseUrl:
      process.env.VOICEVOX_BASE_URL?.trim() || "http://127.0.0.1:50021",
    voicevoxSpeakerId: parseNonNegativeInteger(
      process.env.VOICEVOX_SPEAKER_ID,
      3,
      "VOICEVOX_SPEAKER_ID",
    ),
  };
}
