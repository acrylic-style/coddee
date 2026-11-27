import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { permittedReplyPath } from "./replyFiles.js";

export interface WebTurn {
  id: string;
  channelId: string;
  channelName: string;
  guildId: string | null;
  authorId: string;
  author: string;
  createdAt: number;
  prompt: string;
  reply: string;
  summary: string;
  discordUrl: string;
}

const DAY_MS = 86_400_000;
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
interface Share {
  name: string;
  expiresAt: number;
}

export function createWebStore(
  directory: string,
  workdir: string,
  now = Date.now,
) {
  const turns = path.join(directory, "turns");
  const shares = path.join(directory, "shares");
  const records = new Map<string, WebTurn>();

  async function writeJson(file: string, value: unknown) {
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify(value), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async function readShare(id: string): Promise<Share | undefined> {
    if (!uuidPattern.test(id)) return;
    try {
      return JSON.parse(
        await readFile(path.join(shares, id, "meta.json"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async function sweep() {
    for (const id of await readdir(shares)) {
      if (!uuidPattern.test(id)) continue;
      const meta = await readShare(id);
      if (!meta || meta.expiresAt <= now()) {
        await rm(path.join(shares, id), { recursive: true, force: true });
      }
    }
  }

  return {
    async load() {
      await mkdir(turns, { recursive: true, mode: 0o700 });
      await mkdir(shares, { recursive: true, mode: 0o700 });
      for (const name of await readdir(shares)) {
        if (name.startsWith(".") && uuidPattern.test(name.slice(1))) {
          await rm(path.join(shares, name), { recursive: true, force: true });
        }
      }
      for (const name of await readdir(turns)) {
        if (!/^\d{17,20}\.json$/u.test(name)) continue;
        const record: WebTurn = JSON.parse(
          await readFile(path.join(turns, name), "utf8"),
        );
        records.set(record.id, record);
      }
      await sweep();
    },
    sweep,
    async remember(record: WebTurn) {
      if (!/^\d{17,20}$/u.test(record.id))
        throw new Error("Invalid Discord message ID");
      await writeJson(path.join(turns, record.id + ".json"), record);
      records.set(record.id, record);
    },
    list() {
      return [...records.values()].sort(
        (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
      );
    },
    get(id: string) {
      return records.get(id);
    },
    async publish(requested: string, attachments: ReadonlyMap<string, string>) {
      const root = await realpath(workdir);
      const candidate = path.resolve(root, requested);
      const name = attachments.get(candidate);
      const file = await realpath(candidate);
      if (candidate !== file) throw new Error("Symbolic links are excluded");
      if (!name) {
        const privateRoot = await realpath(path.resolve(directory, ".."));
        const relativeToData = path.relative(privateRoot, file);
        const inData =
          relativeToData === "" ||
          (!path.isAbsolute(relativeToData) &&
            relativeToData.split(path.sep)[0] !== "..");
        if (inData || !permittedReplyPath(root, file))
          throw new Error("File outside the sharing scope");
      }

      const source = await open(
        file,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      const id = randomUUID();
      const staging = path.join(shares, "." + id);
      try {
        const stat = await source.stat();
        if (!stat.isFile() || stat.nlink !== 1)
          throw new Error("Unsupported file");
        if ((await realpath(candidate)) !== file)
          throw new Error("File moved outside the sharing scope");
        await mkdir(staging, { mode: 0o700 });
        await pipeline(
          source.createReadStream({ autoClose: false }),
          createWriteStream(path.join(staging, "file"), {
            flags: "wx",
            mode: 0o600,
          }),
        );
        const meta: Share = {
          name: name ?? path.basename(file),
          expiresAt: now() + DAY_MS,
        };
        await writeJson(path.join(staging, "meta.json"), meta);
        await rename(staging, path.join(shares, id));
      } finally {
        await source.close();
        await rm(staging, { recursive: true, force: true });
      }
      return id;
    },
    async download(id: string) {
      const meta = await readShare(id);
      if (!meta || meta.expiresAt <= now()) return;
      try {
        const file = await open(path.join(shares, id, "file"), "r");
        return {
          name: meta.name,
          stream: Readable.toWeb(
            file.createReadStream(),
          ) as ReadableStream<Uint8Array>,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

export type WebStore = ReturnType<typeof createWebStore>;
