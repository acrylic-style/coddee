import { describe, expect, it } from "vitest";
import {
  extractCodexWakeWord,
  shouldHandleVoiceTranscript,
} from "../src/voice/wakeWord.js";

describe("voice wake word", () => {
  it("accepts the configured wake-word spellings", () => {
    expect(extractCodexWakeWord("アレクサ、今日の天気を調べて")).toEqual({
      matched: true,
      prompt: "今日の天気を調べて",
    });
    expect(extractCodexWakeWord("ねえ、あれくさ テストして")).toEqual({
      matched: true,
      prompt: "テストして",
    });
  });

  it("requires the wake word when multiple humans are present", () => {
    expect(shouldHandleVoiceTranscript("今日の天気は？", 2).matched).toBe(
      false,
    );
    expect(shouldHandleVoiceTranscript("アレックス 今日の天気は？", 2)).toEqual(
      {
        matched: true,
        prompt: "今日の天気は？",
      },
    );
  });

  it("accepts ordinary speech when only one human is present", () => {
    expect(shouldHandleVoiceTranscript("今日の天気は？", 1)).toEqual({
      matched: true,
      prompt: "今日の天気は？",
    });
  });
});
