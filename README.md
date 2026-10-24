<p align="center">
  <img src="site/assets/logo.svg" width="120" alt="Kavvo — open ring orb logo">
</p>

<h1 align="center">Kavvo</h1>

<p align="center">
  <strong>The agent that just does it.</strong><br>
  A skill-first, all-in-one AI agent platform. Bring your own API keys (BYOK) —
  skills, an agent composer, a real-human browser, voice and memory in one
  free, open-source app for Windows.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-black" alt="MIT license">
  <img src="https://img.shields.io/badge/tests-237%20passing-brightgreen" alt="237 tests passing">
  <img src="https://img.shields.io/badge/status-v0.1%20pre--release-blue" alt="v0.1 pre-release">
  <img src="https://img.shields.io/badge/platform-Windows-lightgrey" alt="Windows">
</p>

<p align="center">
  <a href="https://github.com/huzaifa973/Kavvo/releases"><strong>Download for Windows</strong></a>
  · <a href="#quickstart">Quickstart</a>
  · <a href="CONTRIBUTING.md">Contributing</a>
</p>

One AI platform that *does* work instead of browsing for it — skill-first,
with a real-human browser for the web work that truly needs one, and one
brain across desktop, web and mobile.

> Other agents get blocked. Ours finishes.

## Status

**v0.1 — platform core working, pre-release.** This is real, tested code
(237 tests), not a demo script — but it is also not a finished product, and
this README does not pretend otherwise.

### What works today

- **Skill Engine** (`packages/skill-engine`) — a typed skill registry and
  executor shipping **13 built-in skills** (text utilities like word-count,
  slugify, case conversion, base64 and hashing; data tools like CSV↔JSON and
  a JSON formatter; generators and converters). Skills run natively and
  instantly — no web page is ever opened for work a skill can do.
- **Brain Router** (`packages/router`) — original routing code with
  priority-order failover: it tries the next provider instead of
  retry-hammering a failing one, and records which provider served every
  request. BYOK adapters are included for **Groq, OpenRouter, Gemini**
  (all OpenAI-compatible endpoints) and keyless local **Ollama**. Keys are
  resolved at call time, never logged, and redacted out of error text.
- **Endpoint Rules Engine** (`packages/rules-engine`) — every provider call
  passes a rate guard first: per-provider and per-key rolling limits,
  daily token budgets, and deterministic exponential backoff. Nothing calls
  an endpoint directly, so keys and accounts stay alive.
- **Agent Composer** (`packages/composer`) — chains skills and chat steps
  into jobs with `{{step.field}}` references between steps, and checkpoints
  the full job state after every step. A failed or paused job **resumes from
  the first incomplete step** — completed steps never re-run. Tasks pause;
  they never die.
- **Memory Core** (`packages/memory-core`) — durable long-term memory
  (facts, preferences, people, projects) with deduping writes and
  **token-budgeted retrieval**: only what a task needs enters the model's
  context, so the assistant remembers a lot while spending few tokens.
- **Automations** (`packages/automations`) — interval, daily and one-shot
  schedules that run Composer jobs, with catch-up semantics for missed
  slots and per-schedule run records that survive restarts.
- **Skill Forge** (`packages/skill-forge`) — new skills are added as specs
  that pass through validate → compile → smoke-test → register, with
  provenance (spec hash + timestamp) and full rollback on any failure.
  Forged skills persist on disk and reload at boot alongside the built-ins.
- **Real-Human Browser** (`packages/browser`) — drives Chromium the way a
  person does: the cursor physically travels along curved,
  overshoot-and-settle paths and clicks in real time through Playwright's
  real mouse/keyboard APIs, with humanized per-key typing, inside a
  **persistent real profile** (logins and cookies survive between runs).
  On top of that sit **check detection** (captcha widgets, verification
  walls, login walls — observation only) and a **human handoff**: when a
  check needs a person, the task waits for the human to clear it in the
  real browser instead of failing.
- **Voice** (`packages/voice`) — local speech-to-text (faster-whisper) and
  text-to-speech (Kokoro) running entirely on your own hardware, with a
  proven real round-trip: speak → transcribe → reply → hear it back.
  Zero per-minute cost, works offline.
