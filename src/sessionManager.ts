import type {
  CodexProgressCallback,
  CodexRuntimeAdapter,
  CodexTurnResult,
  PersistedSessionRecord,
  SessionState,
  TurnRequest,
} from "./types.js";
import { SessionPersistenceStore } from "./sessionPersistenceStore.js";

export class CodexSessionManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly persistedSessions: Record<string, PersistedSessionRecord>;

  constructor(
    private readonly runtime: CodexRuntimeAdapter,
    private readonly workdir: string,
    private readonly persistenceStore: SessionPersistenceStore,
    initialPersistedSessions: Record<string, PersistedSessionRecord>,
  ) {
    this.persistedSessions = { ...initialPersistedSessions };
  }

  getOrCreateState(sessionKey: string): SessionState {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return existing;
    }

    const created: SessionState = {
      sessionKey,
      sessionId: null,
      persistedThreadId: this.persistedSessions[sessionKey]?.threadId ?? null,
      busy: false,
      pendingTurns: [],
      currentWorkdir:
        this.persistedSessions[sessionKey]?.workdir ?? this.workdir,
      lastUsedAt: this.persistedSessions[sessionKey]?.lastUsedAt ?? Date.now(),
    };
    this.sessions.set(sessionKey, created);
    return created;
  }

  async enqueueTurn(
    sessionKey: string,
    turn: TurnRequest,
    onProgress?: CodexProgressCallback,
  ): Promise<CodexTurnResult> {
    const state = this.getOrCreateState(sessionKey);
    state.pendingTurns.push(turn);
    state.lastUsedAt = Date.now();
    return this.enqueueSequential(sessionKey, () =>
      this.runSpecificTurn(state, turn, onProgress),
    );
  }

  async resetSession(sessionKey: string): Promise<void> {
    await this.enqueueSequential(sessionKey, async () => {
      const state = this.sessions.get(sessionKey);
      if (!state) {
        return;
      }

      if (state.sessionId) {
        await this.runtime.closeSession(state.sessionId);
      }

      state.sessionId = null;
      state.persistedThreadId = null;
      state.busy = false;
      state.pendingTurns = [];
      state.lastUsedAt = Date.now();
      delete this.persistedSessions[sessionKey];
      await this.persistenceStore.saveAll(this.persistedSessions);
    });
  }

  async getStatus(sessionKey: string): Promise<{
    hasSession: boolean;
    busy: boolean;
    workdir: string;
    ok: boolean;
  }> {
    const state = this.sessions.get(sessionKey);
    if (!state) {
      return {
        hasSession: false,
        busy: false,
        workdir: this.workdir,
        ok: false,
      };
    }

    const ok = state.sessionId
      ? (await this.runtime.getStatus(state.sessionId)).ok
      : false;
    return {
      hasSession: Boolean(state.sessionId),
      busy: state.busy,
      workdir: state.currentWorkdir,
      ok,
    };
  }

  private async enqueueSequential<T>(
    sessionKey: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(sessionKey) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);

    this.queues.set(sessionKey, queued);

    await previous;
    try {
      return await task();
    } finally {
      if (release) {
        release();
      }
      if (this.queues.get(sessionKey) === queued) {
        this.queues.delete(sessionKey);
      }
    }
  }

  private async runSpecificTurn(
    state: SessionState,
    turn: TurnRequest,
    onProgress?: CodexProgressCallback,
  ): Promise<CodexTurnResult> {
    const queueIndex = state.pendingTurns.findIndex(
      (entry) => entry.messageId === turn.messageId,
    );
    if (queueIndex === -1) {
      return { text: "" };
    }

    state.busy = true;

    try {
      let startedFromPersistedThread = false;
      if (!state.sessionId) {
        const session = await this.runtime.startSession(
          state.currentWorkdir,
          state.persistedThreadId ?? undefined,
        );
        state.sessionId = session.sessionId;
        startedFromPersistedThread = Boolean(state.persistedThreadId);
      }

      let result;
      try {
        result = await this.runtime.sendTurn(
          state.sessionId,
          turn.input,
          onProgress,
          turn.approve,
          turn.protectedFetch,
          turn.messageHistory,
        );
      } catch (error) {
        if (
          !startedFromPersistedThread ||
          turn.approve ||
          turn.protectedFetch
        ) {
          throw error;
        }

        await this.runtime.closeSession(state.sessionId);
        state.sessionId = null;
        state.persistedThreadId = null;
        delete this.persistedSessions[state.sessionKey];
        await this.persistenceStore.saveAll(this.persistedSessions);

        const freshSession = await this.runtime.startSession(
          state.currentWorkdir,
        );
        state.sessionId = freshSession.sessionId;
        result = await this.runtime.sendTurn(
          state.sessionId,
          turn.input,
          onProgress,
          turn.approve,
          turn.protectedFetch,
          turn.messageHistory,
        );
      }

      const persistedThreadId = this.runtime.getPersistentThreadId(
        state.sessionId,
      );
      if (persistedThreadId) {
        state.persistedThreadId = persistedThreadId;
        this.persistedSessions[state.sessionKey] = {
          threadId: persistedThreadId,
          workdir: state.currentWorkdir,
          lastUsedAt: Date.now(),
        };
        await this.persistenceStore.saveAll(this.persistedSessions);
      }

      state.pendingTurns.splice(queueIndex, 1);
      state.lastUsedAt = Date.now();
      return result;
    } finally {
      state.busy = false;
    }
  }
}
