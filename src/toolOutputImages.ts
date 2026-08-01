import { createHash } from "node:crypto";
import type { CodexOutputAttachment } from "./types.js";

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

interface ExtractionResult {
  attachments: CodexOutputAttachment[];
  omittedCount: number;
}

const EXTENSIONS: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function extractToolOutputImages(
  items: unknown[],
  enabled: boolean,
): ExtractionResult {
  if (!enabled) {
    return { attachments: [], omittedCount: 0 };
  }

  const attachments: CodexOutputAttachment[] = [];
  const hashes = new Set<string>();
  let omittedCount = 0;

  for (const block of findContentBlocks(items)) {
    const image = parseImageBlock(block);
    if (!image) {
      continue;
    }

    const extension = EXTENSIONS[image.mimeType];
    if (!extension || image.data.length > MAX_ATTACHMENT_BYTES) {
      omittedCount += 1;
      continue;
    }

    const hash = createHash("sha256").update(image.data).digest("hex");
    if (hashes.has(hash)) {
      continue;
    }
    hashes.add(hash);

    if (attachments.length >= MAX_ATTACHMENTS) {
      omittedCount += 1;
      continue;
    }

    attachments.push({
      data: image.data,
      name: `codex-image-${attachments.length + 1}.${extension}`,
    });
  }

  return { attachments, omittedCount };
}

function findContentBlocks(items: unknown[]): unknown[] {
  const blocks: unknown[] = [];
  for (const item of items) {
    if (!isRecord(item) || item.type !== "mcp_tool_call") {
      continue;
    }
    const result = item.result;
    if (!isRecord(result) || !Array.isArray(result.content)) {
      continue;
    }
    blocks.push(...result.content);
  }
  return blocks;
}

function parseImageBlock(
  block: unknown,
): { data: Buffer; mimeType: string } | null {
  if (!isRecord(block)) {
    return null;
  }

  if (
    block.type === "image" &&
    typeof block.data === "string" &&
    typeof block.mimeType === "string"
  ) {
    return decodeBase64(block.data, block.mimeType);
  }

  if (
    (block.type === "input_image" || block.type === "image_url") &&
    typeof block.image_url === "string"
  ) {
    return decodeDataUrl(block.image_url);
  }

  if (
    block.type === "image_url" &&
    isRecord(block.image_url) &&
    typeof block.image_url.url === "string"
  ) {
    return decodeDataUrl(block.image_url.url);
  }

  return null;
}

function decodeDataUrl(
  value: string,
): { data: Buffer; mimeType: string } | null {
  const match =
    /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/.exec(value);
  if (!match) {
    return null;
  }
  return decodeBase64(match[2], match[1].toLowerCase());
}

function decodeBase64(
  value: string,
  mimeType: string,
): { data: Buffer; mimeType: string } | null {
  try {
    const data = Buffer.from(value.replace(/\s+/g, ""), "base64");
    if (data.length === 0) {
      return null;
    }
    return { data, mimeType: mimeType.toLowerCase() };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