- **Web shell** (`apps/web`) — the whole core behind one local HTTP server
  with a single-page UI: run skills, build and resume jobs, browse memory,
  manage automations, forge skills. Jobs, memory, forge records and
  schedules persist in a local data directory across restarts.
- **Desktop app** (`apps/desktop`) — an Electron wrapper that boots the
  same shell in-process and shows it in a hardened window
  (context isolation on, node integration off, sandboxed preload), with
  all data in the OS per-user app directory and single-instance behavior.

### What is NOT in yet

- **Hosted cloud** — no always-on hosted tier exists yet; everything runs
  locally on your machine.
- **Mobile app** (`apps/mobile`) — the control-tower app (commands,
  handoff taps, reports) is a placeholder folder today.
- **Studio** — AI image/video generation and editing is planned, not built.
- **Live keys in the shell UI** — the router's adapters are verified
  against the real Gemini and Groq APIs, and the composer already feeds
  budgeted memory context into chat steps; the in-app settings/keys
  surface is the remaining piece. No key, no fake demo brain.
- **The vision check-solver** — the middle layer between prevention and
  handoff is deliberately unbuilt; detection and handoff are real today.
- **Installers** — desktop packaging is configured (electron-builder,
  NSIS target) and a portable Windows build is available today; the
  one-click installer is produced by the desktop build workflow.

## Doctrine

Four rules shape everything in this repo:

1. **Skills, not browsing.** Small work is done by native skills,
   instantly, inside the platform. The browser is the last resort, used
   only when a task truly needs the live web.
2. **Endpoint rules are law.** Every agentic call respects each
   provider's rate limits and quotas — guard first, backoff instead of
   hammering, failover instead of retry storms.
3. **Tasks pause, never die.** Checkpoint after every step; a blocked,
   failed or interrupted job resumes where it stopped.
4. **BYOK — bring your own key.** Users plug in their own provider keys
   (or run local Ollama). The platform's inference cost is $0 at any
   scale, and no customer is ever served on someone else's free-tier key.

## Quickstart

Prerequisites: **Node 24** and npm.

```bash
npm install          # install all workspace dependencies (repo root)
npm test             # full vitest suite (237 tests)
npm run typecheck    # strict TypeScript check across packages and apps
```

The browser tests drive a real headless Chromium via Playwright. If the
browser binaries are not already on your machine, install them once:

```bash
npx playwright install chromium           # add --with-deps on Linux CI
```

### Run the web shell

```bash
npm run build --workspace=@kavvo/web
npm start --workspace=@kavvo/web
```

Then open <http://127.0.0.1:4317> (port from `PORT`, default 4317; the
server binds localhost only). Data persists under `.data/` by default —
override with `KAVVO_DATA_DIR`.

### Run the desktop app

```bash
npm start --workspace=@kavvo/desktop
```

This builds the shell and launches the Electron app, with all data in the
OS per-user app directory.

## Project layout

```text
packages/
  rules-engine/   Endpoint rules guard: per-key rate limits, token budgets, backoff
  router/         Brain Router: provider failover, BYOK key registry, provider adapters
  skill-engine/   Skill registry + executor, 13 built-in skills
  skill-forge/    Forged-skill pipeline: validate, compile, smoke-test, register
  composer/       Job composer: step chaining, checkpoint + resume, job stores
  memory-core/    Long-term memory: deduping store, token-budgeted retrieval
  automations/    Schedule engine: interval / daily / once triggers, catch-up
  browser/        Real-human browser: human mouse + typing, check detection, handoff
  voice/          Voice layer: local STT (faster-whisper) + TTS (Kokoro)
apps/
  web/            Web shell: local HTTP server + UI over the assembled core
  desktop/        Desktop app: Electron wrapper around the shell
  mobile/         Mobile control app (planned — placeholder)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: TypeScript strict,
tests required for new behavior, and two hard rules — the browser is
never driven through the DOM or by teleporting the mouse, and features
are rebuilt from observed behavior, never copied from another app's
code, assets or design.

## License

The open-source core is released under the **MIT License** — see
[LICENSE](LICENSE). (A future hosted/advanced tier is a separate,
closed offering; it is not part of this repository.)
