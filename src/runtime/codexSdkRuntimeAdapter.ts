import {
  Codex,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
} from "@openai/codex-sdk";
import type { Logger } from "../logger.js";
import type {
  CodexInput,
  CodexProgressCallback,
  CodexRuntimeAdapter,
  CodexStatusResult,
  CodexTurnResult,
  ProgressSummarizer,
  SafeProgressEvent,
} from "../types.js";
import { REMINDER_OUTPUT_SCHEMA } from "../reminderProtocol.js";
import { sanitizeCommandForSummary } from "../commandSanitizer.js";
import { ProgressSummaryScheduler } from "../progressSummaryScheduler.js";
import { extractToolOutputImages } from "../toolOutputImages.js";

interface RuntimeOptions {
  logger: Logger;
  progressSummarizer?: ProgressSummarizer;
}

interface InternalSession {
  runtimeSessionId: string;
  thread: Thread;
  persistedThreadId: string | null;
}

export class CodexSdkRuntimeAdapter implements CodexRuntimeAdapter {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly logger: Logger;
  private readonly codex: Codex;
  private readonly progressSummarizer?: ProgressSummarizer;

  constructor(options: RuntimeOptions) {
    this.logger = options.logger;
    this.progressSummarizer = options.progressSummarizer;
    this.codex = new Codex();
  }

  async startSession(
    workdir: string,
    persistedThreadId?: string,
  ): Promise<{ sessionId: string }> {
    const threadOptions = {
      workingDirectory: workdir,
      skipGitRepoCheck: true,
      approvalPolicy: "never" as const,
      sandboxMode: "danger-full-access" as const,
    };
    const thread = persistedThreadId
      ? this.codex.resumeThread(persistedThreadId, threadOptions)
      : this.codex.startThread(threadOptions);
    const sessionId = this.extractSessionId();

    this.sessions.set(sessionId, {
      runtimeSessionId: sessionId,
      thread,
      persistedThreadId: persistedThreadId ?? thread.id ?? null,
    });

    this.logger.debug(
      persistedThreadId ? "Resumed Codex thread" : "Started Codex thread",
      {
        sessionId,
        persistedThreadId: persistedThreadId ?? null,
      },
    );

    return { sessionId };
  }

  async sendTurn(
    sessionId: string,
    input: CodexInput,
    onProgress?: CodexProgressCallback,
  ): Promise<CodexTurnResult> {
    const session = this.getSession(sessionId);
    const { events } = await session.thread.runStreamed(input, {
      outputSchema: REMINDER_OUTPUT_SCHEMA,
    });
    const items: ThreadItem[] = [];
    let finalResponse = "";
    const progressScheduler = onProgress
      ? new ProgressSummaryScheduler({
          scopeId: sessionId,
          summarizer: this.progressSummarizer,
          onProgress,
          logger: this.logger,
        })
      : null;

    try {
      for await (const event of events) {
        if (event.type === "turn.failed") {
          throw new Error(event.error.message);
        }
        if (event.type === "error") {
          throw new Error(event.message);
        }
        if (event.type === "item.completed") {
          items.push(event.item);
          if (event.item.type === "agent_message") {
            finalResponse = event.item.text;
          }
        }

        const progressEvent = describeProgressEvent(event);
        if (progressEvent && progressScheduler) {
          await progressScheduler.record(progressEvent);
        }
      }
    } finally {
      await progressScheduler?.close();
    }

    session.persistedThreadId = session.thread.id ?? session.persistedThreadId;
    const parsed = JSON.parse(finalResponse) as {
      reply: string;
      reminderActions: CodexTurnResult["reminderActions"];
      includeToolImages: boolean;
    };
    const extractedImages = extractToolOutputImages(
      items,
      parsed.includeToolImages,
    );
    return {
      text: parsed.reply,
      reminderActions: parsed.reminderActions,
      attachments: extractedImages.attachments,
      omittedAttachmentCount: extractedImages.omittedCount,
    };
  }

  getPersistentThreadId(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.persistedThreadId ?? null;
  }

