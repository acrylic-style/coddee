import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChannelType, type Client } from "discord.js";
import { expect, it, vi } from "vitest";
import { createWebApp } from "../src/webServer.js";
import { createWebStore } from "../src/webStore.js";
import { wantsWebDownload } from "../src/reminderProtocol.js";

const config = {
  host: "localhost",
  port: 3000,
  baseUrl: "https://example.com",
  clientId: "id",
  clientSecret: "secret",
};

it("serves a stable file copy and rejects expired or private files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coddee-web-"));
  try {
    let time = 1;
    const data = path.join(root, "data", "web");
    const store = createWebStore(data, root, () => time);
    await store.load();
    const report = path.join(root, "日本語.txt");
    const attachment = path.join(root, "data", "download");
    await writeFile(report, "original");
    await writeFile(attachment, "attachment");
    await expect(store.publish(attachment, new Map())).rejects.toThrow();
    const attachmentId = await store.publish(
      attachment,
      new Map([[attachment, "sample.zip"]]),
    );
    const id = await store.publish(report, new Map());
    await rm(attachment);
    await writeFile(report, "updated");

    const reopened = createWebStore(data, root, () => time);
    await reopened.load();
    const app = createWebApp(config, reopened, {} as Client);
    const response = await app.request("/d/" + id);
    expect(response.headers.get("content-disposition")).toContain(
      "attachment;",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("original");
    expect(await (await app.request("/d/" + attachmentId)).text()).toBe(
      "attachment",
    );
    time += 86_400_000;
    expect((await app.request("/d/" + id)).status).toBe(404);
    await reopened.sweep();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("checks OAuth state and keeps private details behind login and channel authorization", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coddee-history-"));
  const userId = "123456789012345678";
  try {
    const store = createWebStore(path.join(root, "data", "web"), root);
    await store.load();
    const record = {
      id: userId,
      channelId: userId,
      channelName: "DM",
      guildId: null,
      authorId: userId,
      author: "name",
      createdAt: Date.now(),
      prompt: "prompt",
      reply: "<script>bad()</script>",
      summary: "summary",
      discordUrl: "https://discord.com/channels/@me/1/2",
    };
    await store.remember(record);
    const other = {
      ...record,
      id: "123456789012345679",
      authorId: "123456789012345680",
    };
    await store.remember(other);
    const guildEntry = {
      ...record,
      id: "123456789012345681",
      guildId: "123456789012345682",
    };
    await store.remember(guildEntry);
    let canRead = true;
    const fetchThreadMember = vi.fn().mockResolvedValue({});
    const channel = {
      type: ChannelType.PrivateThread,
      isDMBased: () => false,
      isThread: () => true,
      guild: {
        id: guildEntry.guildId,
        members: { fetch: vi.fn().mockResolvedValue({}) },
        roles: { fetch: vi.fn().mockResolvedValue({}) },
      },
      permissionsFor: () => ({
        has: (value: unknown) => Array.isArray(value) && canRead,
      }),
      members: { fetch: fetchThreadMember },
    };
    const client = { channels: { fetch: vi.fn().mockResolvedValue(channel) } };
    const app = createWebApp(config, store, client as unknown as Client);
    expect((await app.request("/turns/" + record.id)).status).toBe(302);
    expect(
      (await app.request("/auth/callback?state=wrong&code=code")).status,
    ).toBe(400);
    const login = await app.request("/login");
    const state = new URL(login.headers.get("location")!).searchParams.get(
      "state",
    );
    const loginCookie = login.headers.get("set-cookie")!.split(";")[0];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ access_token: "test" }))
        .mockResolvedValueOnce(Response.json({ id: userId })),
    );
    const callback = await app.request(
      "/auth/callback?state=" + state + "&code=code",
      { headers: { cookie: loginCookie } },
    );
    expect(callback.status).toBe(302);
    const cookie = callback.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-coddee-session="))!
      .split(";")[0];
    const response = await app.request("/turns/" + record.id, {
      headers: { cookie },
    });
    expect(await response.text()).toContain("&lt;script&gt;");
    expect(
      (await app.request("/turns/" + other.id, { headers: { cookie } })).status,
    ).toBe(404);
    const guildResponse = () =>
      app.request("/turns/" + guildEntry.id, { headers: { cookie } });
    expect((await guildResponse()).status).toBe(200);
    expect(fetchThreadMember).toHaveBeenCalledWith({
      member: userId,
      force: true,
    });
    fetchThreadMember.mockRejectedValueOnce(new Error("Not a member"));
    expect((await guildResponse()).status).toBe(404);
    canRead = false;
    expect((await guildResponse()).status).toBe(404);
  } finally {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});

it("requires a web sharing request in the current prompt", () => {
  expect(wantsWebDownload("レポートをWebでダウンロードできるようにして")).toBe(
    true,
  );
  expect(wantsWebDownload("過去5件の添付をダウンロードして")).toBe(false);
});
