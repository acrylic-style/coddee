import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface MemoryNode {
  scope: string;
  parent: string | null;
  summary: string;
  detail: string;
}

export class ConversationMemory {
  private nodes: Record<string, MemoryNode> = {};
  private pending = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly global = false,
  ) {}

  async load(): Promise<void> {
    try {
      this.nodes = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async remember(scope: string, prompt: string, answer: string): Promise<void> {
    if (this.addTurn(scope, prompt, answer)) await this.save();
  }

  private addTurn(scope: string, prompt: string, answer: string): boolean {
    const detail = sanitizeMemoryText(answer, 2_000);
    const topic = sanitizeMemoryText(prompt, 2_000);
    if (!topic || !detail) return false;
    const parent = this.id([scope, topic]);
    this.nodes[parent] = {
      scope,
      parent: null,
      summary: topic.slice(0, 160),
      detail: topic,
    };
    this.nodes[this.id([parent, detail])] = {
      scope,
      parent,
      summary: detail.slice(0, 160),
      detail,
    };
    return true;
  }

  async clear(scope: string): Promise<void> {
    for (const [id, node] of Object.entries(this.nodes)) {
      if (node.scope === scope) delete this.nodes[id];
    }
    await this.save();
  }

  search(scope: string, query: string): string {
    const tokens = new Set(
      query
        .toLowerCase()
        .match(
          /[a-z0-9_-]{2,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu,
        ) ?? [],
    );
    return JSON.stringify(
      Object.entries(this.nodes)
        .filter(([, node]) => this.global || node.scope === scope)
        .map(([id, node]) => ({
          id,
          summary: node.summary,
          score: [...tokens].filter((token) =>
            node.detail.toLowerCase().includes(token),
          ).length,
        }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 4)
        .map(({ id, summary }) => ({ id, summary })),
    );
  }

  open(scope: string, id: string): string | null {
    if (!Object.hasOwn(this.nodes, id)) return null;
    const node = this.nodes[id];
    if (!this.global && node.scope !== scope) return null;
    const children = Object.entries(this.nodes)
      .filter(([, child]) => child.parent === id)
      .slice(-8)
      .map(([childId, child]) => ({ id: childId, summary: child.summary }));
    return JSON.stringify({ ...node, children });
  }

  private id(parts: string[]): string {
    return createHash("sha256")
      .update(JSON.stringify(parts))
      .digest("hex")
      .slice(0, 20);
  }

  private save(): Promise<void> {
    this.pending = this.pending
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(this.file + ".tmp", JSON.stringify(this.nodes), "utf8");
        await rename(this.file + ".tmp", this.file);
      });
    return this.pending;
  }
}

function sanitizeMemoryText(text: string, maxLength: number): string {
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
