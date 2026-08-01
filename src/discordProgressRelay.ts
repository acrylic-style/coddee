import type { Message, MessageEditOptions } from "discord.js";

const DEFAULT_UPDATE_INTERVAL_MS = 1_500;

export class DiscordProgressRelay {
  private progressMessage: Promise<Message> | null = null;
  private lastPublishedText = "";
  private lastEditedAt = 0;
  private pendingText: string | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private editChain = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly sendInitial: (content: string) => Promise<Message>,
    private readonly updateIntervalMs = DEFAULT_UPDATE_INTERVAL_MS,
  ) {}

  async publish(text: string): Promise<void> {
    const normalized = normalizeProgressText(text);
    if (this.stopped || !normalized || normalized === this.lastPublishedText) {
      return;
    }

    this.lastPublishedText = normalized;
    if (!this.progressMessage) {
      this.progressMessage = this.sendInitial(normalized);
      await this.progressMessage;
      this.lastEditedAt = Date.now();
      return;
    }

    this.pendingText = normalized;
    const delay = Math.max(
      0,
      this.updateIntervalMs - (Date.now() - this.lastEditedAt),
    );
    if (delay === 0) {
      this.queuePendingEdit();
      return;
    }

    if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.queuePendingEdit();
      }, delay);
    }
  }

  async complete(options: string | MessageEditOptions): Promise<boolean> {
    this.stopPendingProgress();
    if (!this.progressMessage) {
      return false;
    }

    await this.editChain;
    const progressMessage = await this.progressMessage;
    await progressMessage.edit(options);
    return true;
  }

  private queuePendingEdit(): void {
    const text = this.pendingText;
    this.pendingText = null;
    if (!text || this.stopped || !this.progressMessage) {
      return;
    }

    const progressMessagePromise = this.progressMessage;
    this.editChain = this.editChain
      .then(async () => {
        if (this.stopped) {
          return;
        }
        const progressMessage = await progressMessagePromise;
        await progressMessage.edit(text);
        this.lastEditedAt = Date.now();
      })
      .catch(() => undefined);
  }

  private stopPendingProgress(): void {
    this.stopped = true;
    this.pendingText = null;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }
}

function normalizeProgressText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.length <= 2_000 ? trimmed : `${trimmed.slice(0, 1_997)}...`;
}
