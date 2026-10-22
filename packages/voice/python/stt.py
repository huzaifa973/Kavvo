#!/usr/bin/env python3
"""faster-whisper STT helper.

Usage:
  python3 stt.py --audio file.wav --model tiny

Prints exactly one JSON line on stdout on success:
  {"ok": true, "text": "<transcript>", "language": "<iso code>"}
On failure the traceback goes to stderr and the exit code is non-zero;
the caller (the TypeScript engine) surfaces the stderr tail.
"""

import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe audio with faster-whisper.")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", default="tiny")
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    segments, info = model.transcribe(args.audio)
    text = "".join(segment.text for segment in segments).strip()
    print(json.dumps({"ok": True, "text": text, "language": info.language}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
