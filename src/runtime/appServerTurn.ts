import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import type { CodexApproval, CodexInput } from "../types.js";
import { REMINDER_OUTPUT_SCHEMA } from "../reminderProtocol.js";

export async function* appServerTurn(
  cwd: string,
  threadId: string | null,
  input: CodexInput,
  approve: CodexApproval,
): AsyncGenerator<ThreadEvent> {
  const sdkRequire = createRequire(
    fileURLToPath(import.meta.resolve("@openai/codex-sdk")),
  );
  const cli = path.join(
    path.dirname(sdkRequire.resolve("@openai/codex/package.json")),
    "bin",
    "codex.js",
  );
  const child = spawn(process.execPath, [cli, "app-server"], {
    cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let failure: Error | undefined;
  child.on("error", (error) => {
    failure = error;
  });
  child.stdin.on("error", (error) => {
    failure = error;
    child.kill();
  });
  const lines = createInterface({ input: child.stdout });
  const send = (value: object) =>
    child.stdin.write(JSON.stringify(value) + "\n");
  const request = (id: number, method: string, params: object) =>
    send({ id, method, params });
  try {
    request(1, "initialize", {
      clientInfo: { name: "coddee", version: "1.0" },
    });
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (event.method && event.id !== undefined) {
        const params = event.params ?? {};
        if (
          (event.method === "item/commandExecution/requestApproval" ||
            event.method === "item/fileChange/requestApproval") &&
          threadId &&
          params.threadId === threadId
        ) {
          const details = [
            params.command,
            params.cwd,
            params.grantRoot,
            params.reason,
          ]
            .filter((value) => typeof value === "string" && value.length)
            .join("\n");
          const accepted = details
            ? await approve(details).catch(() => false)
            : false;
          send({
            id: event.id,
            result: { decision: accepted ? "accept" : "decline" },
          });
        } else {
          send({
            id: event.id,
            error: { code: -32601, message: "Unsupported server request" },
          });
        }
        continue;
      }
      if (event.error) throw new Error(event.error.message);
      if (event.id === 1) {
        send({ method: "initialized" });
        request(2, threadId ? "thread/resume" : "thread/start", {
          ...(threadId ? { threadId } : {}),
          cwd,
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
        });
      } else if (event.id === 2) {
        threadId = event.result.thread.id;
        yield { type: "thread.started", thread_id: event.result.thread.id };
        request(3, "turn/start", {
          threadId,
          outputSchema: REMINDER_OUTPUT_SCHEMA,
          input:
            typeof input === "string"
              ? [{ type: "text", text: input }]
              : input.map((item) =>
                  item.type === "local_image"
                    ? { type: "localImage", path: item.path }
                    : item,
                ),
        });
      } else if (event.method === "turn/started") {
        yield { type: "turn.started" };
      } else if (
        event.method === "item/started" ||
        event.method === "item/completed"
      ) {
        const raw = event.params.item;
        let item: ThreadItem | undefined;
        if (raw.type === "agentMessage") {
          item = { id: raw.id, type: "agent_message", text: raw.text };
        } else if (raw.type === "commandExecution") {
          item = {
            id: raw.id,
            type: "command_execution",
            command: raw.command,
            aggregated_output: raw.aggregatedOutput ?? "",
            exit_code: raw.exitCode ?? undefined,
            status:
              raw.status === "inProgress"
                ? "in_progress"
                : raw.status === "completed"
                  ? "completed"
                  : "failed",
          };
        } else if (raw.type === "mcpToolCall") {
          item = {
            id: raw.id,
            type: "mcp_tool_call",
            server: raw.server,
            tool: raw.tool,
            arguments: raw.arguments,
            result: raw.result ?? undefined,
            error: raw.error ?? undefined,
            status:
              raw.status === "inProgress"
                ? "in_progress"
                : raw.status === "completed"
                  ? "completed"
                  : "failed",
          };
        }
        if (item)
          yield {
            type:
              event.method === "item/started"
                ? "item.started"
                : "item.completed",
            item,
          };
      } else if (event.method === "turn/completed") {
        const turn = event.params.turn;
        if (turn.status !== "completed")
          throw new Error(turn.error?.message ?? `Codex turn ${turn.status}`);
        return;
      }
    }
    throw (
      failure ?? new Error("Codex App Server exited before completing the turn")
    );
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
  }
}
