import OpenAI from "openai";
import type { Logger } from "./logger.js";
import type { ProgressSummarizer, SafeProgressEvent } from "./types.js";

const MAX_RECENT_EVENTS = 15;
const MAX_SUMMARY_LENGTH = 120;

interface ProgressSummaryResponse {
  output_text: string;
}

export interface ProgressSummaryResponsesClient {
  responses: {
    create(request: unknown): Promise<ProgressSummaryResponse>;
  };
}

interface OpenAiProgressSummarizerOptions {
  apiKey?: string;
  model: string;
  logger: Logger;
  client?: ProgressSummaryResponsesClient;
}

export class OpenAiProgressSummarizer implements ProgressSummarizer {
  private readonly client: ProgressSummaryResponsesClient | null;
  private readonly model: string;
  private readonly logger: Logger;

  constructor(options: OpenAiProgressSummarizerOptions) {
    this.client =
      options.client ??
      (options.apiKey
        ? (new OpenAI({
            apiKey: options.apiKey,
          }) as ProgressSummaryResponsesClient)
        : null);
    this.model = options.model;
    this.logger = options.logger;

    if (!this.client) {
      this.logger.warn(
        "OPENAI_API_KEY is not configured; using fixed progress summaries",
      );
    }
  }

  async summarize(
    scopeId: string,
    events: readonly SafeProgressEvent[],
  ): Promise<string> {
    const recentEvents = events.slice(-MAX_RECENT_EVENTS);
    const latestEvent = recentEvents.at(-1);
    if (!latestEvent) {
      return "ご依頼内容を確認していますわ…";
    }
    if (latestEvent.directText || !this.client) {
      return latestEvent.directText ?? latestEvent.fallbackText;
    }

    try {
      const response = await this.client.responses.create({
        model: this.model,
        instructions: [
          "You write one short Japanese progress update for a Discord user.",
          "Use an elegant polite feminine tone ending naturally with ですわ, ますわ, or ですの.",
          "Summarize the supplied recent events in chronological order, emphasizing the current work and meaningful progress.",
          "Command summaries were sanitized locally: use their safe operational details, but never infer, reconstruct, or expose anything represented by <redacted>, <destination>, <host>, <path>, or <url>.",
          "Never mention credentials, secrets, hidden targets, private paths, IDs, raw output, or reasoning.",
          "Return only one sentence of at most 80 Japanese characters, with no markdown.",
        ].join(" "),
        input: JSON.stringify({
          events: recentEvents.map((recentEvent) => ({
            event: recentEvent.kind,
            stage: recentEvent.stage,
            command: recentEvent.commandName ?? null,
            commandSummary: recentEvent.commandSummary ?? null,
          })),
        }),
        tools: [],
        tool_choice: "none",
        reasoning: { effort: "none" },
        text: { verbosity: "low" },
        max_output_tokens: 80,
        store: false,
      });
      const summary = validateModelSummary(response.output_text);
      if (!summary) {
        this.logger.warn("Progress summary model returned unsafe output", {
          scopeId,
        });
        return latestEvent.fallbackText;
      }

      return summary;
    } catch (error) {
      this.logger.warn("Progress summary model request failed", {
        model: this.model,
        scopeId,
        error: error instanceof Error ? error.message : String(error),
      });
      return latestEvent.fallbackText;
    }
  }
}

export function validateModelSummary(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > MAX_SUMMARY_LENGTH) {
    return null;
  }

  const unsafePatterns = [
    /https?:\/\//i,
    /(?:[A-Za-z]:\\|\/(?:home|Users|srv|etc|mnt|var|tmp)\/)/,
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
    /@(?:everyone|here)\b/i,
    /```/,
  ];
  return unsafePatterns.some((pattern) => pattern.test(normalized))
    ? null
    : normalized;
}
