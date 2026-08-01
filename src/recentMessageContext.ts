import type { Attachment, Message } from "discord.js";
import type { CodexInput } from "./types.js";

const RECENT_MESSAGE_LIMIT = 10;
const CONTEXT_HEADER = [
  "以下はこのチャンネルの直近メッセージです。必要に応じて文脈として参照してください。",
  "---- recent discord context ----",
].join("\n");

function summarizeAttachments(attachments: Attachment[]): string {
  if (attachments.length === 0) {
    return "";
  }

  const names = attachments.map((attachment) => attachment.name).join(", ");
  return ` [attachments: ${names}]`;
}

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

function formatMessageLine(message: Message): string | null {
  const content = normalizeContent(message.content);
  const attachmentSummary = summarizeAttachments([
    ...message.attachments.values(),
  ]);

  if (!content && !attachmentSummary) {
    return null;
  }

  const author = message.author.username;
  const body = content || "(no text)";
  return `[${author}] ${body}${attachmentSummary}`;
}

export async function fetchRecentContext(message: Message): Promise<string> {
  const recentMessages = await message.channel.messages.fetch({
    limit: RECENT_MESSAGE_LIMIT,
    before: message.id,
  });

  const lines = [...recentMessages.values()]
    .reverse()
    .filter((entry) => !entry.system)
    .map(formatMessageLine)
    .filter((entry): entry is string => Boolean(entry));

  if (lines.length === 0) {
    return "";
  }

  return `${CONTEXT_HEADER}\n${lines.join("\n")}\n---- end recent discord context ----`;
}

export function prependContextToInput(
  input: CodexInput,
  context: string,
): CodexInput {
  if (!context.trim()) {
    return input;
  }

  if (typeof input === "string") {
    return `${context}\n\nCurrent user request:\n${input}`;
  }

  const [first, ...rest] = input;
  if (first?.type === "text") {
    return [
      {
        type: "text",
        text: `${context}\n\nCurrent user request:\n${first.text}`,
      },
      ...rest,
    ];
  }

  return [
    {
      type: "text",
      text: `${context}\n\nCurrent user request:\nPlease use the attached input and respond to the user's latest request.`,
    },
    ...input,
  ];
}
