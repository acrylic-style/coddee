import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  VoiceMemoryStore,
  sanitizeMemoryText,
} from "../src/voice/voiceMemoryStore.js";

async function createStore(): Promise<{
  store: VoiceMemoryStore;
  filePath: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "voice-memory-"));
  const filePath = path.join(directory, "memory.json");
  const store = new VoiceMemoryStore(filePath);
  await store.load();
  return { store, filePath };
}

describe("VoiceMemoryStore", () => {
  it("persists character and recent turns across restarts", async () => {
    const { store, filePath } = await createStore();
    await store.setCharacter("vc-1", "落ち着いた執事");
    await store.appendTurn("vc-1", {
      speakerName: "Alice",
      userText: "紅茶が好き",
      assistantText: "覚えておきます",
    });

    const reopened = new VoiceMemoryStore(filePath);
    await reopened.load();
    expect(reopened.get("vc-1")).toMatchObject({
      character: "落ち着いた執事",
      recentTurns: [
        {
          speakerName: "Alice",
          userText: "紅茶が好き",
          assistantText: "覚えておきます",
        },
      ],
    });
  });

  it("summarizes a snapshot without dropping turns appended afterward", async () => {
    const { store } = await createStore();
    await store.appendTurn("vc-1", {
      speakerName: "Alice",
      userText: "最初",
      assistantText: "了解",
    });
    const snapshot = store.getSummarySnapshot("vc-1");
    await store.appendTurn("vc-1", {
      speakerName: "Bob",
      userText: "あとから追加",
      assistantText: "了解",
    });

    await expect(
      store.applySummary("vc-1", snapshot, "- Aliceとの最初の会話"),
    ).resolves.toBe(true);
    expect(store.get("vc-1")).toMatchObject({
      memorySummary: "- Aliceとの最初の会話",
      recentTurns: [{ speakerName: "Bob", userText: "あとから追加" }],
    });
  });

  it("resets memory while preserving the character", async () => {
    const { store } = await createStore();
    await store.setCharacter("vc-1", "猫のように話す");
    await store.appendTurn("vc-1", {
      speakerName: "Alice",
      userText: "記憶して",
      assistantText: "はい",
    });
    await store.resetMemory("vc-1");

    expect(store.get("vc-1")).toMatchObject({
      character: "猫のように話す",
      memorySummary: "",
      recentTurns: [],
    });
  });

  it("requests summarization after ten turns", async () => {
    const { store } = await createStore();
    for (let index = 0; index < 10; index += 1) {
      await store.appendTurn("vc-1", {
        speakerName: "Alice",
        userText: `発言${index}`,
        assistantText: "回答",
      });
    }
    expect(store.shouldSummarize("vc-1")).toBe(true);
  });

  it("redacts common secrets, URLs, and Windows paths", () => {
    expect(
      sanitizeMemoryText(
        "https://example.com C:\\secret\\file.txt sk-abcdefghijklmnop",
        1_000,
      ),
    ).toBe("[リンク省略] [ローカルパス省略] [認証情報省略]");
  });
});
