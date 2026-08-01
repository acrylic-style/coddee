import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReminderStore } from "../src/reminderStore.js";
import type { ReminderAction } from "../src/types.js";

const temporaryDirectories: string[] = [];

async function createStore(): Promise<{
  store: ReminderStore;
  filePath: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coddee-reminders-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "reminders.json");
  const store = new ReminderStore(filePath);
  await store.load();
  return { store, filePath };
}

function action(overrides: Partial<ReminderAction> = {}): ReminderAction {
  return {
    action: "create",
    targetId: null,
    message: "朝会",
    scheduleType: "daily",
    dailyTime: "09:00",
    runAt: null,
    ...overrides,
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("ReminderStore", () => {
  it("creates, updates, and deletes reminders only in the requested channel", async () => {
    const { store } = await createStore();
    const created = await store.applyActions({
      channelId: "channel-1",
      creatorUserId: "user-1",
      actions: [action()],
    });
    expect(created[0]?.ok).toBe(true);

    const id = store.listByChannel("channel-1")[0]?.id;
    expect(id).toBeTruthy();
    await store.applyActions({
      channelId: "channel-1",
      creatorUserId: "user-1",
      actions: [
        action({
          action: "update",
          targetId: id ?? null,
          message: "夕会",
          dailyTime: null,
          scheduleType: null,
        }),
      ],
    });
    expect(store.listByChannel("channel-1")[0]?.message).toBe("夕会");

    const invalidUpdate = await store.applyActions({
      channelId: "channel-1",
      creatorUserId: "user-1",
      actions: [
        action({
          action: "update",
          targetId: id ?? null,
          message: "変更されない本文",
          dailyTime: "99:99",
        }),
      ],
    });
    expect(invalidUpdate[0]?.ok).toBe(false);
    expect(store.listByChannel("channel-1")[0]?.message).toBe("夕会");

    const crossChannelDelete = await store.applyActions({
      channelId: "channel-2",
      creatorUserId: "user-1",
      actions: [
        action({
          action: "delete",
          targetId: id ?? null,
          message: null,
          scheduleType: null,
          dailyTime: null,
        }),
      ],
    });
    expect(crossChannelDelete[0]?.ok).toBe(false);
    expect(store.listByChannel("channel-1")).toHaveLength(1);

    await store.applyActions({
      channelId: "channel-1",
      creatorUserId: "user-1",
      actions: [
        action({
          action: "delete",
          targetId: id ?? null,
          message: null,
          scheduleType: null,
          dailyTime: null,
        }),
      ],
    });
    expect(store.listByChannel("channel-1")).toHaveLength(0);
  });

  it("claims a daily reminder once per local minute", async () => {
    const { store } = await createStore();
    await store.applyActions({
      channelId: "channel-1",
      creatorUserId: "user-1",
      actions: [action()],
    });

    const now = new Date("2026-07-30T00:00:15.000Z");
    const firstDue = await store.claimDue(now, "Asia/Tokyo");
    expect(firstDue).toHaveLength(1);
    await expect(
      store.claimDue(new Date("2026-07-30T00:00:45.000Z"), "Asia/Tokyo"),
    ).resolves.toHaveLength(0);
    await store.completeDelivery(firstDue[0]!.id, true);
    await expect(
      store.claimDue(new Date("2026-07-31T00:00:15.000Z"), "Asia/Tokyo"),
    ).resolves.toHaveLength(1);
  });

  it("removes a one-time reminder after successful delivery and persists it", async () => {
    const { store, filePath } = await createStore();
    await store.applyActions({
      channelId: "channel-1",
      creatorUserId: "user-1",
      actions: [
        action({
          scheduleType: "once",
          dailyTime: null,
          runAt: "2026-07-30T10:00:00+09:00",
        }),
      ],
    });

    const due = await store.claimDue(
      new Date("2026-07-30T01:00:30.000Z"),
      "Asia/Tokyo",
    );
    expect(due).toHaveLength(1);
    await store.completeDelivery(due[0]!.id, true);
    expect(store.listByChannel("channel-1")).toHaveLength(0);
    await expect(readFile(filePath, "utf8")).resolves.toBe("[]");
  });

  it("releases a failed delivery for retry", async () => {
    const { store } = await createStore();
    await store.applyActions({
      channelId: "channel-1",
      creatorUserId: "user-1",
      actions: [action()],
    });

    const now = new Date("2026-07-30T00:00:15.000Z");
    const due = await store.claimDue(now, "Asia/Tokyo");
    await store.completeDelivery(due[0]!.id, false);
    await expect(store.claimDue(now, "Asia/Tokyo")).resolves.toHaveLength(1);
  });
});
