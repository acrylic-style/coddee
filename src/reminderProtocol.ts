import type { CodexInput, ReminderRecord } from "./types.js";

export const REMINDER_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    reminderActions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "update", "delete"] },
          targetId: { type: ["string", "null"] },
          message: { type: ["string", "null"] },
          scheduleType: {
            type: ["string", "null"],
            enum: ["once", "daily", null],
          },
          dailyTime: { type: ["string", "null"] },
          runAt: { type: ["string", "null"] },
        },
        required: [
          "action",
          "targetId",
          "message",
          "scheduleType",
          "dailyTime",
          "runAt",
        ],
        additionalProperties: false,
      },
    },
    includeToolImages: { type: "boolean" },
  },
  required: ["reply", "reminderActions", "includeToolImages"],
  additionalProperties: false,
} as const;

export function prependReminderInstructions(
  input: CodexInput,
  reminders: ReminderRecord[],
  now: Date,
  timeZone: string,
): CodexInput {
  const reminderSummary =
    reminders.length === 0
      ? "(このチャンネルには登録済みリマインドはありません)"
      : JSON.stringify(
          reminders.map(({ id, message, scheduleType, dailyTime, runAt }) => ({
            id,
            message,
            scheduleType,
            dailyTime,
            runAt,
          })),
          null,
          2,
        );
  const instructions = [
    "Discord Bot の通常応答に加え、自然言語によるリマインド管理を支援してください。",
    "ユーザーがリマインドの作成・更新・削除を明確に依頼した場合だけ reminderActions を生成してください。",
    "一覧・確認だけなら reminderActions は空配列にし、下記の登録済み情報を reply で読みやすく回答してください。",
    "操作の成功を reply 内で断定しないでください。実際の成否と ID は Bot が操作後に追記します。",
    "曖昧で対象や時刻を一意に決められない場合は操作せず、reply で確認質問をしてください。",
    "create: targetId は null。message と scheduleType を指定します。",
    "update/delete: 下記一覧に存在する正確な targetId を指定します。update は変更しない値を null にします。",
    "daily は dailyTime を HH:mm で指定し runAt は null にします。",
    "once は runAt を UTC オフセット付き ISO 8601 で指定し dailyTime は null にします。",
    "ユーザーがツールで取得・生成した画像そのものの送信を明確に希望し、そのターンで適切な画像が返った場合だけ includeToolImages を true にしてください。それ以外は false にしてください。",
    `現在日時: ${now.toISOString()}`,
    `解釈するタイムゾーン: ${timeZone}`,
    "このチャンネルの登録済みリマインド:",
    reminderSummary,
    "---- end reminder instructions ----",
  ].join("\n");

  if (typeof input === "string") {
    return `${instructions}\n\n${input}`;
  }

  const [first, ...rest] = input;
  if (first?.type === "text") {
    return [
      { type: "text", text: `${instructions}\n\n${first.text}` },
      ...rest,
    ];
  }
  return [{ type: "text", text: instructions }, ...input];
}
