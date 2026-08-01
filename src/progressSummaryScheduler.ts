import type { Logger } from "./logger.js";
import type {
  CodexProgressCallback,
  ProgressSummarizer,
  SafeProgressEvent,
} from "./types.js";

const DEFAULT_CHECK_INTERVAL_MS = 2_000;
const MAX_RECENT_EVENTS = 15;

interface ProgressSummarySchedulerOptions {
  scopeId: string;
  summarizer?: ProgressSummarizer;
  onProgress: CodexProgressCallback;
  logger: Logger;
  checkIntervalMs?: number;
}

export class ProgressSummaryScheduler {
  private readonly events: SafeProgressEvent[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private eventVersion = 0;
  private summarizedVersion = 0;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly options: ProgressSummarySchedulerOptions) {
    this.timer = setInterval(
      () => this.checkForUpdates(),
      options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
    );
  }

  async record(event: SafeProgressEvent): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.events.push(event);
    if (this.events.length > MAX_RECENT_EVENTS) {
      this.events.splice(0, this.events.length - MAX_RECENT_EVENTS);
    }
    this.eventVersion += 1;

    if (
      (event.kind === "turn" && event.stage === "started") ||
      event.directText
    ) {
      await this.publish(event.directText ?? event.fallbackText);
      this.summarizedVersion = this.eventVersion;
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.inFlight;
  }

  private checkForUpdates(): void {
    if (
      this.stopped ||
      this.inFlight ||
      this.eventVersion === this.summarizedVersion
    ) {
      return;
    }

    const targetVersion = this.eventVersion;
    const events = [...this.events];
    this.inFlight = this.generateAndPublish(events)
      .then(() => {
        this.summarizedVersion = targetVersion;
      })
      .catch((error) => {
        this.options.logger.warn("Progress summary update failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.inFlight = null;
      });
  }

  private async generateAndPublish(
    events: readonly SafeProgressEvent[],
  ): Promise<void> {
    const latestEvent = events.at(-1);
    if (!latestEvent) {
      return;
    }
    const text = this.options.summarizer
      ? await this.options.summarizer.summarize(this.options.scopeId, events)
      : (latestEvent.directText ?? latestEvent.fallbackText);
    await this.publish(text);
  }

  private async publish(text: string): Promise<void> {
    try {
      await this.options.onProgress({ text });
    } catch (error) {
      this.options.logger.warn("Progress relay callback failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
