import type { ThreadItem } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";
import {
  describeProgressEvent,
  getUserFacingProgressText,
  summarizeProgressEvent,
} from "../src/runtime/codexSdkRuntimeAdapter.js";

describe("getUserFacingProgressText", () => {
  it("returns only normal user-facing agent messages", () => {
    expect(
      getUserFacingProgressText({
        id: "message-1",
        type: "agent_message",
        text: "  関連箇所を確認しています。  ",
      }),
    ).toBe("関連箇所を確認しています。");
  });

  it("does not relay structured final responses", () => {
    expect(
      getUserFacingProgressText({
        id: "message-1",
        type: "agent_message",
        text: JSON.stringify({
          reply: "完了しました。",
          reminderActions: [],
          includeToolImages: false,
        }),
      }),
    ).toBeNull();
  });

  it("does not relay commands or tool output", () => {
    const command: ThreadItem = {
      id: "command-1",
      type: "command_execution",
      command: "npm test",
      aggregated_output: "21 tests passed",
      exit_code: 0,
      status: "completed",
    };

    expect(getUserFacingProgressText(command)).toBeNull();
  });
});

describe("summarizeProgressEvent", () => {
  it("starts every turn with a safe fixed message", () => {
    expect(summarizeProgressEvent({ type: "turn.started" })).toBe(
      "依頼内容を確認しています…",
    );
  });

  it("reports an allowlisted command name without its arguments", () => {
    const summary = summarizeProgressEvent({
      type: "item.started",
      item: {
        id: "command-1",
        type: "command_execution",
        command: 'pwsh -Command "rg -n super-secret-token C:/private/path.txt"',
        aggregated_output: "",
        status: "in_progress",
      },
    });

    expect(summary).toBe("ripgrepで関連箇所を検索しています…");
    expect(summary).not.toContain("super-secret-token");
    expect(summary).not.toContain("private");
  });

  it("uses a generic message for an unknown command", () => {
    expect(
      summarizeProgressEvent({
        type: "item.started",
        item: {
          id: "command-1",
          type: "command_execution",
          command: "private-secret-command --token sensitive-value",
          aggregated_output: "",
          status: "in_progress",
        },
      }),
    ).toBe("コマンドで必要な処理を進めています…");
  });

  it("preserves an SSH operation but removes its destination from model metadata", () => {
    const event = describeProgressEvent({
      type: "item.started",
      item: {
        id: "command-1",
        type: "command_execution",
        command: "ssh root@192.168.0.226 systemctl restart warp-svc",
        aggregated_output: "",
        status: "in_progress",
      },
    });

    expect(event?.commandName).toBe("SSH");
    expect(event?.commandSummary).toBe(
      "ssh <destination> systemctl restart warp-svc",
    );
    expect(event?.commandSummary).not.toContain("root");
    expect(event?.commandSummary).not.toContain("192.168.0.226");
  });

  it("summarizes event types without their arguments or output", () => {
    const summary = summarizeProgressEvent({
      type: "item.started",
      item: {
        id: "tool-1",
        type: "mcp_tool_call",
        server: "private-server",
        tool: "read_secret",
        arguments: { token: "sensitive-value" },
        status: "in_progress",
      },
    });

    expect(summary).toBe("外部ツールで必要な情報を確認しています…");
    expect(summary).not.toContain("private-server");
    expect(summary).not.toContain("sensitive-value");
  });

  it("never relays reasoning text", () => {
    expect(
      summarizeProgressEvent({
        type: "item.completed",
        item: {
          id: "reasoning-1",
          type: "reasoning",
          text: "secret reasoning",
        },
      }),
    ).toBeNull();
  });
});
