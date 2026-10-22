#!/usr/bin/env python3
"""Kokoro TTS helper.

Usage:
  python3 tts.py --text "..." --voice af_heart --out file.wav

Prints exactly one JSON line on stdout on success:
  {"ok": true, "out": "<path>", "seconds": <float>}
On failure the traceback goes to stderr and the exit code is non-zero;
the caller (the TypeScript engine) surfaces the stderr tail.
"""

import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Synthesize speech with Kokoro.")
    parser.add_argument("--text", required=True)
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    import numpy as np
    import soundfile as sf
    from kokoro import KPipeline

    # Kokoro voices are prefixed with their language code:
    # a = American English, b = British English, j = Japanese, z = Mandarin, ...
    lang_code = args.voice[0] if args.voice else "a"
    pipeline = KPipeline(lang_code=lang_code)

    chunks = []
    for _graphemes, _phonemes, audio in pipeline(args.text, voice=args.voice):
        if hasattr(audio, "detach"):  # torch tensor -> numpy
            audio = audio.detach().cpu().numpy()
        chunks.append(np.asarray(audio, dtype=np.float32))
    if not chunks:
        raise RuntimeError("Kokoro produced no audio for the given text")

    sample_rate = 24000  # Kokoro-82M always emits 24 kHz.
    full = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
    sf.write(args.out, full, sample_rate)
    seconds = len(full) / sample_rate
    print(json.dumps({"ok": True, "out": args.out, "seconds": round(seconds, 3)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
