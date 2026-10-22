import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PythonVoiceEngine, VoiceEngineError } from "../src/index.js";

/**
 * A fake "python" executable: a shell script that appends its argv
 * (one arg per line) to $FAKE_VOICE_LOG and answers with canned JSON
 * shaped like the real helpers' output. The tts branch echoes back
 * whatever followed --out so the engine's own path building is what
 * gets asserted, not the script's.
 */
const FAKE_PYTHON = `#!/bin/sh
printf '%s\\n' "$@" >> "$FAKE_VOICE_LOG"
case "$*" in
  *tts.py*)
    out=""
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--out" ]; then out="$a"; fi
      prev="$a"
    done
    printf '{"ok":true,"out":"%s","seconds":2.5}\\n' "$out"
    ;;
  *stt.py*)
    printf '{"ok":true,"text":"hello world","language":"en"}\\n'
    ;;
esac
`;

const FAILING_PYTHON = `#!/bin/sh
echo "some stdout noise"
echo "RuntimeError: model not found" >&2
exit 3
`;

function makeFake(script: string): { pythonPath: string; logPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "skillforge-voice-test-"));
  const pythonPath = join(dir, "fake-python");
  writeFileSync(pythonPath, script);
  chmodSync(pythonPath, 0o755);
  return { pythonPath, logPath: join(dir, "argv.log"), dir };
}

function engineWith(pythonPath: string, workDir: string): PythonVoiceEngine {
  return new PythonVoiceEngine({
    pythonPath,
    helpersDir: "/helpers",
    workDir,
    now: () => new Date("2026-10-22T08:15:30.000Z"),
  });
}

describe("PythonVoiceEngine against a fake python", () => {
  it("synthesize passes text, voice and a workDir output path, and parses the JSON", async () => {
    const { pythonPath, logPath, dir } = makeFake(FAKE_PYTHON);
    process.env.FAKE_VOICE_LOG = logPath;
    const workDir = join(dir, "out");
    const engine = engineWith(pythonPath, workDir);

    const result = await engine.synthesize("Hello world", { voice: "bf_emma" });

    expect(result.seconds).toBe(2.5);
    expect(result.wavPath).toBe(join(workDir, "tts-hello-world-20261022T081530.wav"));

    const argv = readFileSync(logPath, "utf8").trim().split("\n");
    expect(argv[0]).toBe("/helpers/tts.py");
    expect(argv.slice(1)).toEqual([
      "--text",
      "Hello world",
      "--voice",
      "bf_emma",
      "--out",
      result.wavPath,
    ]);
  });

  it("synthesize defaults to the af_heart voice", async () => {
    const { pythonPath, logPath, dir } = makeFake(FAKE_PYTHON);
    process.env.FAKE_VOICE_LOG = logPath;
    const engine = engineWith(pythonPath, join(dir, "out"));

    await engine.synthesize("Hi");

    const argv = readFileSync(logPath, "utf8").trim().split("\n");
    const voiceIdx = argv.indexOf("--voice");
    expect(argv[voiceIdx + 1]).toBe("af_heart");
  });

  it("transcribe passes audio path and model, and parses text + language", async () => {
    const { pythonPath, logPath, dir } = makeFake(FAKE_PYTHON);
    process.env.FAKE_VOICE_LOG = logPath;
    const engine = engineWith(pythonPath, join(dir, "out"));

    const result = await engine.transcribe("/some/audio.wav", { model: "base" });

    expect(result).toEqual({ text: "hello world", language: "en" });
    const argv = readFileSync(logPath, "utf8").trim().split("\n");
    expect(argv[0]).toBe("/helpers/stt.py");
    expect(argv.slice(1)).toEqual(["--audio", "/some/audio.wav", "--model", "base"]);
  });

  it("transcribe defaults to the tiny model", async () => {
    const { pythonPath, logPath, dir } = makeFake(FAKE_PYTHON);
    process.env.FAKE_VOICE_LOG = logPath;
    const engine = engineWith(pythonPath, join(dir, "out"));

    await engine.transcribe("/a.wav");

    const argv = readFileSync(logPath, "utf8").trim().split("\n");
    const modelIdx = argv.indexOf("--model");
    expect(argv[modelIdx + 1]).toBe("tiny");
  });

  it("surfaces a failing helper as a VoiceEngineError carrying the stderr tail", async () => {
    const { pythonPath, dir } = makeFake(FAILING_PYTHON);
    const engine = engineWith(pythonPath, join(dir, "out"));

    const err = await engine.synthesize("boom").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceEngineError);
    const voiceErr = err as VoiceEngineError;
    expect(voiceErr.helper).toBe("tts.py");
    expect(voiceErr.message).toContain("code 3");
    expect(voiceErr.stderrTail).toContain("RuntimeError: model not found");
  });

  it("surfaces a missing python executable as a VoiceEngineError", async () => {
    const engine = engineWith("/nonexistent/python", "/tmp/work");
    const err = await engine.transcribe("/a.wav").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceEngineError);
    expect((err as VoiceEngineError).message).toContain("could not start");
  });
});
