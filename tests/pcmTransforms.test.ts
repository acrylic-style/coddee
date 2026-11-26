import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { DiscordPcmToRealtimePcm } from "../src/voice/pcmTransforms.js";

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
});