  async getStatus(sessionId: string): Promise<CodexStatusResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false };
    }

    return { ok: true };
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.sessions.delete(sessionId);
  }

  private getSession(sessionId: string): InternalSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session;
  }

  private extractSessionId(): string {
    return `runtime-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function getUserFacingProgressText(item: ThreadItem): string | null {
  if (item.type !== "agent_message" || isStructuredFinalResponse(item.text)) {
    return null;
  }

  const text = item.text.trim();
  return text || null;
}

export function summarizeProgressEvent(event: ThreadEvent): string | null {
  return describeProgressEvent(event)?.fallbackText ?? null;
}

export function describeProgressEvent(
  event: ThreadEvent,
): SafeProgressEvent | null {
  if (event.type === "turn.started") {
    return progressEvent("turn", "started", "ご依頼内容を確認していますわ…");
  }

  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  ) {
    return null;
  }

  const item = event.item;
  switch (item.type) {
    case "agent_message": {
      const text =
        event.type === "item.completed"
          ? getUserFacingProgressText(item)
          : null;
      return text
        ? progressEvent(
            "agent_message",
            "completed",
            text,
            undefined,
            undefined,
            text,
          )
        : null;
    }
    case "reasoning":
      return null;
    case "command_execution": {
      const command = describeCommandExecution(item.command, item.status);
      return progressEvent(
        "command_execution",
        item.status,
        command.fallbackText,
        command.commandName,
        command.commandSummary,
      );
    }
    case "file_change": {
      const text =
        item.status === "failed"
          ? "ファイル変更の結果を確認し、別の方法を検討していますわ…"
          : "ファイルへの変更を反映しましたわ。";
      return progressEvent("file_change", item.status, text);
    }
    case "mcp_tool_call": {
      const text =
        item.status === "failed"
          ? "外部ツールの結果を確認し、別の方法を検討していますわ…"
          : item.status === "completed"
            ? "外部ツールで得た結果を確認していますわ…"
            : "外部ツールで必要な情報を確認していますわ…";
      return progressEvent("external_tool", item.status, text);
    }
    case "web_search": {
      const stage = event.type === "item.completed" ? "completed" : "started";
      const text =
        stage === "completed"
          ? "Web検索の結果を確認していますわ…"
          : "Web検索で情報を確認していますわ…";
      return progressEvent("web_search", stage, text);
    }
    case "todo_list": {
      const stage = event.type === "item.completed" ? "completed" : "updated";
      const text =
        stage === "completed"
          ? "作業手順に沿って処理を進めていますわ…"
          : "作業手順を整理していますわ…";
      return progressEvent("todo_list", stage, text);
    }
    case "error":
      return progressEvent(
        "error",
        "completed",
        "処理結果を確認し、次の方法を検討していますわ…",
      );
  }
}

type CommandExecutionStatus = "in_progress" | "completed" | "failed";

interface SafeCommandDescriptor {
  label: string;
  pattern: RegExp;
  activity: string;
}

const SAFE_COMMAND_DESCRIPTORS: SafeCommandDescriptor[] = [
  {
    label: "ripgrep",
    pattern: commandPattern("rg"),
    activity: "関連箇所を検索",
  },
  {
    label: "Get-Content",
    pattern: commandPattern("Get-Content"),
    activity: "ファイル内容を確認",
  },
  {
    label: "cat",
    pattern: commandPattern("cat"),
    activity: "ファイル内容を確認",
  },
  {
    label: "git",
    pattern: commandPattern("git"),
    activity: "変更内容を確認",
  },
  {
    label: "npm",
    pattern: commandPattern("npm"),
    activity: "プロジェクトを検証",
  },
  {
    label: "pnpm",
    pattern: commandPattern("pnpm"),
    activity: "プロジェクトを検証",
  },
  {
    label: "yarn",
    pattern: commandPattern("yarn"),
    activity: "プロジェクトを検証",
  },
  {
    label: "Vitest",
    pattern: commandPattern("vitest"),
    activity: "テストを実行",
  },
  {
    label: "TypeScript",
    pattern: commandPattern("tsc"),
    activity: "型検査を実行",
  },
  {
    label: "Gradle",
    pattern: commandPattern("gradle(?:w)?"),
    activity: "プロジェクトを検証",
  },
  {
    label: "Docker",
    pattern: commandPattern("docker"),
    activity: "実行環境を確認",
  },
  {
    label: "SSH",
    pattern: commandPattern("ssh"),
    activity: "リモート環境を確認",
  },
  {
    label: "curl",
    pattern: commandPattern("curl"),
    activity: "通信結果を確認",
  },
  {
    label: "systemctl",
    pattern: commandPattern("systemctl"),
    activity: "サービス状態を確認",
  },
  {
    label: "journalctl",
    pattern: commandPattern("journalctl"),
    activity: "ログを確認",
  },
];

function describeCommandExecution(
  command: string,
  status: CommandExecutionStatus,
): {
  commandName?: string;
  commandSummary: string;
  fallbackText: string;
} {
  const descriptor = SAFE_COMMAND_DESCRIPTORS.find(({ pattern }) =>
    pattern.test(command),
  );
  const commandName = descriptor?.label ?? "コマンド";

  if (status === "failed") {
    return {
      commandName: descriptor?.label,
      commandSummary: sanitizeCommandForSummary(command),
      fallbackText: `${commandName}の結果を確認し、別の方法を検討していますわ…`,
    };
  }
  if (status === "completed") {
    return {
      commandName: descriptor?.label,
      commandSummary: sanitizeCommandForSummary(command),
      fallbackText: `${commandName}の処理結果を確認していますわ…`,
    };
  }

  return {
    commandName: descriptor?.label,
    commandSummary: sanitizeCommandForSummary(command),
    fallbackText: descriptor
      ? `${commandName}で${descriptor.activity}していますわ…`
      : "コマンドで必要な処理を進めていますわ…",
  };
}

function progressEvent(
  kind: string,
  stage: string,
  fallbackText: string,
  commandName?: string,
  commandSummary?: string,
  directText?: string,
): SafeProgressEvent {
  return {
    kind,
    stage,
    fallbackText,
    commandName,
    commandSummary,
    directText,
  };
}

function commandPattern(namePattern: string): RegExp {
  return new RegExp(
    `(?:^|[\\s"';&|/\\\\])${namePattern}(?:\\.exe|\\.cmd)?(?=$|[\\s"';&|])`,
    "i",
  );
}

function isStructuredFinalResponse(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return (
      typeof parsed.reply === "string" &&
      Array.isArray(parsed.reminderActions) &&
      typeof parsed.includeToolImages === "boolean"
    );
  } catch {
    return false;
  }
}
