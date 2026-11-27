import type { Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  createMessageHistory,
  prependContextToInput,
} from "../src/recentMessageContext.js";

it("fetches older messages across Discord pages using the request as the anchor", async () => {
  const entries = Array.from({ length: 105 }, (_, index) => ({
    id: String(105 - index),
    author: { username: "participant" },
    createdAt: new Date(0),
    content: String(105 - index),
    attachments: new Map(),
  }));
  const fetch = vi.fn(
    async ({ before, limit }) =>
      new Map(
        entries
          .filter(({ id }) => Number(id) < Number(before))
          .slice(0, limit)
          .map((entry) => [entry.id, entry]),
      ),
  );
  const read = createMessageHistory({
    id: "106",
    channel: { messages: { fetch } },
  } as unknown as Message);

  const result = JSON.parse(await read({ count: 10, offset: 103 }));
  expect(result.messages.map(({ id }: { id: string }) => id)).toEqual([
    "2",
    "1",
  ]);
  expect(fetch.mock.calls.map(([options]) => options)).toEqual([
    { before: "106", limit: 100, cache: false },
    { before: "6", limit: 13, cache: false },
  ]);
  await expect(read({ count: 51, offset: 0 })).rejects.toThrow(RangeError);
  expect(fetch).toHaveBeenCalledTimes(2);
});

describe("prependContextToInput", () => {
  it("prepends context to plain text input", () => {
    const result = prependContextToInput("hello", "recent context");
    expect(result).toBe("recent context\n\nCurrent user request:\nhello");
  });

  it("prepends context to the first text block when images are present", () => {
    const result = prependContextToInput(
      [
        { type: "text", text: "describe this" },
        { type: "local_image", path: "/tmp/image.png" },
      ],
      "recent context",
    );

    expect(result).toEqual([
      {
        type: "text",
        text: "recent context\n\nCurrent user request:\ndescribe this",
      },
      { type: "local_image", path: "/tmp/image.png" },
    ]);
  });
});
