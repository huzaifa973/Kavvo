/**
 * The voice contract every surface consumes. Engines are local and
 * free: text-to-speech (Kokoro) and speech-to-text (faster-whisper),
 * driven as Python child processes by the default implementation.
 */

export interface SynthesizeOptions {
  /** Kokoro voice id, e.g. "af_heart" (the default). */
  voice?: string;
}

export interface TranscribeOptions {
  /** faster-whisper model size, e.g. "tiny" (the default), "base", "large-v3". */
  model?: string;
}

export interface SynthesizeResult {
  /** Absolute path of the WAV written by the engine. */
  wavPath: string;
  /** Duration of the synthesized audio in seconds. */
  seconds: number;
}

export interface TranscribeResult {
  text: string;
  /** ISO language code detected by the recognizer, e.g. "en". */
  language: string;
}

export interface VoiceEngine {
  synthesize(text: string, opts?: SynthesizeOptions): Promise<SynthesizeResult>;
  transcribe(audioPath: string, opts?: TranscribeOptions): Promise<TranscribeResult>;
}

/**
 * A voice helper process failed: it exited non-zero, could not be
 * started, timed out, or returned output that did not match the
 * contract. `stderrTail` carries the last lines of the helper's
 * stderr so the real cause (missing model, bad audio, ...) is
 * visible to the caller instead of being swallowed.
 */
export class VoiceEngineError extends Error {
  readonly helper: string;
  readonly stderrTail: string;

  constructor(helper: string, message: string, stderrTail = "") {
    super(message);
    this.name = "VoiceEngineError";
    this.helper = helper;
    this.stderrTail = stderrTail;
  }
}
