import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PersistedSessionRecord } from "./types.js";

type PersistedSessionMap = Record<string, PersistedSessionRecord>;

export class SessionPersistenceStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<PersistedSessionMap> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as PersistedSessionMap;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  async saveAll(records: PersistedSessionMap): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(records, null, 2), "utf8");
  }
}
