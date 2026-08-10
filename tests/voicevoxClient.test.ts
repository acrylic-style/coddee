import { describe, expect, it } from "vitest";
import {
  extractPcm16Mono24k,
  splitSpeechText,
} from "../src/voice/voicevoxClient.js";

function makeWav(pcm: Buffer): Buffer {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

describe("VOICEVOX helpers", () => {
  it("extracts PCM16 mono 24kHz samples from a WAV response", () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    expect(extractPcm16Mono24k(makeWav(pcm))).toEqual(pcm);
  });

  it("splits speech early and removes URLs and Markdown noise", () => {
    expect(
      splitSpeechText(
        "結果です。詳しくは [公式](https://example.com/path) をご覧ください！",
      ),
    ).toEqual(["結果です。", "詳しくは 公式 をご覧ください！"]);
  });
});
