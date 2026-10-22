import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildWavFilename } from "./filename.js";
import {
  VoiceEngineError,
  type SynthesizeOptions,
  type SynthesizeResult,
  type TranscribeOptions,
  type TranscribeResult,
  type VoiceEngine,
} from "./types.js";

export interface PythonVoiceEngineOptions {
  /**
   * Python executable. Defaults to the package venv created by
   * `python/setup.sh` (`packages/voice/python/.venv/bin/python`).
   * Tests point this at a fake executable script.
   */
  pythonPath?: string;
  /** Directory holding tts.py / stt.py. Defaults to the package's python/ dir. */
  helpersDir?: string;
  /** Directory synthesized WAVs are written into. Created on demand. */
  workDir?: string;
  /** Per-call helper timeout. First runs download model weights, so the default is generous. */
  timeoutMs?: number;
  /** Clock for output filenames; injectable for tests. */
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const STDERR_TAIL_CHARS = 2000;

function packagePythonDir(): string {
  return fileURLToPath(new URL("../python/", import.meta.url));
}

function tail(text: string): string {
  return text.trim().slice(-STDERR_TAIL_CHARS);
}

/**
 * The v1 engine: drives the package's Python helpers
 * (Kokoro for speech, faster-whisper for transcription) as child
 * processes and speaks JSON lines with them. Nothing is faked: a
 * helper that fails surfaces as a `VoiceEngineError` carrying the
 * helper's own stderr tail.
 */
export class PythonVoiceEngine implements VoiceEngine {
  private readonly pythonPath: string;
  private readonly helpersDir: string;
  private readonly workDir: string;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(opts: PythonVoiceEngineOptions = {}) {
    const pythonDir = packagePythonDir();
    this.pythonPath = opts.pythonPath ?? join(pythonDir, ".venv", "bin", "python");
    this.helpersDir = opts.helpersDir ?? pythonDir;
    this.workDir = opts.workDir ?? join(tmpdir(), "skillforge-voice");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = opts.now ?? (() => new Date());
  }

  async synthesize(text: string, opts: SynthesizeOptions = {}): Promise<SynthesizeResult> {
    await mkdir(this.workDir, { recursive: true });
    const outPath = join(this.workDir, buildWavFilename(text, this.now()));
    const result = await this.runHelper("tts.py", [
      "--text",
      text,
      "--voice",
      opts.voice ?? "af_heart",
      "--out",
      outPath,
    ]);
    if (typeof result.seconds !== "number") {
      throw new VoiceEngineError("tts.py", "tts.py returned no numeric 'seconds'", tail(this.lastStderr));
    }
    return {
      wavPath: typeof result.out === "string" ? result.out : outPath,
      seconds: result.seconds,
    };
  }

  async transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
    const result = await this.runHelper("stt.py", [
      "--audio",
      audioPath,
      "--model",
      opts.model ?? "tiny",
    ]);
    if (typeof result.text !== "string" || typeof result.language !== "string") {
      throw new VoiceEngineError(
        "stt.py",
        "stt.py returned no string 'text'/'language'",
        tail(this.lastStderr),
      );
    }
    return { text: result.text, language: result.language };
  }

  private lastStderr = "";

  private runHelper(helper: string, args: string[]): Promise<Record<string, unknown>> {
    const script = join(this.helpersDir, helper);
    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonPath, [script, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new VoiceEngineError(
            helper,
            `${helper} timed out after ${this.timeoutMs} ms`,
            tail(stderr),
          ),
        );
      }, this.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        this.lastStderr = stderr;
        reject(
          new VoiceEngineError(
            helper,
            `could not start ${this.pythonPath} (run packages/voice/python/setup.sh?): ${err.message}`,
            tail(stderr),
          ),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        this.lastStderr = stderr;
        if (code !== 0) {
          reject(
            new VoiceEngineError(helper, `${helper} exited with code ${code}`, tail(stderr)),
          );
          return;
        }
        const lines = stdout.trim().split("\n").filter(Boolean);
        const lastLine = lines[lines.length - 1];
        let parsed: unknown;
        try {
          parsed = JSON.parse(lastLine ?? "");
        } catch {
          reject(
            new VoiceEngineError(helper, `${helper} printed no JSON result line`, tail(stderr)),
          );
          return;
        }
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          (parsed as Record<string, unknown>).ok !== true
        ) {
          reject(
            new VoiceEngineError(helper, `${helper} reported failure: ${lastLine}`, tail(stderr)),
          );
          return;
        }
        resolve(parsed as Record<string, unknown>);
      });
    });
  }
}
