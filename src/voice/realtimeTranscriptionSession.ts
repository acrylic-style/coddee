import WebSocket, { type RawData } from "ws";
import type { Logger } from "../logger.js";

interface PendingTranscript {
  resolve(transcript: string): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export interface TranscriptionSessionOptions {
  apiKey: string;
  sessionModel: string;
  transcriptionModel: string;
  safetyIdentifier: string;
  logger: Logger;
  endpoint?: string;
}

interface RealtimeEvent {
  type: string;
  item_id?: string;
  transcript?: string;
  error?: { message?: string };
}

export class RealtimeTranscriptionSession {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private sendQueue: Promise<void> = Promise.resolve();
  private readonly awaitingCommit: PendingTranscript[] = [];
  private readonly pendingByItem = new Map<string, PendingTranscript>();

  constructor(private readonly options: TranscriptionSessionOptions) {}

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    const connection = new Promise<void>((resolve, reject) => {
      const endpoint = new URL(
        this.options.endpoint ?? "wss://api.openai.com/v1/realtime",
      );
      endpoint.searchParams.set("model", this.options.sessionModel);
      const socket = new WebSocket(endpoint, {
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "OpenAI-Safety-Identifier": this.options.safetyIdentifier,
        },
      });
      this.socket = socket;
      let settled = false;
      const resolveConnection = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const rejectConnection = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        rejectConnection(
          new Error("Realtime transcription connection timed out"),
        );
        socket.close();
      }, 15_000);

      socket.once("open", () => {
        try {
          this.send({
            type: "session.update",
            session: {
              type: "realtime",
              audio: {
                input: {
                  format: { type: "audio/pcm", rate: 24_000 },
                  noise_reduction: { type: "near_field" },
                  transcription: {
                    model: this.options.transcriptionModel,
                    language: "ja",
                  },
                  turn_detection: null,
                },
              },
            },
          });
        } catch (error) {
          rejectConnection(toError(error));
        }
      });
      socket.on("message", (data) => {
        const event = this.handleEvent(data);
        if (event?.type === "session.updated") {
          resolveConnection();
        } else if (event?.type === "error") {
          rejectConnection(
            new Error(event.error?.message ?? "Unknown Realtime API error"),
          );
          socket.close();
        }
      });
      socket.on("error", (error) => {
        this.options.logger.warn("Realtime transcription socket failed", {
          error: error.message,
        });
        rejectConnection(error);
      });
      socket.on("close", () => {
        const error = new Error("Realtime transcription connection closed");
        rejectConnection(error);
        if (this.socket === socket) {
          this.socket = null;
          this.connectPromise = null;
          this.rejectAll(error);
        }
      });
    });
    this.connectPromise = connection;
    void connection.catch(() => undefined);
    return connection;
  }

  appendAudio(audio: Buffer): void {
    if (audio.length === 0) {
      return;
    }
    const queued = this.sendQueue.then(async () => {
      await this.connect();
      this.send({
        type: "input_audio_buffer.append",
        audio: audio.toString("base64"),
      });
    });
    this.sendQueue = queued;
    void queued.catch(() => undefined);
  }

  async commitAudio(): Promise<string> {
    try {
      await this.sendQueue;
    } catch (error) {
      this.sendQueue = Promise.resolve();
      throw error;
    }
    await this.connect();
    return new Promise<string>((resolve, reject) => {
      const pending: PendingTranscript = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.removePending(pending);
          reject(new Error("Realtime transcription timed out"));
        }, 30_000),
      };
      this.awaitingCommit.push(pending);
      this.send({ type: "input_audio_buffer.commit" });
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.connectPromise = null;
    this.rejectAll(new Error("Realtime transcription session closed"));
  }

  private handleEvent(data: RawData): RealtimeEvent | null {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(data.toString()) as RealtimeEvent;
    } catch {
      return null;
    }

    if (event.type === "input_audio_buffer.committed" && event.item_id) {
      const pending = this.awaitingCommit.shift();
      if (pending) {
        this.pendingByItem.set(event.item_id, pending);
      }
      return event;
    }
    if (
      event.type === "conversation.item.input_audio_transcription.completed" &&
      event.item_id
    ) {
      const pending = this.pendingByItem.get(event.item_id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingByItem.delete(event.item_id);
        pending.resolve(event.transcript?.trim() ?? "");
      }
      return event;
    }
    if (event.type === "conversation.item.input_audio_transcription.failed") {
      this.rejectItem(
        event.item_id,
        new Error(event.error?.message ?? "Transcription failed"),
      );
      return event;
    }
    if (event.type === "error") {
      this.options.logger.warn("Realtime transcription API error", {
        error: event.error?.message ?? "Unknown Realtime API error",
      });
    }
    return event;
  }

  private send(event: object): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Realtime transcription socket is not open");
    }
    this.socket.send(JSON.stringify(event));
  }

  private rejectItem(itemId: string | undefined, error: Error): void {
    if (!itemId) {
      return;
    }
    const pending = this.pendingByItem.get(itemId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingByItem.delete(itemId);
    pending.reject(error);
  }

  private removePending(target: PendingTranscript): void {
    const index = this.awaitingCommit.indexOf(target);
    if (index >= 0) {
      this.awaitingCommit.splice(index, 1);
    }
    for (const [itemId, pending] of this.pendingByItem) {
      if (pending === target) {
        this.pendingByItem.delete(itemId);
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.awaitingCommit.splice(0)) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    for (const pending of this.pendingByItem.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingByItem.clear();
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
