import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import type { Message } from "discord.js";
import { expect, it, vi } from "vitest";
import { DiscordVoiceController } from "../src/voice/discordVoiceController.js";

const mocks = vi.hoisted(() => ({
  join: vi.fn(),
  commit: vi.fn<() => Promise<string>>(),
  summarize: vi.fn(),
}));

vi.mock("@discordjs/voice", () => ({
  EndBehaviorType: { AfterSilence: "silence" },
  VoiceConnectionStatus: {
    Ready: "ready",
    Disconnected: "disconnected",
    Destroyed: "destroyed",
  },
  entersState: vi.fn(),
  joinVoiceChannel: mocks.join,
}));

vi.mock("prism-media", () => ({
  default: { opus: { Decoder: PassThrough } },
}));

vi.mock("../src/voice/realtimeTranscriptionSession.js", () => ({
  RealtimeTranscriptionSession: class {
    appendAudio = vi.fn();
    commitAudio = mocks.commit;
    close = vi.fn();
  },
}));

vi.mock("openai", () => ({
  default: class {
    responses = { create: mocks.summarize };
  },
}));

it("includes another participant's final speech and posts only to the starting channel", async () => {
  const speaking = new EventEmitter();
  const opus = new PassThrough();
  const connection = Object.assign(new EventEmitter(), {
    state: { status: "ready" },
    receiver: { speaking, subscribe: vi.fn(() => opus) },
    destroy: vi.fn(),
  });
  mocks.join.mockReturnValue(connection);
  let completeTranscript!: (text: string) => void;
  mocks.commit.mockImplementation(
    () =>
      new Promise((resolve) => {
        completeTranscript = resolve;
      }),
  );
  mocks.summarize.mockResolvedValue({
    status: "completed",
    output_text: "## 決定事項\n来週公開する。",
  });
  const guild = { id: "guild" };
  const voiceChannel = {
    id: "voice",
    guild,
    name: "会議",
    send: vi.fn(),
    members: new Map([
      ["guest", { displayName: "花子", user: { bot: false } }],
    ]),
  };
  const output = { isSendable: () => true, send: vi.fn() };
  const start = {
    guild,
    guildId: guild.id,
    member: { voice: { channel: voiceChannel } },
    author: { id: "host" },
    channel: output,
    channelId: "output",
    reply: vi.fn().mockResolvedValue(undefined),
  };
  const stop = { ...start, channel: { send: vi.fn() } };
  const controller = new DiscordVoiceController({
    apiKey: "test",
    realtimeSessionModel: "test",
    transcriptionModel: "test",
    minutesModel: "test",
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });

  await controller.join(start as unknown as Message);
  expect(voiceChannel.send).toHaveBeenCalled();
  speaking.emit("start", "guest");
  opus.write(Buffer.alloc((48_000 * 4) / 5));

  const closed = once(opus, "close");
  const delivery = controller.leave(stop as unknown as Message);
  await closed;
  await vi.waitFor(() => expect(mocks.commit).toHaveBeenCalledOnce());
  expect(output.send).not.toHaveBeenCalled();
  completeTranscript("Codex も議題に含め、来週公開する。");
  await delivery;

  expect(connection.destroy).toHaveBeenCalledOnce();
  expect(stop.channel.send).not.toHaveBeenCalled();
  expect(output.send).toHaveBeenCalledOnce();
  const file = output.send.mock.calls[0][0].files[0];
  expect(file.name).toBe("meeting-minutes.md");
  expect(file.attachment.toString()).toContain(
    "花子: Codex も議題に含め、来週公開する。",
  );
  expect(file.attachment.toString()).toContain("## 決定事項");
});
