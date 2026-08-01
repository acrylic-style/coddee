import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ReminderAction, ReminderRecord } from "./types.js";

interface ApplyReminderActionsRequest {
  channelId: string;
  creatorUserId: string;
  actions: ReminderAction[];
  now?: Date;
}

interface ReminderActionResult {
  ok: boolean;
  text: string;
}

const DAILY_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ISO_WITH_TIME_ZONE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export class ReminderStore {
  private records: ReminderRecord[] = [];
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly inFlightMinutes = new Map<string, string>();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("Reminder data must be an array");
      }
      this.records = parsed as ReminderRecord[];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      this.records = [];
    }
  }

  listByChannel(channelId: string): ReminderRecord[] {
    return this.records
      .filter((record) => record.channelId === channelId)
      .map((record) => ({ ...record }));
  }

  async applyActions(
    request: ApplyReminderActionsRequest,
  ): Promise<ReminderActionResult[]> {
    return this.exclusive(async () => {
      const results: ReminderActionResult[] = [];
      const nowIso = (request.now ?? new Date()).toISOString();

      for (const action of request.actions) {
        switch (action.action) {
          case "create":
            results.push(this.create(request, action, nowIso));
            break;
          case "update":
            results.push(this.update(request.channelId, action, nowIso));
            break;
          case "delete":
            results.push(this.delete(request.channelId, action));
            break;
        }
      }

      if (request.actions.length > 0) {
        await this.save();
      }
      return results;
    });
  }

  async claimDue(now: Date, timeZone: string): Promise<ReminderRecord[]> {
    return this.exclusive(async () => {
      const localMinute = formatLocalMinute(now, timeZone);
      const localTime = localMinute.slice(-5);
      const due: ReminderRecord[] = [];

      for (const record of this.records) {
        const isDue =
          record.scheduleType === "daily"
            ? record.dailyTime === localTime &&
              record.lastTriggeredMinute !== localMinute &&
              !this.inFlightMinutes.has(record.id)
            : Boolean(record.runAt) &&
              Date.parse(record.runAt as string) <= now.getTime() &&
              record.lastTriggeredMinute === null &&
              !this.inFlightMinutes.has(record.id);

        if (!isDue) {
          continue;
        }

        this.inFlightMinutes.set(record.id, localMinute);
        due.push({ ...record });
      }

      return due;
    });
  }

  async completeDelivery(id: string, delivered: boolean): Promise<void> {
    await this.exclusive(async () => {
      const claimedMinute = this.inFlightMinutes.get(id);
      this.inFlightMinutes.delete(id);
      const index = this.records.findIndex((record) => record.id === id);
      if (index === -1) {
        return;
      }

      const record = this.records[index];
      if (delivered && record.scheduleType === "once") {
        this.records.splice(index, 1);
      } else if (delivered) {
        record.lastTriggeredMinute =
          claimedMinute ?? record.lastTriggeredMinute;
        record.updatedAt = new Date().toISOString();
      } else {
        return;
      }
      await this.save();
    });
  }

  private create(
    request: ApplyReminderActionsRequest,
    action: ReminderAction,
    nowIso: string,
  ): ReminderActionResult {
    const validationError = validateSchedule(action, true);
    if (validationError) {
      return { ok: false, text: validationError };
    }

    const id = this.createId();
    this.records.push({
      id,
      channelId: request.channelId,
      creatorUserId: request.creatorUserId,
      message: (action.message as string).trim(),
      scheduleType: action.scheduleType as "once" | "daily",
      dailyTime: action.scheduleType === "daily" ? action.dailyTime : null,
      runAt:
        action.scheduleType === "once"
          ? new Date(action.runAt as string).toISOString()
          : null,
      createdAt: nowIso,
      updatedAt: nowIso,
      lastTriggeredMinute: null,
    });
    return { ok: true, text: `リマインドを登録しました（ID: ${id}）。` };
  }

  private update(
    channelId: string,
    action: ReminderAction,
    nowIso: string,
  ): ReminderActionResult {
    const record = this.findInChannel(channelId, action.targetId);
    if (!record) {
      return {
        ok: false,
        text: `更新対象のリマインド（ID: ${action.targetId ?? "未指定"}）が見つかりません。`,
      };
    }

    let nextMessage: string | null = null;
    if (action.message !== null) {
      nextMessage = action.message.trim();
      if (!nextMessage) {
        return {
          ok: false,
          text: `リマインド ${record.id} の本文を空にはできません。`,
        };
      }
    }

    if (action.scheduleType !== null) {
      const validationError = validateSchedule(action, false);
      if (validationError) {
        return { ok: false, text: validationError };
      }
    } else if (action.dailyTime !== null || action.runAt !== null) {
      return {
        ok: false,
        text: `リマインド ${record.id} の時刻変更には scheduleType も必要です。`,
      };
    }

    if (nextMessage !== null) {
      record.message = nextMessage;
    }
    if (action.scheduleType !== null) {
      record.scheduleType = action.scheduleType;
      record.dailyTime =
        action.scheduleType === "daily" ? action.dailyTime : null;
      record.runAt =
        action.scheduleType === "once"
          ? new Date(action.runAt as string).toISOString()
          : null;
      record.lastTriggeredMinute = null;
    }

    record.updatedAt = nowIso;
    return { ok: true, text: `リマインド ${record.id} を更新しました。` };
  }

  private delete(
    channelId: string,
    action: ReminderAction,
  ): ReminderActionResult {
    const record = this.findInChannel(channelId, action.targetId);
    if (!record) {
      return {
        ok: false,
        text: `削除対象のリマインド（ID: ${action.targetId ?? "未指定"}）が見つかりません。`,
      };
    }

    this.records = this.records.filter((entry) => entry !== record);
    return { ok: true, text: `リマインド ${record.id} を削除しました。` };
  }

  private findInChannel(
    channelId: string,
    id: string | null,
  ): ReminderRecord | undefined {
    if (!id) {
      return undefined;
    }
    return this.records.find(
      (record) => record.channelId === channelId && record.id === id,
    );
  }

  private createId(): string {
    let id = randomUUID().replaceAll("-", "").slice(0, 8);
    while (this.records.some((record) => record.id === id)) {
      id = randomUUID().replaceAll("-", "").slice(0, 8);
    }
    return id;
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      JSON.stringify(this.records, null, 2),
      "utf8",
    );
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release: (() => void) | undefined;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

function validateSchedule(
  action: ReminderAction,
  requireMessage: boolean,
): string | null {
  if (requireMessage && !action.message?.trim()) {
    return "リマインドの本文が空です。";
  }
  if (!action.scheduleType) {
    return "リマインドの実行種別が指定されていません。";
  }
  if (action.scheduleType === "daily") {
    if (!action.dailyTime || !DAILY_TIME_PATTERN.test(action.dailyTime)) {
      return "毎日の実行時刻は HH:mm 形式で指定してください。";
    }
    return null;
  }
  if (
    !action.runAt ||
    !ISO_WITH_TIME_ZONE_PATTERN.test(action.runAt) ||
    Number.isNaN(Date.parse(action.runAt))
  ) {
    return "一回限りの実行日時はタイムゾーン付き ISO 8601 形式で指定してください。";
  }
  return null;
}

function formatLocalMinute(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}
