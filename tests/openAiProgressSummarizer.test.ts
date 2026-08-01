import { describe, expect, it, vi } from "vitest";
import { Logger } from "../src/logger.js";
import {
  OpenAiProgressSummarizer,
  validateModelSummary,
  type ProgressSummaryResponsesClient,
} from "../src/openAiProgressSummarizer.js";
import type { SafeProgressEvent } from "../src/types.js";

const commandEvent: SafeProgressEvent = {
  kind: "command_execution",
  stage: "in_progress",
  commandName: "ripgrep",
  commandSummary: "rg -n ProgressSummarizer src tests",
  fallbackText: "ripgrepで関連箇所を検索していますわ…",
};

function fakeClient(outputText: string): {
  client: ProgressSummaryResponsesClient;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn().mockResolvedValue({ output_text: outputText });
  return {
    client: { responses: { create } },
    create,
  };
}

describe("OpenAiProgressSummarizer", () => {
  it("sends the supplied sanitized event history to the model", async () => {
    const { client, create } = fakeClient(
      "ripgrepを用いて関連箇所を確認していますわ。",
    );
    const summarizer = new OpenAiProgressSummarizer({
      model: "test-model",
      logger: new Logger("error"),
      client,
    });

    await expect(
      summarizer.summarize("scope-1", [
        {
          kind: "turn",
          stage: "started",
          fallbackText: "ご依頼内容を確認していますわ…",
        },
        commandEvent,
      ]),
    ).resolves.toBe("ripgrepを用いて関連箇所を確認していますわ。");
    expect(create).toHaveBeenCalledOnce();
    const request = create.mock.calls[0]?.[0] as {
      input: string;
      tools: unknown[];
      tool_choice: string;
    };
    expect(JSON.parse(request.input)).toEqual({
      events: [
        {
          event: "turn",
          stage: "started",
          command: null,
          commandSummary: null,
        },
        {
          event: "command_execution",
          stage: "in_progress",
          command: "ripgrep",
          commandSummary: "rg -n ProgressSummarizer src tests",
        },
      ],
    });
    expect(request.tools).toEqual([]);
    expect(request.tool_choice).toBe("none");
  });

  it("falls back when model output may contain sensitive details", async () => {
    const { client } = fakeClient(
      "C:\\Users\\someone\\secret.txtを確認していますわ。",
    );
    const summarizer = new OpenAiProgressSummarizer({
      model: "test-model",
      logger: new Logger("error"),
      client,
    });

    await expect(summarizer.summarize("scope-1", [commandEvent])).resolves.toBe(
      commandEvent.fallbackText,
    );
  });

  it("uses fixed summaries when no API key or client is configured", async () => {
    const summarizer = new OpenAiProgressSummarizer({
      model: "test-model",
      logger: new Logger("error"),
    });

    await expect(summarizer.summarize("scope-1", [commandEvent])).resolves.toBe(
      commandEvent.fallbackText,
    );
  });

  it("does not throttle consecutive requests", async () => {
    const { client, create } = fakeClient("処理を確認していますわ。");
    const summarizer = new OpenAiProgressSummarizer({
      model: "test-model",
      logger: new Logger("error"),
      client,
    });

    await summarizer.summarize("scope-1", [commandEvent]);
    await summarizer.summarize("scope-1", [
      commandEvent,
      {
        kind: "web_search",
        stage: "started",
        fallbackText: "Web検索で情報を確認していますわ…",
      },
    ]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("limits model input to the fifteen most recent events", async () => {
    const { client, create } = fakeClient("直近の作業をまとめていますわ。");
    const summarizer = new OpenAiProgressSummarizer({
      model: "test-model",
      logger: new Logger("error"),
      client,
    });
    const events = Array.from({ length: 18 }, (_, index) => ({
      ...commandEvent,
      commandSummary: `rg task-${index}`,
    }));

    await summarizer.summarize("scope-1", events);

    const request = create.mock.calls[0]?.[0] as { input: string };
    const input = JSON.parse(request.input) as {
      events: Array<{ commandSummary: string }>;
    };
    expect(input.events).toHaveLength(15);
    expect(input.events[0]?.commandSummary).toBe("rg task-3");
    expect(input.events.at(-1)?.commandSummary).toBe("rg task-17");
  });
});

describe("validateModelSummary", () => {
  it("normalizes a short safe sentence", () => {
    expect(validateModelSummary("  結果を\n確認していますわ。 ")).toBe(
      "結果を 確認していますわ。",
    );
  });

  it("rejects URLs, IP addresses, paths, and mass mentions", () => {
    expect(
      validateModelSummary("https://example.comを確認中ですわ。"),
    ).toBeNull();
    expect(validateModelSummary("192.168.0.1を確認中ですわ。")).toBeNull();
    expect(validateModelSummary("/home/user/fileを確認中ですわ。")).toBeNull();
    expect(validateModelSummary("@everyone 確認中ですわ。")).toBeNull();
  });
});
