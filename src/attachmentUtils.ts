import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Attachment } from "discord.js";
import type { CodexInput, CodexUserInput } from "./types.js";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
]);

export function isImageAttachment(attachment: Attachment): boolean {
  if (attachment.contentType?.startsWith("image/")) {
    return true;
  }

  return IMAGE_EXTENSIONS.has(path.extname(attachment.name).toLowerCase());
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function downloadAttachment(
  attachment: Attachment,
  directory: string,
): Promise<string> {
  const response = await fetch(attachment.url, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download attachment: ${attachment.name} (${response.status})`,
    );
  }

  const filePath = path.join(
    directory,
    `${randomUUID()}-${sanitizeFilename(attachment.name)}`,
  );
  try {
    await pipeline(
      response.body,
      createWriteStream(filePath, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    await rm(filePath, { force: true });
    throw error;
  }
  return filePath;
}

export async function createCodexInput(
  prompt: string,
  attachments: Attachment[],
): Promise<{
  input: CodexInput;
  cleanup: () => Promise<void>;
  imageCount: number;
}> {
  if (attachments.length === 0) {
    return {
      input: prompt,
      cleanup: async () => {},
      imageCount: 0,
    };
  }

  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "discord-codex-bot-"),
  );
  const images: CodexUserInput[] = [];
  const filePaths: string[] = [];

  try {
    for (const attachment of attachments) {
      const filePath = await downloadAttachment(attachment, tempDirectory);

      if (isImageAttachment(attachment)) {
        images.push({ type: "local_image", path: filePath });
      } else {
        filePaths.push(filePath);
      }
    }
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }

  const defaultPrompt = filePaths.length
    ? "添付ファイルを確認してください。"
    : "添付画像を分析してください。";
  const text = prompt.trim() || defaultPrompt;
  const inputText = filePaths.length
    ? `${text}\n\n添付ファイルのローカルパス:\n${filePaths.join("\n")}`
    : text;

  return {
    input: [{ type: "text", text: inputText }, ...images],
    cleanup: async () => {
      await rm(tempDirectory, { recursive: true, force: true });
    },
    imageCount: images.length,
  };
}
