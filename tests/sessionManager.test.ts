import { describe, expect, it } from "vitest";
import { CodexSessionManager } from "../src/sessionManager.js";
import { SessionPersistenceStore } from "../src/sessionPersistenceStore.js";
import type {
  CodexInput,
  CodexProgressCallback,
  CodexRuntimeAdapter,
} from "../src/types.js";

class FakeRuntime implements CodexRuntimeAdapter {
  public readonly prompts: CodexInput[] = [];
  public readonly closedSessionIds: string[] = [];
  private sessionCount = 0;
  private readonly persistentIds = new Map<string, string>();

  async startSession(
    _workdir: string,
    persistedThreadId?: string,
  ): Promise<{ sessionId: string }> {
    this.sessionCount += 1;
    const sessionId = `session-${this.sessionCount}`;
    this.persistentIds.set(
      sessionId,
      persistedThreadId ?? `thread-${this.sessionCount}`,
    );
    return { sessionId };
  }

  async sendTurn(
    sessionId: string,
    input: CodexInput,
    onProgress?: CodexProgressCallback,
  ): Promise<{ text: string }> {
    this.prompts.push(input);
    await onProgress?.({ text: "ユーザー向けの進捗" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const text = typeof input === "string" ? input : JSON.stringify(input);
    return { text: `reply:${text}` };
  }

  getPersistentThreadId(sessionId: string): string | null {
    return this.persistentIds.get(sessionId) ?? null;
  }

  async getStatus(sessionId: string): Promise<{ ok: boolean }> {
    return { ok: sessionId.startsWith("session-") };
  }

  async closeSession(sessionId: string): Promise<void> {
    this.closedSessionIds.push(sessionId);
  }
}

class InMemoryPersistenceStore extends SessionPersistenceStore {
  public records: Record<
    string,
    { threadId: string; workdir: string; lastUsedAt: number }
  > = {};

  constructor() {
    super("ignored.json");
  }

  override async load(): Promise<
    Record<string, { threadId: string; workdir: string; lastUsedAt: number }>
  > {
    return this.records;
  }

  override async saveAll(
    records: Record<
      string,
      { threadId: string; workdir: string; lastUsedAt: number }
    >,
  ): Promise<void> {
    this.records = { ...records };
  }
}

describe("CodexSessionManager", () => {
  it("serializes turns per channel", async () => {
    const runtime = new FakeRuntime();
    const store = new InMemoryPersistenceStore();
    const manager = new CodexSessionManager(runtime, "C:/workdir", store, {});

    const first = manager.enqueueTurn("channel-1", {
      messageId: "1",
      channelId: "a",
      input: "first",
      requestedAt: Date.now(),
    });
    const second = manager.enqueueTurn("channel-1", {
      messageId: "2",
      channelId: "a",
      input: "second",
      requestedAt: Date.now(),
    });

    await expect(first).resolves.toEqual({ text: "reply:first" });
    await expect(second).resolves.toEqual({ text: "reply:second" });
    expect(runtime.prompts).toEqual(["first", "second"]);
  });

  it("isolates sessions between channels", async () => {
    const runtime = new FakeRuntime();
    const store = new InMemoryPersistenceStore();
    const manager = new CodexSessionManager(runtime, "C:/workdir", store, {});

    await manager.enqueueTurn("channel-1", {
      messageId: "1",
      channelId: "a",
      input: "first",
      requestedAt: Date.now(),
    });
    await manager.enqueueTurn("channel-2", {
      messageId: "2",
      channelId: "b",
      input: "second",
      requestedAt: Date.now(),
    });

    expect(runtime.prompts).toEqual(["first", "second"]);
  });

  it("resets and recreates the session", async () => {
    const runtime = new FakeRuntime();
    const store = new InMemoryPersistenceStore();
    const manager = new CodexSessionManager(runtime, "C:/workdir", store, {});

    await manager.enqueueTurn("channel-1", {
      messageId: "1",
      channelId: "a",
      input: "first",
      requestedAt: Date.now(),
    });

    await manager.resetSession("channel-1");

    await manager.enqueueTurn("channel-1", {
      messageId: "2",
      channelId: "a",
      input: "second",
      requestedAt: Date.now(),
    });

    expect(runtime.closedSessionIds).toEqual(["session-1"]);
    expect(runtime.prompts).toEqual(["first", "second"]);
  });

  it("persists the resolved thread id after a turn", async () => {
    const runtime = new FakeRuntime();
    const store = new InMemoryPersistenceStore();
    const manager = new CodexSessionManager(runtime, "C:/workdir", store, {});

    await manager.enqueueTurn("channel-1", {
      messageId: "1",
      channelId: "a",
      input: "first",
      requestedAt: Date.now(),
    });

    expect(store.records["channel-1"]?.threadId).toBe("thread-1");
  });

  it("forwards user-facing progress from the runtime", async () => {
    const runtime = new FakeRuntime();
    const store = new InMemoryPersistenceStore();
    const manager = new CodexSessionManager(runtime, "C:/workdir", store, {});
    const progress: string[] = [];

    await manager.enqueueTurn(
      "channel-1",
      {
        messageId: "1",
        channelId: "a",
        input: "first",
        requestedAt: Date.now(),
      },
      (update) => {
        progress.push(update.text);
      },
    );

    expect(progress).toEqual(["ユーザー向けの進捗"]);
  });
});
