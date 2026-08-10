import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { Logger } from "../src/logger.js";
import { RealtimeTranscriptionSession } from "../src/voice/realtimeTranscriptionSession.js";

const servers: WebSocketServer[] = [];
const sessions: RealtimeTranscriptionSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.close();
  }
  for (const server of servers.splice(0)) {
    for (const client of server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("RealtimeTranscriptionSession", () => {
  it("enables transcription inside a realtime model session", async () => {
    const { server, endpoint } = await createServer();
    let requestPath = "";
    let sessionUpdate: Record<string, unknown> | null = null;

    server.once("connection", (socket, request) => {
      requestPath = request.url ?? "";
      socket.once("message", (data) => {
        sessionUpdate = JSON.parse(data.toString()) as Record<string, unknown>;
        socket.send(
          JSON.stringify({ type: "session.updated", session: { id: "test" } }),
        );
      });
    });

    const session = createSession(endpoint);
    await session.connect();

    expect(requestPath).toBe("/v1/realtime?model=gpt-realtime-2.1-mini");
    expect(sessionUpdate).toMatchObject({
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            transcription: { model: "gpt-live-transcribe" },
          },
        },
      },
    });
  });

  it("propagates a session configuration error without an unhandled rejection", async () => {
    const { server, endpoint } = await createServer();
    server.once("connection", (socket) => {
      socket.once("message", () => {
        socket.send(
          JSON.stringify({
            type: "error",
            error: { message: "transcription session rejected" },
          }),
        );
      });
    });

    const session = createSession(endpoint);
    session.appendAudio(Buffer.from([1, 2]));

    await expect(session.commitAudio()).rejects.toThrow(
      "transcription session rejected",
    );
  });
});

async function createServer(): Promise<{
  server: WebSocketServer;
  endpoint: string;
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    endpoint: `ws://127.0.0.1:${address.port}/v1/realtime`,
  };
}

function createSession(endpoint: string): RealtimeTranscriptionSession {
  const session = new RealtimeTranscriptionSession({
    apiKey: "test-key",
    sessionModel: "gpt-realtime-2.1-mini",
    transcriptionModel: "gpt-live-transcribe",
    safetyIdentifier: "test-user",
    logger: new Logger("error"),
    endpoint,
  });
  sessions.push(session);
  return session;
}
