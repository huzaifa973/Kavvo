#!/usr/bin/env bash
# One-time setup for the @kavvo/voice Python engines.
#
# Creates `python/.venv` and installs the pinned `requirements.txt`
# (Kokoro 0.9.4, faster-whisper 1.2.1, soundfile, torch). Model
# weights (~390 MB total) download on first use of tts.py / stt.py,
# not here.
#
# espeak-ng: Kokoro's English phonemizer uses the `espeakng-loader`
# wheel bundled in the venv (self-contained; proven — synthesis works
# with no system espeak-ng). If a system espeak-ng is absent we still
# try to install it as a belt-and-braces fallback for other
# phonemizer backends, but that step is best-effort and never fails
# the setup.
#
# Re-running is safe: every step is idempotent.
#
# Notes:
# - TMPDIR: pip unpacks wheels under $TMPDIR; point it at a roomy disk
#   if /tmp is a small tmpfs (the torch wheel alone is ~550 MB).
# - torch comes from PyPI. Those wheels link against CUDA libraries
#   shipped as pip packages; on a CPU-only machine they sit unused and
#   torch runs on CPU. Where download.pytorch.org is reachable, the
#   lighter CPU-only wheel also works:
#     pip install "torch==2.13.0" --index-url https://download.pytorch.org/whl/cpu
#   (from this build VM that host timed out repeatedly, so PyPI is the
#   recorded route — see BUILD-LOG.md.)
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v espeak-ng >/dev/null 2>&1; then
  echo "No system espeak-ng; trying apt (best-effort, the venv's espeakng-loader already covers Kokoro)..."
  timeout 300 apt-get update && timeout 300 apt-get install -y espeak-ng || \
    echo "apt step skipped/failed; continuing with the bundled espeakng-loader."
fi

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

echo "Voice engines ready: .venv/bin/python"
