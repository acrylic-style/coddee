import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../src/logger.js";
import { ProgressSummaryScheduler } from "../src/progressSummaryScheduler.js";
import type { ProgressSummarizer, SafeProgressEvent } from "../src/types.js";

const event = (index: number): SafeProgressEvent => ({
  kind: "command_execution",
  stage: "in_progress",
  commandName: "ripgrep",
  commandSummary: `rg task-${index}`,
  fallbackText: "検索しています…",
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ProgressSummaryScheduler", () => {
  it("checks every two seconds and summarizes only when events changed", async () => {
    vi.useFakeTimers();
    const summarize = vi.fn().mockResolvedValue("作業を要約しています。");
    const publish = vi.fn();
    const scheduler = createScheduler({ summarize }, publish);

    await scheduler.record(event(1));
    await scheduler.record(event(2));
    expect(summarize).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(summarize).toHaveBeenCalledOnce();
    expect(summarize.mock.calls[0]?.[1]).toHaveLength(2);
    expect(publish).toHaveBeenCalledWith({ text: "作業を要約しています。" });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(summarize).toHaveBeenCalledOnce();
    await scheduler.close();
  });

  it("uses the latest fifteen events for each refresh", async () => {
    vi.useFakeTimers();
    const summarize = vi.fn().mockResolvedValue("確認しています。");
    const scheduler = createScheduler({ summarize }, vi.fn());

    for (let index = 0; index < 18; index += 1) {
      await scheduler.record(event(index));
    }
    await vi.advanceTimersByTimeAsync(2_000);

    const events = summarize.mock.calls[0]?.[1] as SafeProgressEvent[];
    expect(events).toHaveLength(15);
    expect(events[0]?.commandSummary).toBe("rg task-3");
    expect(events.at(-1)?.commandSummary).toBe("rg task-17");
    await scheduler.close();
  });

  it("publishes the initial turn message immediately without an AI call", async () => {
    vi.useFakeTimers();
    const summarize = vi.fn().mockResolvedValue("未使用です。");
    const publish = vi.fn();
    const scheduler = createScheduler({ summarize }, publish);

    await scheduler.record({
      kind: "turn",
      stage: "started",
      fallbackText: "依頼内容を確認しています…",
    });

    expect(publish).toHaveBeenCalledWith({
      text: "依頼内容を確認しています…",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(summarize).not.toHaveBeenCalled();
    await scheduler.close();
  });
});

function createScheduler(
  summarizer: ProgressSummarizer,
  onProgress: ReturnType<typeof vi.fn>,
): ProgressSummaryScheduler {
  return new ProgressSummaryScheduler({
    scopeId: "scope-1",
    summarizer,
    onProgress,
    logger: new Logger("error"),
    checkIntervalMs: 2_000,
  });
}
