export type CodexUserInput =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "local_image";
      path: string;
    };

export type CodexInput = string | CodexUserInput[];
export type CodexApproval = (operation: string) => Promise<boolean>;
export type CodexApprovalsReviewer = "user" | "auto_review";
export type MessageHistory = (args: unknown) => Promise<string>;
export type DiscordAttachmentDownload = (args: unknown) => Promise<string>;

export type ProtectedFetch = (url: string) => Promise<string>;

export interface TurnRequest {
  messageId: string;
  channelId: string;
  input: CodexInput;
  requestedAt: number;
  approve?: CodexApproval;
  protectedFetch?: ProtectedFetch;
  messageHistory?: MessageHistory;
  discordAttachmentDownload?: DiscordAttachmentDownload;
}

export interface SessionState {
  sessionKey: string;
  sessionId: string | null;
  persistedThreadId: string | null;
  busy: boolean;
  pendingTurns: TurnRequest[];
  currentWorkdir: string;
  lastUsedAt: number;
}

export interface CodexTurnResult {
  conversationSummary?: string;
  webDownloadPaths?: string[];
  text: string;
  reminderActions?: ReminderAction[];
  attachments?: CodexOutputAttachment[];
  omittedAttachmentCount?: number;
}

export interface CodexOutputAttachment {
  data: Buffer;
  name: string;
}

export interface CodexStatusResult {
  ok: boolean;
}

export interface CodexProgressUpdate {
  text: string;
}

export type CodexProgressCallback = (
  update: CodexProgressUpdate,
) => void | Promise<void>;

export interface SafeProgressEvent {
  kind: string;
  stage: string;
  commandName?: string;
  commandSummary?: string;
  fallbackText: string;
  directText?: string;
}

export interface ProgressSummarizer {
  summarize(
    scopeId: string,
    events: readonly SafeProgressEvent[],
  ): Promise<string>;
}

export interface CodexRuntimeAdapter {
  startSession(
    workdir: string,
    persistedThreadId?: string,
  ): Promise<{ sessionId: string }>;
  sendTurn(
    sessionId: string,
    input: CodexInput,
    onProgress?: CodexProgressCallback,
    approve?: CodexApproval,
    protectedFetch?: ProtectedFetch,
    messageHistory?: MessageHistory,
    discordAttachmentDownload?: DiscordAttachmentDownload,
  ): Promise<CodexTurnResult>;
  getPersistentThreadId(sessionId: string): string | null;
  getStatus(sessionId: string): Promise<CodexStatusResult>;
  closeSession(sessionId: string): Promise<void>;
}

export interface PersistedSessionRecord {
  threadId: string;
  workdir: string;
  lastUsedAt: number;
}

export type ReminderScheduleType = "once" | "daily";

export interface ReminderAction {
  action: "create" | "update" | "delete";
  targetId: string | null;
  message: string | null;
  scheduleType: ReminderScheduleType | null;
  dailyTime: string | null;
  runAt: string | null;
}

export interface ReminderRecord {
  id: string;
  channelId: string;
  creatorUserId: string;
  message: string;
  scheduleType: ReminderScheduleType;
  dailyTime: string | null;
  runAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastTriggeredMinute: string | null;
}
