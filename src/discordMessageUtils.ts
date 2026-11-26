const DISCORD_LIMIT = 2000;
const SAFE_LIMIT = 1900;

export function stripBotMention(content: string, botUserId: string): string {
  const mentionPatterns = [
    new RegExp(`<@${botUserId}>`, "g"),
    new RegExp(`<@!${botUserId}>`, "g"),
  ];

  let sanitized = content;
  for (const pattern of mentionPatterns) {
    sanitized = sanitized.replace(pattern, " ");
  }

  return sanitized.trim();
}

export function splitDiscordMessage(
  content: string,
  limit = SAFE_LIMIT,
): string[] {
  if (content.length <= limit) {
    return [content];
  }

  const chunks: string[] = [];
  let remaining = content.trim();

  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit);
    const breakIndex = Math.max(
      candidate.lastIndexOf("\n"),
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf(" "),
    );
    const end = breakIndex > Math.floor(limit * 0.5) ? breakIndex + 1 : limit;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [content.slice(0, DISCORD_LIMIT)];
}

export function buildHelpMessage(): string {
  return [
    "使い方:",
    "- `@bot <prompt>` で Codex に質問",
    "- `@bot status` で状態確認",
    "- `@bot reset` で会話リセット",
    "- `@bot voice join` で議事録を開始し、`@bot voice leave` で終了",
    "- 自然な文章でリマインドの作成・一覧・変更・削除",
  ].join("\n");
}
