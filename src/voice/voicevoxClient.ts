const MAX_SPEECH_SEGMENT_LENGTH = 120;

interface VoicevoxClientOptions {
  baseUrl: string;
  speakerId: number;
}

export class VoicevoxClient {
  constructor(private readonly options: VoicevoxClientOptions) {}

  async synthesize(text: string): Promise<Buffer> {
    const baseUrl = this.options.baseUrl.replace(/\/$/, "");
    const queryUrl = new URL(`${baseUrl}/audio_query`);
    queryUrl.searchParams.set("text", text);
    queryUrl.searchParams.set("speaker", String(this.options.speakerId));
    const queryResponse = await fetch(queryUrl, { method: "POST" });
    if (!queryResponse.ok) {
      throw new Error(`VOICEVOX audio_query failed (${queryResponse.status})`);
    }
    const query = (await queryResponse.json()) as Record<string, unknown>;
    query.outputSamplingRate = 24_000;
    query.outputStereo = false;

    const synthesisUrl = new URL(`${baseUrl}/synthesis`);
    synthesisUrl.searchParams.set("speaker", String(this.options.speakerId));
    const synthesisResponse = await fetch(synthesisUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    });
    if (!synthesisResponse.ok) {
      throw new Error(
        `VOICEVOX synthesis failed (${synthesisResponse.status})`,
      );
    }
    return extractPcm16Mono24k(
      Buffer.from(await synthesisResponse.arrayBuffer()),
    );
  }
}

export function splitSpeechText(text: string): string[] {
  const normalized = text
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gu, "$1")
    .replace(/https?:\/\/\S+/gu, "リンク")
    .replace(/[*_`#>]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) {
    return [];
  }

  const sentences = normalized.match(/[^。！？!?]+[。！？!?]?/gu) ?? [
    normalized,
  ];
  const segments: string[] = [];
  for (const sentence of sentences) {
    let value = sentence.trim();
    if (!value) {
      continue;
    }
    while (value.length > MAX_SPEECH_SEGMENT_LENGTH) {
      segments.push(value.slice(0, MAX_SPEECH_SEGMENT_LENGTH));
      value = value.slice(MAX_SPEECH_SEGMENT_LENGTH);
    }
    if (value) {
      segments.push(value);
    }
  }
  return segments;
}

export function extractPcm16Mono24k(wav: Buffer): Buffer {
  if (
    wav.length < 44 ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("VOICEVOX returned an invalid WAV file");
  }
  let offset = 12;
  let validFormat = false;
  let pcm: Buffer | null = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, wav.length);
    if (id === "fmt " && size >= 16 && end <= wav.length) {
      validFormat =
        wav.readUInt16LE(start) === 1 &&
        wav.readUInt16LE(start + 2) === 1 &&
        wav.readUInt32LE(start + 4) === 24_000 &&
        wav.readUInt16LE(start + 14) === 16;
    } else if (id === "data") {
      pcm = wav.subarray(start, end);
    }
    offset = start + size + (size % 2);
  }
  if (!validFormat || !pcm) {
    throw new Error("VOICEVOX WAV must be PCM16, 24kHz, mono");
  }
  return pcm;
}
