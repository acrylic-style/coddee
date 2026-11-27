import { readFile, stat } from "node:fs/promises";
import type { Message } from "discord.js";
import { afterEach, expect, it, vi } from "vitest";
import { createDiscordAttachmentTool } from "../src/discordAttachmentTool.js";

const messageId = "123456789012345678";
const files = [
  {
    id: "1",
    name: "report.zip",
    size: 3,
    url: "https://cdn.discordapp.com/report.zip",
  },
  {
    id: "2",
    name: "report.zip",
    size: 3,
    url: "https://cdn.discordapp.com/other.zip",
  },
];

function setup(allowed = true, attachments = files) {
  const fetchMessage = vi.fn().mockResolvedValue({
    attachments: new Map(attachments.map((file) => [file.id, file])),
  });
  const tool = createDiscordAttachmentTool({
    inGuild: () => true,
    channel: {
      messages: { fetch: fetchMessage },
      permissionsFor: () => ({ has: () => allowed }),
    },
  } as unknown as Message);
  return { tool, fetchMessage };
}

afterEach(() => vi.unstubAllGlobals());

it("lists matches and downloads only the selected attachment, then removes it", async () => {
  const { tool, fetchMessage } = setup();
  const bytes = Uint8Array.of(0, 255, 3);
  const download = vi.fn().mockResolvedValue(new Response(bytes));
  vi.stubGlobal("fetch", download);

  let localPath: string | undefined;
  try {
    expect(JSON.parse(await tool.call({ messageId }))).toEqual({
      messageId,
      attachments: files.map(({ id, name, size }) => ({ id, name, size })),
    });
    await expect(
      tool.call({ messageId, attachment: "report.zip" }),
    ).rejects.toThrow("同名");
    expect(download).not.toHaveBeenCalled();

    localPath = JSON.parse(
      await tool.call({ messageId, attachment: "2" }),
    ).path;
    expect(await readFile(localPath!)).toEqual(Buffer.from(bytes));
    expect(fetchMessage).toHaveBeenCalledWith({
      message: messageId,
      cache: false,
      force: true,
    });
    expect(download).toHaveBeenCalledExactlyOnceWith(
      files[1].url,
      expect.any(Object),
    );
  } finally {
    await tool.cleanup();
  }
  await expect(readFile(localPath!)).rejects.toMatchObject({ code: "ENOENT" });
});

it("requires history permission before fetching a message", async () => {
  const { tool, fetchMessage } = setup(false);
  await expect(tool.call({ messageId })).rejects.toThrow("権限");
  expect(fetchMessage).not.toHaveBeenCalled();
});

it("downloads files larger than 25 MiB", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  const size = 26 * chunk.length;
  const { tool } = setup(true, [{ ...files[0], size }]);
  const body = new ReadableStream({
    start(controller) {
      for (let sent = 0; sent < size; sent += chunk.length) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
  try {
    const result = JSON.parse(await tool.call({ messageId, attachment: "1" }));
    expect((await stat(result.path)).size).toBe(size);
  } finally {
    await tool.cleanup();
  }
});

it("allows 30 lookups per request and rejects the next one before fetching", async () => {
  const { tool, fetchMessage } = setup();
  for (let call = 0; call < 30; call++) {
    await tool.call({ messageId });
  }
  await expect(tool.call({ messageId })).rejects.toThrow("上限");
  expect(fetchMessage).toHaveBeenCalledTimes(30);
});
