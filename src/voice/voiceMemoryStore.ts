import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface VoiceMemoryTurn {
  id: string;
  speakerName: string;
  userText: string;
  assistantText: string;
  createdAt: number;
}

export interface VoiceMemoryRecord {
  character: string;
  memorySummary: string;
  recentTurns: VoiceMemoryTurn[];
  generation: number;
  updatedAt: number;
}

export interface VoiceMemorySummarySnapshot {
  generation: number;
  memorySummary: string;
  recentTurns: VoiceMemoryTurn[];
}

type PersistedVoiceMemories = Record<string, VoiceMemoryRecord>;

const EMPTY_RECORD: VoiceMemoryRecord = {
  character: "",
  memorySummary: "",
  recentTurns: [],
  generation: 0,
  updatedAt: 0,
};

export class VoiceMemoryStore {
  private records: PersistedVoiceMemories = {};
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as PersistedVoiceMemories;
      this.records = Object.fromEntries(
        Object.entries(raw).map(([key, value]) => [
          key,
          normalizeRecord(value),
        ]),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.records = {};
        return;
      }
      throw error;
    }
  }

  get(key: string): VoiceMemoryRecord {
    return structuredClone(this.records[key] ?? EMPTY_RECORD);
  }

  async setCharacter(key: string, character: string): Promise<void> {
    const record = this.ensureRecord(key);
    record.character = character.trim().slice(0, 4_000);
    record.updatedAt = Date.now();
    await this.save();
  }

  async appendTurn(
    key: string,
    turn: Omit<VoiceMemoryTurn, "id" | "createdAt">,
  ): Promise<void> {
    const record = this.ensureRecord(key);
    record.recentTurns.push({
      id: randomUUID(),
      speakerName: sanitizeMemoryText(turn.speakerName, 100),
      userText: sanitizeMemoryText(turn.userText, 2_000),
      assistantText: sanitizeMemoryText(turn.assistantText, 2_000),
      createdAt: Date.now(),
    });
    record.updatedAt = Date.now();
    await this.save();
  }

  getSummarySnapshot(key: string): VoiceMemorySummarySnapshot {
    const record = this.get(key);
    return {
      generation: record.generation,
      memorySummary: record.memorySummary,
      recentTurns: record.recentTurns,
    };
  }

  async applySummary(
    key: string,
    snapshot: VoiceMemorySummarySnapshot,
    memorySummary: string,
  ): Promise<boolean> {
    const record = this.ensureRecord(key);
    if (record.generation !== snapshot.generation) {
      return false;
    }
    const lastSummarized = snapshot.recentTurns.at(-1);
    if (!lastSummarized) {
      return false;
    }
    const index = record.recentTurns.findIndex(
      (turn) => turn.id === lastSummarized.id,
    );
    if (index < 0) {
      return false;
    }
    record.memorySummary = sanitizeMemoryText(memorySummary, 6_000);
    record.recentTurns.splice(0, index + 1);
    record.updatedAt = Date.now();
    await this.save();
    return true;
  }

  async resetMemory(key: string): Promise<void> {
    const record = this.ensureRecord(key);
    record.memorySummary = "";
    record.recentTurns = [];
    record.generation += 1;
    record.updatedAt = Date.now();
    await this.save();
  }

  shouldSummarize(key: string): boolean {
    const turns = this.records[key]?.recentTurns ?? [];
    return (
      turns.length >= 10 ||
      turns.reduce(
        (total, turn) =>
          total + turn.userText.length + turn.assistantText.length,
        0,
      ) >= 12_000
    );
  }

  async flush(): Promise<void> {
    await this.saveQueue;
  }

  private ensureRecord(key: string): VoiceMemoryRecord {
    this.records[key] ??= structuredClone(EMPTY_RECORD);
    return this.records[key];
  }

  private save(): Promise<void> {
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        await writeFile(
          this.filePath,
          JSON.stringify(this.records, null, 2),
          "utf8",
        );
      });
    return this.saveQueue;
  }
}

export function sanitizeMemoryText(text: string, maxLength: number): string {
  return text
    .replace(/https?:\/\/\S+/giu, "[リンク省略]")
    .replace(/[A-Za-z]:\\[^\s]+/gu, "[ローカルパス省略]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|(?:ghp|github_pat)_[A-Za-z0-9_-]{16,})\b/gu,
      "[認証情報省略]",
    )
    .replace(/[^\S\r\n]+/gu, " ")
    .replace(/\r?\n\s*/gu, "\n")
    .trim()
    .slice(0, maxLength);
}

function normalizeRecord(value: unknown): VoiceMemoryRecord {
  if (!value || typeof value !== "object") {
    return structuredClone(EMPTY_RECORD);
  }
  const candidate = value as Partial<VoiceMemoryRecord>;
  const turns = Array.isArray(candidate.recentTurns)
    ? candidate.recentTurns
        .filter(
          (turn): turn is VoiceMemoryTurn =>
            Boolean(turn) &&
            (typeof turn.id === "string" || turn.id === undefined) &&
            typeof turn.speakerName === "string" &&
            typeof turn.userText === "string" &&
            typeof turn.assistantText === "string" &&
            typeof turn.createdAt === "number",
        )
        .map((turn) => ({ ...turn, id: turn.id || randomUUID() }))
    : [];
  return {
    character:
      typeof candidate.character === "string" ? candidate.character : "",
    memorySummary:
      typeof candidate.memorySummary === "string"
        ? candidate.memorySummary
        : "",
    recentTurns: turns,
    generation:
      typeof candidate.generation === "number" ? candidate.generation : 0,
    updatedAt:
      typeof candidate.updatedAt === "number" ? candidate.updatedAt : 0,
  };
}
