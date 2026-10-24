# @kavvo/voice

The free, local voice stack from PLAN.md: **Kokoro** for speech out,
**faster-whisper** for ears. No per-character API bills, no audio
leaving the machine. The engines are Python; this package drives
them as child processes behind one TypeScript interface.

## The contract (`src/types.ts`)

```ts
interface VoiceEngine {
  synthesize(text, { voice? }): Promise<{ wavPath, seconds }>
  transcribe(audioPath, { model? }): Promise<{ text, language }>
}
```

`PythonVoiceEngine` is the v1 implementation. Failures surface as
`VoiceEngineError` carrying the helper's stderr tail — never a
silent empty result.

## Setup (once)

```bash
bash packages/voice/python/setup.sh
```

Creates `python/.venv` and installs the pinned `requirements.txt`
(Kokoro 0.9.4, faster-whisper 1.2.1, soundfile, torch). Kokoro's
English phonemizer runs on the `espeakng-loader` wheel inside the
venv (self-contained — synthesis is proven with no system
espeak-ng); the script still tries an apt install of `espeak-ng`
as a best-effort fallback and never fails on it. Notes in the
script: set `TMPDIR` to a roomy disk if `/tmp` is a small tmpfs
(wheels are big), and torch comes from PyPI (its CUDA library
packages sit unused on CPU-only machines).

Model weights download on first use into the HuggingFace cache:
Kokoro-82M ≈ 313 MB, a whisper model ≈ 75 MB (tiny) and up.

## The helpers (`python/`)

- `tts.py --text "..." --voice af_heart --out file.wav` — prints
  `{"ok": true, "out": ..., "seconds": ...}`. WAV is 24 kHz mono,
  as Kokoro emits. The voice id's first letter selects the
  language pack (`a` American English, `b` British, `j`
  Japanese, `z` Mandarin, ...).
- `stt.py --audio file.wav --model tiny` — prints
  `{"ok": true, "text": ..., "language": ...}`. Any faster-whisper
  model size works (`tiny` … `large-v3`).

Both print exactly one JSON line on stdout; tracebacks go to
stderr with a non-zero exit.

## Output filenames (`src/filename.ts`)

Synthesized files are named `tts-<slug>-<utc-timestamp>.wav` from
the text (slug rules tested without Python): readable, and repeated
syntheses never overwrite each other. The engine's work directory
is configurable (`workDir` option; default a temp folder).

## What is deliberately not here yet

- **Chatterbox** (voice cloning, emotion, 23 languages) — not
  installed; Kokoro is the v1 default voice. Its `VoiceEngine`
  implementation slots in beside `PythonVoiceEngine` later.
- Streaming synthesis/playback, and the shell/Electron wiring —
  the web shell and desktop app consume this package in a later
  piece.
- Voice choice is limited to Kokoro's voice list; `voice` is
  passed through unvalidated and Kokoro's own error surfaces via
  the stderr tail.
