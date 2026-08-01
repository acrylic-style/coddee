import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

export async function createCodexInput(
  prompt: string,
  attachments: Attachment[],
): Promise<{
  input: CodexInput;
  cleanup: () => Promise<void>;
  imageCount: number;
}> {
  const imageAttachments = attachments.filter(isImageAttachment);
  if (imageAttachments.length === 0) {
    return {
      input: prompt,
      cleanup: async () => {},
      imageCount: 0,
    };
  }

  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "discord-codex-bot-"),
  );
  const inputs: CodexUserInput[] = [];

  const text = prompt.trim() || "添付画像を分析してください。";
  inputs.push({
    type: "text",
    text,
  });

  for (const attachment of imageAttachments) {
    const response = await fetch(attachment.url);
    if (!response.ok) {
      throw new Error(
        `Failed to download attachment: ${attachment.url} (${response.status})`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const filename = `${randomUUID()}-${sanitizeFilename(attachment.name)}`;
    const filePath = path.join(tempDirectory, filename);
    await writeFile(filePath, Buffer.from(arrayBuffer));
    inputs.push({
      type: "local_image",
      path: filePath,
    });
  }

  return {
    input: inputs,
    cleanup: async () => {
      await rm(tempDirectory, { recursive: true, force: true });
    },
    imageCount: imageAttachments.length,
  };
}
