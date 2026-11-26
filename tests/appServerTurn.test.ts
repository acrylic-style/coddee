import { PassThrough, Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import { appServerTurn } from "../src/runtime/appServerTurn.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("../src/runtime/codexCliPath.js", () => ({
  codexCliPath: () => "codex.js",
}));

it.each(["user", "auto_review"] as const)(
  "uses reviewer %s and routes client approval requests",
  async (reviewer) => {
    const threadId = "thread";
    const permissions = { fileSystem: { write: ["/outside/memory"] } };
    const requests = [
      {
        method: "item/permissions/requestApproval",
        params: { threadId, permissions },
      },
      {
        method: "item/permissions/requestApproval",
        params: { threadId, permissions },
      },
      {
        method: "item/fileChange/requestApproval",
        params: { threadId, itemId: "patch" },
      },
      {
        method: "applyPatchApproval",
        params: {
          conversationId: threadId,
          fileChanges: { "/outside/note": {} },
        },
      },
      {
        method: "execCommandApproval",
        params: { conversationId: threadId, command: ["pwd"] },
      },
    ];
    const stdout = new PassThrough();
    const responses: object[] = [];
    let threadParams: unknown;
    const emit = (event: object) => {
      queueMicrotask(() => stdout.write(JSON.stringify(event) + "\n"));
    };
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        const event = JSON.parse(chunk.toString());
        if (event.method === "initialize") emit({ id: 1, result: {} });
        if (event.method === "thread/start") {
          threadParams = event.params;
          emit({ id: 2, result: { thread: { id: threadId } } });
        }
        if (event.method === "turn/start") {
          requests.forEach((request, index) =>
            emit({ ...request, id: 100 + index }),
          );
        }
        if (event.id >= 100) {
          responses.push(event);
          if (responses.length === requests.length) {
            emit({
              method: "turn/completed",
              params: { turn: { status: "completed" } },
            });
          }
        }
        callback();
      },
    });
    spawn.mockReturnValue({ stdout, stdin, on: vi.fn(), kill: vi.fn() });
    const approve = vi
      .fn()
      .mockResolvedValue(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await Array.fromAsync(
      appServerTurn(process.cwd(), null, "test", approve, undefined, reviewer),
    );

    expect(threadParams).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: reviewer,
    });
    expect(approve).toHaveBeenCalledTimes(requests.length);
    expect(approve).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/outside/memory"),
    );
    expect(approve).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("patch"),
    );
    expect(approve).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("/outside/note"),
    );
    expect(approve).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining('["pwd"]'),
    );
    expect(responses).toEqual([
      { id: 100, result: { permissions, scope: "turn" } },
      { id: 101, result: { permissions: {}, scope: "turn" } },
      { id: 102, result: { decision: "accept" } },
      { id: 103, result: { decision: "approved" } },
      { id: 104, result: { decision: "approved" } },
    ]);
  },
);
