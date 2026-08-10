const WAKE_WORD =
  /^(?:ね[ぇえ][、,\s]*)?(?:[アあ][レれ][クくっ][サさ]|アレックス|あれ、さあ、|あれさ、)[、,:：\s]*(.*)$/iu;

export interface WakeWordResult {
  matched: boolean;
  prompt: string;
}

export function extractCodexWakeWord(transcript: string): WakeWordResult {
  const normalized = transcript.trim();
  const match = WAKE_WORD.exec(normalized);
  if (!match) {
    return { matched: false, prompt: normalized };
  }

  return { matched: true, prompt: (match[1] ?? "").trim() };
}

export function shouldHandleVoiceTranscript(
  transcript: string,
  humanCount: number,
): WakeWordResult {
  const wakeWord = extractCodexWakeWord(transcript);
  if (humanCount <= 1) {
    return {
      matched: true,
      prompt: wakeWord.matched ? wakeWord.prompt : transcript.trim(),
    };
  }
  return wakeWord;
}
