import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  DiscordPcmToRealtimePcm,
  RealtimePcmToDiscordPcm,
} from "../src/voice/pcmTransforms.js";

async function transform(
  stream: NodeJS.ReadWriteStream,
  input: Buffer,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.end(input);
  await once(stream, "end");
  return Buffer.concat(chunks);
}

describe("PCM transforms", () => {
  it("mixes stereo and downsamples 48kHz PCM to 24kHz mono", async () => {
    const input = Buffer.alloc(16);
    input.writeInt16LE(1_000, 0);
    input.writeInt16LE(3_000, 2);
    input.writeInt16LE(5_000, 4);
    input.writeInt16LE(7_000, 6);
    input.writeInt16LE(-3_000, 8);
    input.writeInt16LE(-1_000, 10);
    input.writeInt16LE(2_000, 12);
    input.writeInt16LE(4_000, 14);

    const output = await transform(new DiscordPcmToRealtimePcm(), input);

    expect([...output]).toEqual([0xd0, 0x07, 0x30, 0xf8]);
  });

  it("duplicates 24kHz mono samples into 48kHz stereo frames", async () => {
    const input = Buffer.alloc(4);
    input.writeInt16LE(1_000, 0);
    input.writeInt16LE(-1_000, 2);

    const output = await transform(new RealtimePcmToDiscordPcm(), input);

    expect(output.length).toBe(16);
    expect([
      output.readInt16LE(0),
      output.readInt16LE(2),
      output.readInt16LE(4),
      output.readInt16LE(6),
      output.readInt16LE(8),
      output.readInt16LE(10),
      output.readInt16LE(12),
      output.readInt16LE(14),
    ]).toEqual([1_000, 1_000, 1_000, 1_000, -1_000, -1_000, -1_000, -1_000]);
  });
});
