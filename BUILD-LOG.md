# Build Log

## 2026-10-22 — Phase 1 core (v0.1 foundation)

First real code for Skillforge, per PLAN.md. TypeScript + Node 24, npm
workspaces monorepo. Everything below is original code written for this
project. No third-party router is used anywhere (FreeLLMAPI was removed
entirely by user directive, 2026-10-22).

### What was built

**Root setup**
- `package.json` — npm workspaces over `packages/*` and `apps/*`; scripts:
  `npm test` (vitest run) and `npm run typecheck` (tsc --noEmit).
- `tsconfig.base.json` + `tsconfig.json` — strict TS, ES2022, bundler module
  resolution, `@skillforge/*` path aliases to package sources.
- `vitest.config.ts` — resolves `@skillforge/*` to `packages/*/src` so tests
  run against source with no build step.
- `.gitignore` — node_modules, dist, coverage, .env, vendor/.

**packages/rules-engine — Endpoint Rules guard**
- `ProviderRule` type: `{ provider, requestsPerMinute, tokensPerDay, backoffBaseMs }`.
- `RateGuard` with per-provider + per-key rolling windows (60s requests,
  24h tokens). `acquire(provider, keyId, { estimatedTokens })` reserves a
  slot or throws a typed `RateLimitedError` carrying `retryAfterMs` and
  which limit was hit. A rejected acquire records nothing.
- `nextBackoffMs(attempt, provider?)` — deterministic exponential backoff,
  `base * 2^attempt`, capped at 60s.
- `recordUsage()` for post-hoc token accounting, `usage()` snapshot,
  injectable clock for tests.

**packages/router — Brain Router (original)**
- `Provider` interface: `chat(messages, opts)` returning a completion.
- `Router` tries providers in priority order. Before each attempt it passes
  the RateGuard when the provider has a rule. On a rate limit OR a provider
  failure it fails over to the next provider — it never retry-hammers the
  same endpoint. The result records which provider served plus a full
  attempt log; if everything fails it throws `AllProvidersDownError` with
  that log.
- `KeyRegistry` (BYOK): in-memory provider -> key ids. Public surface exposes
  key ids only; secrets are resolved internally at call time and passed to
  the provider adapter. Key values are never logged.
- `MockProvider` test double (fixed content, forced error, or handler;
  records calls and the opts/apiKey it received).

**packages/skill-engine — Skill Engine**
- `Skill` interface: `{ id, name, description, inputSchema, run(input, ctx) }`.
- `SkillRegistry`: register/get/list/has; duplicate ids rejected with
  `DuplicateSkillError`.
- `runSkill(id, input)` executor on the registry (plus a module-level helper
  on a default registry): unknown skill -> `SkillNotFoundError`; input
  missing a schema-required field -> `SkillInputError`.
- Two real, pure built-in skills:
  - `text.word-count` — words, characters, characters-no-spaces, sentences,
    paragraphs, reading time at 200 wpm.
  - `text.slugify` — title -> URL slug (diacritics stripped, separators
    collapsed, trimmed).

### Tests

29 tests, all passing (`npm test` at repo root):

- rules-engine: 10 — under-limit pass, over-limit typed throw with sane
  retryAfterMs, rejected acquire not recorded, per-key isolation, minute
  window roll-over, unknown provider, daily token cap, recordUsage,
  backoff growth + 60s cap.
- router: 9 — happy path + who-served record, empty-provider rejection,
  failover on guard rate limit (provider never called), failover on
  provider-thrown rate limit, failover on provider error, all-down error
  with attempt log, BYOK key id exposure/secret passing, duplicate key id,
  keyless provider.
- skill-engine: 10 — registry CRUD + duplicate rejection, not-found and
  input validation errors, word-count accuracy + reading time + empty
  text, slugify normal/accents/empty cases.

`npm run typecheck` is clean.

### Real vs stubbed

- Real: rate limiting math, failover logic, key registry, skill registry,
  both skills. All covered by tests above.
- Stubbed/absent by design at this stage:
  - No real provider adapters yet (Groq/Gemini/Ollama) — `MockProvider` is
    the stand-in; adapters implement the same `Provider` interface next.
  - The Router's pre-call token estimate is a rough chars/4 heuristic;
    adapters will report real usage (already wired via `recordUsage`).
  - Guard state is in-memory (per process). Persistence lands with the
    Vault / Memory Core work.
  - apps/* still hold only their placeholder READMEs (shell comes later in
    Phase 1). The other packages (composer, browser, memory-core, voice)
    are untouched placeholders.
  - Skill input validation is intentionally light: presence of required
    fields only. Full JSON-Schema validation arrives with the Composer.

### How to run

```bash
npm install        # at repo root, once
npm test           # full vitest suite
npm run typecheck  # strict TS check
```

## 2026-10-22 — Phase 1 continued: Agent Composer

**packages/composer — Agent Composer**

- Job model: a job is an ordered list of steps, each either
  `{ kind: "skill", skillId, input }` (executed through the Skill
  Engine's `runSkill`) or `{ kind: "chat", messages, options? }`
  (executed through a minimal `ChatClient` interface that the Brain
  Router satisfies structurally, so tests drive it with a real Router
  over `MockProvider`). Step ids are optional (auto `step-1`, ...),
  charset-restricted, and duplicates are rejected up front.
- Step-output references: `{{stepId}}` / `{{stepId.field}}` /
  `{{stepId.a.b}}` placeholders in any string inside a step's input or
  a chat step's messages, resolved recursively through plain objects
  and arrays. A string that is exactly one placeholder receives the
  referenced value typed (objects stay objects); embedded placeholders
  interpolate as text. References may only point to earlier, completed
  steps; anything else raises `StepReferenceError` and fails that step
  cleanly. Documented in packages/composer/README.md.
- Checkpoint + resume: a `JobStore` interface with two
  implementations — `InMemoryJobStore` (copy-in/copy-out isolation)
  and `FileJobStore` (one JSON file per job in a caller-provided
  directory, temp-file + rename writes). The Composer persists the
  full job record (normalized definition + per-step status, output,
  error; job status pending/running/paused/failed/completed) after
  EVERY step transition. A failed step stops the job as `failed` with
  the error recorded and earlier outputs kept; `resume(jobId)`
  continues from the first incomplete step, retrying the failed step
  and never re-running completed ones. `pause(jobId)` stops a running
  job after its current step; `resume` unpauses it. Step failures are
  reported through the returned `JobState`, not thrown; unknown job
  ids throw `JobNotFoundError`.
- Root change: `@types/node` added as a root devDependency (the
  FileJobStore and its tests are the first Node-API consumers).

### Tests

13 new composer tests, 42 total, all passing; typecheck clean:

- End-to-end: slugify → word-count chained via `{{make-slug.slug}}`.
- Templating: whole-placeholder values stay typed; embedded, nested
  and array placeholders interpolate.
- Chat step through a real Router + MockProvider, its `content`
  feeding a later word-count step; chat step with no client configured
  fails cleanly with a recorded error.
- Failure + resume: middle step throws → job `failed`, earlier output
  kept, later step untouched; a second Composer with the repaired
  skill resumes to completion, and a call counter proves the finished
  step ran exactly once (the failed step exactly twice).
- Unknown skill id fails the job cleanly with the registry's error
  recorded; a reference to a not-yet-completed step fails the same way.
- FileJobStore restart survival: failed job's on-disk JSON already
  holds step 1's completed output; a brand-new Composer + store over
  the same directory resumes it to completion.
- Pause mid-run (requested from inside a running step) halts after
  that step; resume finishes the job.
- Store units: round-trip, caller-mutation isolation, missing-job
  `undefined`, listing. Validation: empty steps and duplicate step ids
  rejected; resume of an unknown job throws.

### Real vs stubbed

- Real: job execution, templating, both stores, pause/resume
  semantics. All covered by the tests above.
- Stubbed/absent by design at this stage:
  - No automatic retry/backoff inside the Composer; a failed step
    waits for `resume()` after the cause is fixed.
  - No concurrent execution of the same job id by multiple Composers;
    the store is the coordination point when that lands.
  - FileJobStore requires JSON-serializable step outputs (the
    InMemory store does not).

## 2026-10-22 — Phase 1 continued: real provider adapters (Brain Router)

**packages/router — `OpenAICompatibleProvider` + presets**

- `OpenAICompatibleProvider` implements the existing `Provider`
  interface for any OpenAI-compatible chat endpoint: POST
  `{baseUrl}/chat/completions` (trailing slashes on the base URL are
  normalized) with `{ model, messages }`, plus `temperature` /
  `max_tokens` when the caller sets them. A per-call `opts.model`
  overrides the configured model. The OpenAI-style response is mapped
  into the router's `ProviderResponse`: first choice's message
  content, the response's model (falling back to the requested one),
  and `usage.totalTokens` from `total_tokens` (or prompt + completion
  tokens when only those are present) — which the Router already
  feeds into the RateGuard via `recordUsage`.
- BYOK secret handling: the key is resolved at call time into a local
  variable only — from `opts.apiKey` when the Router supplied one,
  otherwise from an injected `KeyRegistry` using the adapter's
  configured `keyId` (falling back to the registry's first key for
  that provider). It is never stored on the instance beyond the
  registry reference, never logged, and is redacted out of any error
  text an endpoint might echo back. Keyless endpoints (Ollama) send
  no Authorization header.
- Error mapping: HTTP 429 throws the rules-engine `RateLimitedError`
  (the exact signal the Router already fails over on), with
  `retryAfterMs` taken from the `Retry-After` header (seconds) or a
  1s default. Other non-2xx responses throw a typed `ProviderError`
  carrying the provider id, HTTP status, and a body snippet trimmed
  to 200 chars (secret-redacted). Network failures and malformed
  success bodies also surface as `ProviderError` (no status for
  network failures). The model is a required config value — the
  constructor rejects an empty id/baseUrl/model; there is no
  hard-coded default model anywhere.
- Presets (factory functions in `src/presets.ts`): `groqProvider`
  (https://api.groq.com/openai/v1), `openrouterProvider`
  (https://openrouter.ai/api/v1), `geminiProvider`
  (https://generativelanguage.googleapis.com/v1beta/openai/),
  `ollamaProvider` (http://localhost:11434/v1, keyless). Each takes
  `{ model, keyId?, keys?, fetchImpl? }`.

### Tests

12 new router tests, 54 total, all passing; typecheck clean. All use
a stubbed fetch — no network:

- Success mapping: content/model/usage mapped, request URL, method,
  body (model, messages, temperature, max_tokens) verified; per-call
  model override; empty model rejected.
- Authorization header taken from the registry (`Bearer` + resolved
  secret); Ollama sends no Authorization header.
- 429 maps to `RateLimitedError` with header-derived `retryAfterMs`,
  and a 429 from the real adapter fails over through a real Router
  to a `MockProvider` backup (attempt log shows `rate-limited` then
  `served`).
- 500 maps to `ProviderError` with status 500 and the body snippet;
  a network failure maps to `ProviderError` with no status.
- Secret hygiene: an error body that echoes the key comes back with
  the key redacted; the secret appears in neither the thrown error
  (message, snippet, or serialized form) nor the serialized provider
  instance.
- Usage flows end-to-end: a real Router + RateGuard records the
  response's 42 tokens against the serving key.

### Real vs stubbed

- Real: request building, response/usage mapping, key resolution,
  error mapping and redaction, all four presets, Router failover and
  RateGuard accounting against the adapter. All covered by the tests
  above with a stubbed fetch.
- NOT yet verified: any live endpoint. No real provider key exists
  in the project yet, so Groq / OpenRouter / Gemini / a local Ollama
  have never been called for real. Live verification waits on real
  free API keys from the user (BYOK); the moment one lands, the same
  adapter + Router path can be exercised end-to-end with no code
  changes — only registry entries.

## 2026-10-22 — Phase 1 continued: Skill Engine launch pack

**packages/skill-engine — 11 new built-in skills (13 total shipped)**

All pure and local: no network, no model calls, deterministic except
the two crypto-backed generators. All are registered in
`createDefaultRegistry()` alongside the original two and exported
from the package index with their input/result types.

- `text.word-count` — words, characters, sentences, paragraphs,
  reading time. (shipped earlier)
- `text.slugify` — title -> URL slug. (shipped earlier)
- `text.case-convert` — `{ text, mode }` -> `{ text }`; modes upper,
  lower, title, camel, pascal, snake, kebab. Identifier cases split
  words on any non-alphanumeric run; an unknown mode throws
  `SkillInputError`.
- `text.dedupe-lines` — `{ text, sort? }` -> `{ text, removed }`.
  Exact-match dedupe keeping first-occurrence order; `sort: true`
  sorts the survivors. A trailing newline is treated as the last
  line's terminator, not an extra empty line, and is preserved.
- `text.base64` — `{ text, action: "encode" | "decode" }`, UTF-8
  safe both ways. Decode validates strictly (canonical alphabet and
  padding) because `Buffer.from` silently ignores bad characters;
  malformed input throws `SkillInputError` instead of returning
  garbage.
- `text.hash` — `{ text, algorithm: "sha256" | "sha1" | "md5" }`
  -> `{ hash }` lowercase hex via `node:crypto`.
- `text.url-codec` — `{ text, action }` component-level
  percent-encoding (`encodeURIComponent` semantics); malformed
  percent sequences on decode surface as `SkillInputError` wrapping
  the native `URIError` message.
- `data.json-format` — `{ text, mode: "pretty" | "minify" }`;
  pretty uses 2-space indentation. Invalid JSON throws
  `SkillInputError` carrying the parser's own message.
- `data.csv-to-json` — `{ csv }` -> `{ rows }`. Hand-rolled
  RFC-4180-style parser: first row is headers, quoted fields may
  contain commas, newlines and `""` escaped quotes, LF and CRLF both
  accepted. Short rows are padded with `""`.
- `data.json-to-csv` — `{ rows }` -> `{ csv }`. Headers are the
  union of keys across all rows in first-seen order; values are
  quoted when they contain a comma, quote or newline; `null` /
  `undefined` render empty, numbers and booleans as text. Non-array
  or non-object-row input throws `SkillInputError`; zero rows give
  an empty string.
- `util.uuid` — `{ count? }` -> `{ uuids }` of UUID v4 from
  `node:crypto` `randomUUID`. Default 1; out-of-range counts are
  clamped into 1..100 rather than rejected.
- `util.unit-convert` — `{ value, from, to }` -> `{ value, unit }`.
  Length (mm, cm, m, km, in, ft, yd, mi) and weight (g, kg, lb, oz)
  convert through the family base unit; temperature (c, f, k) goes
  through Celsius. Results are trimmed to 12 significant digits to
  hide float noise. Cross-family conversions, unknown units and
  non-numeric values all throw `SkillInputError`.
- `util.password-generate` — `{ length?, symbols? }` ->
  `{ password }`. Letters and digits by default, symbols optional;
  characters are picked with `crypto.randomInt` (unbiased). Length
  defaults to 16 and must be an integer in 8..128 — out-of-range
  lengths throw `SkillInputError` rather than being clamped.

### Tests

39 new skill-engine tests in `test/skill-pack.test.ts`, 93 total,
all passing; typecheck clean:

- A registry test pins the shipped pack at exactly the 13 ids above.
- Per skill: the happy paths from the list above (including known
  sha256/sha1/md5 digests of "abc", the UTF-8 base64 of "héllo",
  1 mi = 1.609344 km, 1 lb = 16 oz, 100 c = 212 f) plus each
  skill's error/edge case: unknown case mode, unknown hash
  algorithm, malformed base64 (bad characters and missing padding),
  malformed percent-encoding, invalid JSON carrying the parser
  message, cross-family unit conversion, unknown unit, non-numeric
  value, password lengths 7 / 129 / 12.5, UUID count capped at 100,
  CSV quoting in both directions, and the JSON->CSV key-union
  ordering.

### Real vs stubbed

- Real: all 11 skills and their parsers/validators, registry wiring,
  and the tests above. Nothing in this pack is stubbed.
- Still light by design (unchanged from the foundation): the
  registry validates presence of required fields only; each skill
  validates its own enum values and input shapes and reports
  problems as `SkillInputError`. Full JSON-Schema validation still
  arrives with the Composer work.

## 2026-10-22 — Phase 1 final piece: the app shell (`apps/web`)

**apps/web — `@skillforge/web`: local server + single-page UI**

Phase 1 closes with a shell that runs the whole core end to end:
the Skill Engine and the Agent Composer behind one local HTTP
server, driven from a browser page. With this, v0.1's scope from
PLAN.md (shell + brain router + skill engine + composer) is fully
wired together.

- **Server** (`src/server.ts`) uses only Node's built-in `http` —
  no new runtime dependencies. Endpoints:
  - `GET /api/health` → `{ ok: true }`
  - `GET /api/skills` → the default registry's skills (id, name,
    description, inputSchema)
  - `POST /api/skills/:id/run` — JSON body is the skill input →
    `{ result }`; unknown skill 404, skill input errors 400 with
    the skill's own message
  - `GET /api/jobs` / `POST /api/jobs` — POST takes a Composer job
    definition, creates and runs it, returns the job state (201);
    definition errors are a clean 400
  - `GET /api/jobs/:id` — the persisted state, or 404
  - `POST /api/jobs/:id/resume` — resumes from the first incomplete
    step, returns the state; unknown job 404
  - Everything else under `/` is the UI, served from `public/`
    with a path-traversal guard.
- **Persistence**: jobs run through a Composer backed by
  `FileJobStore` under a data dir (`SKILLFORGE_DATA_DIR`, default
  `.data/` beside wherever the server was started; job files in
  `<dir>/jobs/`), so a job's checkpoints survive a server restart
  and `GET /api/jobs/:id` reads what is on disk, not memory.
- **Defensive bodies**: request JSON is size-capped at 1 MB (413
  past it, drained and discarded), malformed JSON is a 400, an
  empty body counts as `{}`.
- **Build**: the package imports the core packages by relative
  path instead of the `@skillforge/*` aliases, so `npm run build`
  (the repo's own TypeScript) emits a self-contained `dist/` tree
  that plain Node runs — no bundler, no type-stripping at run
  time. `npm start` runs `node dist/apps/web/src/server.js`; the
  build also copies `public/` next to the compiled output
  (`scripts/copy-public.mjs`). Listen address is 127.0.0.1, port
  from `PORT` (default 4317). Root `tsconfig.json` and
  `vitest.config.ts` now include `apps/web` so the root typecheck
  and test suite cover the shell too.
- **UI** (`public/`, vanilla JS, no build step): dark theme with
  all colors as CSS custom properties scoped to
  `[data-theme="dark"]`, so future themes are new variable blocks.
  A health indicator, the skill list with a JSON input editor
  prefilled from each skill's inputSchema, run + result panes, and
  a jobs panel: edit a job definition (a slugify → word-count
  sample is preloaded), run it, watch per-step status/output,
  load any persisted job by id or from the list, and resume a
  failed or paused job. A running job is polled once a second.

### Tests

11 new web-shell tests in `apps/web/test/server.test.ts`, 104
total, all passing; root and package typechecks clean. The suite
boots the real server in-process on an ephemeral port against a
temp data dir and covers: health, the UI at `/`, the skill list
pinning exactly the 13 shipped ids, slugify end to end over HTTP,
unknown skill 404, invalid input 400 carrying the skill's
message, malformed JSON 400, an over-cap body 413, a 2-step
chained job created + run + read back as `completed` from
persistence, resume on a completed job as a no-op with 404s for
unknown jobs, and a failed job whose resume re-fails cleanly with
the later step untouched.

Verified live as well: the compiled server was booted briefly
(`PORT=4399`), answered `/api/health`, listed 13 skills, ran
slugify over HTTP, completed a 2-step chained job whose JSON
checkpoint landed in the data dir, and served the UI — then it
was stopped.

### Real vs stubbed

- Real: every endpoint above, the UI flows, persistence through
  the same FileJobStore the Composer tests exercise, and the
  compiled artifact (the smoke test ran the `dist/` build, not
  the sources).
- Stubbed/absent by design at this stage:
  - No chat client is wired into the shell's Composer yet, so a
    `kind: "chat"` job step fails cleanly with that recorded as
    its step error. The Brain Router satisfies the Composer's
    `ChatClient` shape and plugs in here when the shell gains a
    keys/settings surface — deliberately not faked with a mock.
  - One dark theme ships; the theme system is structured for
    more (`[data-theme]` variable blocks) but no switcher UI yet.
  - The Electron desktop wrapper (`apps/desktop`) and the mobile
    app (`apps/mobile`) are later steps; their folders still hold
    placeholders. This shell is the web surface they will share.
  - No auth anywhere: the server binds 127.0.0.1 and is a local
    v0.1 shell. Auth arrives with the hosted/cloud phase, never
    bolted onto a localhost tool.

## 2026-10-22 — Phase 2 first piece: the Real-Human Browser core

**packages/browser — `@skillforge/browser`**

Phase 2 opens with the browser core from PLAN.md module 5. The
doctrine is stated plainly, because everything else in this package
follows from it:

> **The rule: the browser is driven like a real person. The cursor
> physically travels along curved paths and clicks in real time. The
> mouse is never teleported, and nothing is ever acted on through the
> DOM — no `element.click()` via JavaScript, no setting field values
> via JavaScript. Actions go through Playwright's real mouse/keyboard
> APIs, with human movement in between. Reading the page (geometry,
> results) is observation; acting is always physical.**

- **Path generator** (`src/path.ts`) — our own original
  implementation of the Ghost Cursor approach (no ghost-cursor
  dependency, no copied code). A cubic Bezier runs from the current
  position to a point just past the target: an overshoot of 4–42 px
  (scaled by distance, randomized, slightly off-axis), with both
  control points bowed sideways off the straight line by independent
  random amounts (up to ±22% of the distance, so paths curve and
  sometimes S). Sampling uses an ease-in-out profile (slow start,
  fast middle, slow arrival). A short settle curve then eases back
  from the overshoot point onto the exact target with a decaying
  sideways wobble. Step count scales with distance (one point per
  ~7 px, clamped 14–80). The generator is pure and exported, with an
  injectable RNG, so tests assert curvature exactly.
- **Human mouse** (`src/mouse.ts`) — `moveTo(page, x, y)` replays a
  generated path one `page.mouse.move` at a time with randomized
  5–12 ms step delays; the cursor position is tracked per page
  (Playwright never reports it back; a fresh page starts at 0,0,
  matching Playwright's own start). `click(page, locator)` reads the
  element's bounding box (geometry lookup — eyes, not hands), picks
  a randomized point inside it (18–82% across, never dead-center
  every time, never on the risky edge), travels there, then
  `mouse.down()`, a 45–110 ms press, `mouse.up()`.
- **Human typing** (`src/typing.ts`) — `typeText` clicks the field
  first (physically, through the human click), then sends one real
  key per character via `page.keyboard.type`, 45–130 ms randomized
  per-key delays, with roughly one key in sixteen followed by a
  120–260 ms thinking pause.
- **Session** (`src/session.ts`) — `launchSession({ profileDir,
  headless })` opens a Playwright **persistent context** (Chromium),
  so the profile on disk carries logins, cookies and history between
  runs: the "user's real browser" layer. Helpers: `goto()`,
  `currentUrl()`, `screenshot()`, `close()`, plus the raw
  `context`/`page`. As root (containers/VMs) Chromium's sandbox
  cannot initialize, so `--no-sandbox` is added automatically in
  that case only. `playwright` is the package's one dependency
  (1.64.1); both the full Chromium build and the headless shell
  (Chrome 156) are installed in this environment.

### Tests

9 new browser tests, **113 total, all passing; typecheck clean.**
The pre-existing 104 all still pass.

- Path unit tests (seeded RNG, so exact): a (0,0)→(300,200) path
  has 61 points, travels ~415 px against the 361 px straight line,
  deviates up to ~32 px off the line, overshoots ~24 px past the
  target, and its settle ends exactly on the target; different seeds
  trace different routes; a zero-distance path degenerates to one
  point; an explicit overshoot distance is honored; `pickPointInBox`
  stays inside the box and off dead-center.
- Live tests run a real headless Chromium against a fixture page
  served by a tiny in-test HTTP server. The page records every
  mousemove with a timestamp, the button's clicks, and an input:
  - The human click lands exactly once, inside the button; the
    recorded trail has dozens of points arriving over ≥100 ms of
    real time (a teleport would record ~one event at ~one instant),
    travels farther than the straight-line distance, and strays
    >2 px off the direct line.
  - Typing fills the input with the exact string, punctuation and
    all.
  - `currentUrl()` and `screenshot()` (real non-empty PNG) work.
  - A session relaunched on the same profile directory reads back
    the localStorage the first session wrote — profile persistence
    proven end to end across two browser processes.

### Real vs stubbed

- **Real (layer 1, prevention):** the persistent real profile, the
  curved overshoot-and-settle mouse, the randomized in-element click
  point, human press durations, per-key typing with thinking
  pauses — all exercised against a live browser above.
- **What comes next, deliberately absent here:**
  - Layer 2, the vision solver: our own solver on open vision
    models for the checks that still appear (built from scratch;
    AGPL solver repos stay avoided, per PLAN.md).
  - Layer 3, the handoff: pausing the task and tapping the user
    (mobile app / WhatsApp) when a check needs a human, with
    checkpoint-resume so the task never dies.
  - Page-level helpers beyond the session basics (scrolling into
    view before a click, frame support, multiple tabs) arrive with
    the Web Assistant work that consumes this package.

## 2026-10-22 — Phase 2 second piece: check detection + human handoff

**packages/browser — `detectCheck` + `waitForHuman`**

PLAN.md module 5 layers the checks **prevent → solve → hand off**,
and this piece builds the observation and pause that layers 2 and 3
both stand on. The doctrine holds unchanged: detection is
OBSERVATION only (reading page state, like eyes), and acting stays
human — real mouse/keyboard, no DOM tricks, no teleporting. Nothing
in this piece attempts to pass a check.

### The layer map, as it now stands

- **Layer 1, prevention (done, previous piece):** the persistent
  real profile and physically human input, so most checks never
  trigger.
- **Layer 3, handoff (this piece):** `detectCheck` notices a check
  that appeared anyway; `waitForHuman` pauses the task until a
  human clears it in the real browser, so a blocked task waits
  instead of dying.
- **Layer 2, the vision solver (still to come):** our own solver on
  open vision models. It is deliberately NOT built yet: it needs a
  vision model served through the Brain Router, and no real
  provider key exists in the project yet (BYOK keys are the user's
  pending side-work). When keys land, the solver plugs into exactly
  the seam built here — `detectCheck` finds and classifies the
  check, the solver acts on that typed result, and `waitForHuman`
  remains the fallback for anything the solver cannot or should not
  attempt. No placeholder solver is faked in the meantime.

### What was built

- **Check detection** (`src/checks.ts`) — `detectCheck(page)`
  returns `{ kind, evidence }` with kind `captcha` | `verify-wall` |
  `login-wall` | `none`. One in-page scan (a `page.evaluate` read;
  nothing is clicked, filled or dispatched) collects three signals,
  applied in precedence order so a concrete widget beats wall text
  (captcha pages often carry "verify" wording too):
  1. **Captcha widget:** a *visible* element (non-zero size, not
     `display:none`/`visibility:hidden`) whose `src`, `class` or
     `id` contains a captcha token (`recaptcha`, `hcaptcha`,
     `h-captcha`, `turnstile`, `challenges.cloudflare`, `arkose`,
     `funcaptcha`, `geetest`, or the generic `captcha`), or any
     visible element carrying a `data-sitekey` attribute. The
     always-present reCAPTCHA v3 badge is explicitly excluded — it
     sits on countless ordinary pages and is not a challenge.
  2. **Verification wall:** the page's rendered text, normalized
     (case, apostrophes, whitespace), contains a known phrase:
     "verify you are human", "checking your browser", "are you a
     robot", "prove you are human", "i'm not a robot", "just a
     moment", "unusual traffic", "security check", and kin.
  3. **Login wall (kept deliberately simple):** a visible password
     field together with a visible heading/link/button whose label
     contains "sign in" / "log in" / "login" / "sign-in". The
     detector cannot know whether the flow expected a live session,
     so this kind means "authentication is being requested here";
     the caller decides whether that is a blocker. Every heuristic
     and its false-positive risks are documented in the package
     README (captcha articles and demo widgets, quoted phrases,
     icon-only or non-English login buttons, image-only walls the
     text scan cannot see, and more).
- **Human handoff** (`src/handoff.ts`) — `waitForHuman(page,
  opts?)`, the layer-3 primitive. Polls `detectCheck` (defaults:
  5-minute timeout, 2 s interval; both configurable) until the
  page reads clear, resolving `{ cleared: true, waitedMs }`. A
  caller-supplied `isCleared(page)` may replace the "kind is none"
  test for pages where cleared means something more specific;
  detection still runs each poll so progress and errors stay
  informed. On timeout it throws a typed `HandoffTimeoutError`
  carrying the last detected check and the waited time. Progress
  fires through the optional `onPoll({ attempt, elapsedMs,
  check })` callback on every poll — that callback is the seam
  the future mobile push / UI hooks into to summon the human; no
  notifications are built here. A poll that cannot read the page
  (mid-navigation, which is exactly what a cleared check often
  causes) counts as "not cleared yet" and keeps the previous
  detection, with the timeout still bounding the wait.
  `waitForHuman` never attempts to solve the check itself.

### Tests

6 new tests in `packages/browser/test/checks.test.ts`, **119
total, all passing; typecheck clean.** The pre-existing 113 all
still pass. The tests serve fixture pages from a tiny in-test HTTP
server and run a real headless Chromium, like the earlier browser
tests:

- Detection: a page embedding a fake captcha iframe (local `src`
  carrying the `recaptcha` token) is detected as `captcha` with
  matching evidence; a "Verify you are human" page is a
  `verify-wall`; a password field with a sign-in heading and
  button is a `login-wall`; a plain content page returns `none`.
- Handoff success: the `/challenge` fixture shows a verify wall
  whose button a simulated human clears mid-wait through the
  package's own physical `click` (the fixture swaps the wall for
  clean content). `waitForHuman` (timeout 20 s, poll 200 ms)
  resolves `cleared: true` with a sane `waitedMs` (≥100 ms, far
  inside the timeout), and the `onPoll` stream shows the wall on
  the first poll and `none` on the last.
- Handoff timeout: the never-clearing captcha fixture with a
  short timeout (1.2 s, poll 200 ms, so the suite stays fast)
  rejects with `HandoffTimeoutError` whose `lastCheck.kind` is
  `captcha` and whose `waitedMs` covers the full timeout.

### Real vs stubbed

- **Real:** all three detection signals against a live browser,
  the typed results and evidence strings, the polling handoff
  with its timeout error and progress callback, and the
  unreadable-poll tolerance.
- **Absent by design:** the layer-2 vision solver (waiting on a
  vision model via the Router once BYOK keys exist — see the
  layer map above), and any notification on top of `onPoll` (the
  mobile app / WhatsApp tap summons the human in a later piece;
  the callback is where it will attach). Detection coverage is
  the documented heuristic set, not an exhaustive fingerprint of
  every vendor's challenge page.

## 2026-10-22 — Phase 3 first piece: the Memory Core

**packages/memory-core — `@skillforge/memory-core`**

PLAN.md's Memory Core, built to its design target: the assistant
remembers a lot but spends few tokens. Memory is stored cheaply and
in full; tokens are spent only at retrieval, where a strict budget
decides what enters the brain's context.

### What was built

- **Item model** (`src/types.ts`) — a `MemoryItem` is one terse,
  durable statement: `{ id, kind: "fact" | "preference" | "person" |
  "project" | "note", text, tags, importance (integer 1..5),
  createdAt, updatedAt, lastAccessedAt, accessCount, source? }`.
- **Stores** (`src/store.ts`) — a `MemoryStore` interface with
  `InMemoryMemoryStore` and `FileMemoryStore`, mirroring the
  Composer's JobStore split. The file store keeps one JSON per
  memory (`<dir>/<id>.json`, temp-file + rename writes, disk as
  source of truth), so a fresh instance over the same directory
  sees everything a previous one wrote, access bumps included:
  memories survive full process restarts.
- **Deduping add** — `add()` is the smart front door. Same kind +
  near-identical normalized text updates the existing item instead
  of duplicating it: refreshed `updatedAt`, higher importance wins,
  tags merge, existing id returned. Near-identical is defined in
  `src/text.ts`: normalized forms equal (case / punctuation /
  whitespace variants), or significant-token Jaccard similarity
  >= 0.8 (word-order variants). Deliberately conservative:
  "user likes tea" vs "user likes coffee" scores 0.5 and stays two
  memories. `save()` is the raw validated upsert compression and
  whole-item callers use; `get` / `list` (kind + case-insensitive
  tag filters) / `forget` (boolean) / `stats()` (counts by kind)
  complete the interface.
- **Token-budgeted retrieval** (`src/core.ts`) — `MemoryCore`
  wraps a store. Scoring is documented in the code and README:
  `score = 3 * overlap + 2 * (importance / 5) + recency`, where
  overlap is the fraction of the query's significant tokens found
  in the item's text or tags, and recency decays on `updatedAt`
  with a 30-day half-life. Zero-overlap items are never returned,
  however important; with overlap tied, importance's swing (1.6)
  always beats recency's (1.0), so a crucial old fact outranks a
  trivial new one. Admission is greedy in score order with
  skip-and-continue (an oversized top hit does not block smaller
  items behind it), `maxItems` caps the count, and the summed
  estimated cost never exceeds the budget. Returned items get
  access tracked (count + 1, `lastAccessedAt` set, persisted).
- **buildContext** — the low-token surface the brain will consume:
  retrieved items grouped under terse `## kind` headers in fixed
  kind order, one `- text` line each. Admission re-renders the
  whole string (headers included) per candidate, so the returned
  `estimatedTokens` NEVER exceeds the budget; only items actually
  included get access-tracked.
- **Compression** (`compress()`) — rule-based in v1: union-find
  clusters of near-duplicates (the same rule as `add`, so dupes
  seeded as raw files collapse too) merge into the strongest
  member, which keeps its id and text and takes the cluster's max
  importance, unioned tags, summed access counts, earliest
  `createdAt` and latest `lastAccessedAt`. Returns
  `{ merged, before, after }`. Nothing distinct is dropped or
  rewritten.

### Tests

32 new memory-core tests, **151 total, all passing; typecheck
clean.** The pre-existing 119 all still pass.

- Store: add defaults and clock-stamped times; validation (empty
  text, importance 0 / 6 / 2.5, bad kind); dedupe update
  (punctuation/case variant and word-order variant keep one item,
  higher importance, merged tags, refreshed `updatedAt`); no merge
  across kinds or between genuinely different texts; get/list
  filters; forget semantics; stats with zero counts; caller-
  mutation isolation; raw `save` upsert + validation.
- File store: restart survival across instances, dedupe and forget
  persisting across instances, access bumps persisting across
  instances, missing directory reads as empty.
- Retrieval: the formula pinned numerically (`3 + 2 + 2^-3` for a
  full-overlap importance-5 item 90 days old); a high-importance
  older fact beating a low-importance recent one; zero-overlap
  exclusion; tokenless queries returning nothing; budget
  enforcement in both shapes (skip-and-continue past an oversized
  top hit; exactly two 21-token lines inside a 45 budget);
  `maxItems`; file-store access persistence; forget removing an
  item from retrieval.
- buildContext: exact grouped output for a two-kind case,
  `estimatedTokens == estimateTokens(text) <= budget` with many
  400-char items, empty context for a 1-token budget and for no
  matches, access tracked only for included items.
- Compress: a 3-duplicate cluster merging with the documented
  survivor fields and `{ merged: 2, before: 5, after: 3 }`, a
  no-op on a clean store, and duplicates seeded as raw JSON files
  (legacy data) merging through the file store.

### Real vs stubbed

- Real: both stores, the dedupe rule, scoring, budgeted retrieval,
  context assembly with its hard budget guarantee, rule-based
  compression. Nothing in this piece is stubbed.
- The token budget is enforced against the documented ESTIMATE
  `ceil(chars / 4)` (the same heuristic the Router uses pre-call),
  not a real tokenizer count. Real tokenizers vary by model and
  text, so callers needing a hard per-model guarantee should
  leave headroom. Retrieval ranks with this estimate too.
- The model-summary seam is deliberately empty: model-written
  summaries plug into `compress()` behind the same
  `{ merged, before, after }` report shape when a summarizer is
  allowed to fold memories, so callers never change. Absent in
  v1 by design: no model call may silently rewrite what the user
  remembers.
- No consumer is wired yet: the Composer and the app shell do not
  read memory. That integration (brain loads a budgeted context
  per job) is a later piece; this package is the store, the
  ranking and the budget contract they will consume.

## 2026-10-22 — Phase 3 second piece: Automations

**packages/automations — `@skillforge/automations`**

PLAN.md module 7 ("daily 9am: post + report"), built decoupled from
the Composer: the engine owns WHEN, an injected runner owns WHAT,
and the two never import each other.

### What was built

- **Schedule model** (`src/types.ts`) — `{ id, name, enabled,
  trigger, job, catchUp, createdAt, lastRunAt?, lastResult?,
  lastStatus? }`. `job` is an opaque payload handed to the runner
  untouched (a Composer `JobDefinition` in production; anything in
  tests). `lastResult` carries the runner's returned string after a
  success, the thrown error's message after a failure, or
  `"skipped"` after a catch-up skip; `lastStatus` is the matching
  `"ok" | "error" | "skipped"` marker.
- **Triggers + pure math** (`src/schedule.ts`) — `nextRun(trigger,
  from)`:
  - `interval` (`everyMinutes`): `from + everyMinutes`.
  - `daily` (`at: "HH:MM"`): today at HH:MM in **host-local wall
    clock** when still ahead of `from`, else tomorrow; a `from`
    exactly at HH:MM counts as passed.
  - `once` (`at:` ISO): the timestamp while ahead of `from`, else
    null — a spent once never fires again.
  Validation (positive minutes, strict HH:MM, parseable timestamp,
  id charset, non-empty name) raises `ScheduleValidationError` from
  `nextRun`, the stores and `addSchedule` alike.
- **Anchor choice** — due times are `nextRun(trigger,
  lastRunAt ?? createdAt)`: every slot counts from the last
  *processed* run, so a schedule that falls behind fires ONCE per
  pass and re-anchors instead of burst-firing. The honest cost is
  drift: intervals are not on a fixed wall-clock grid.
- **Engine** (`src/engine.ts`) — `AutomationEngine` with an
  injectable clock (`now()`) and an injected runner (an object with
  `run(job, schedule)`, or a bare function; normalized internally).
  `tick()` processes enabled schedules in creation order, strictly
  sequentially, persisting each record right after its run. A
  throwing runner is caught per schedule, recorded as
  `lastStatus "error"` with the message, and never breaks the pass
  or the engine. Schedules are added / removed / enabled-disabled /
  listed through the engine (`setEnabled` throws
  `ScheduleNotFoundError` for unknown ids).
- **Catch-up** — `start()` runs one catch-up pass, and the first
  `tick()` on a fresh engine implies `start()` (documented in the
  README; `start()` is idempotent). In that pass a past-due
  schedule fires once when its `catchUp` is true (the default is
  false) and is skipped-but-advanced when false — a `"skipped"`
  record is persisted, which re-anchors it, so it resumes at its
  next real slot rather than firing late or sticking. Later ticks
  ignore `catchUp` entirely.
- **Stores** (`src/store.ts`) — an `AutomationStore` interface in
  the Composer `JobStore` mold: `InMemoryScheduleStore`
  (copy-in/copy-out) and `FileScheduleStore` (one JSON per schedule
  under a caller directory, temp-file + rename writes), both
  validating on save. Schedules and their run records survive full
  process restarts on the file store.

### Tests

30 new automations tests, **181 total, all passing; typecheck
clean.** The pre-existing 151 all still pass.

- nextRun (12): interval arithmetic; daily ahead / passed / the
  exact-HH:MM boundary / one-second-before / midnight rollover;
  once future / past / equal-to-anchor null; invalid minutes,
  malformed daily times ("9:00", "24:00", "12:60") and an
  unparseable once all rejected.
- Engine (12): interval firing under a fake clock with the payload
  and schedule verified in the runner's hands, re-anchoring (no
  immediate refire, fires again next interval); a bare-function
  runner; daily firing when the clock crosses HH:MM; one runner
  throwing while the other schedule still runs, the error recorded
  on the schedule, the engine unharmed on the next pass; disabled
  schedules (at creation and via `setEnabled`) never firing;
  unknown-id errors; catchUp true firing a missed daily once on
  start and still firing its next real slot; catchUp false
  skipping with a persisted "skipped" record and then firing
  normally at the next slot; catch-up applied by a bare first
  `tick()`; a once firing at its time and staying fired across a
  full restart (new engine + file store over the same directory,
  `nextDueAt` null); add validation; remove honesty.
- Stores (6): in-memory round-trip, caller-mutation isolation both
  ways, remove booleans; file-store persistence across instances
  over one directory (including a remove seen by the other
  instance) and missing-directory reads as empty; save-time
  validation in both stores.

### Real vs stubbed

- Real: the trigger math, the anchor and catch-up semantics, the
  engine pass with failure isolation, both stores, validation.
  Nothing in this piece is stubbed.
- The seam, deliberately: no Composer import anywhere. The shell /
  cloud injects the real runner — `run(job, schedule)` executing
  `job` as a Composer job definition and returning its status
  string. Notifications on completion hook in later on top of the
  `TickReport` each pass returns and the per-schedule run records;
  none are built here.
- No timer loop of its own: the host decides how often to call
  `tick()` (the engine is a pure function of clock + store, which
  is what makes the fake-clock tests exact). No cron expressions
  or timezone-pinned daily times; new trigger types slot into
  `nextRun` without touching the engine.


## 2026-10-22 — Phase 3 third piece: the Skill Forge mechanics

**packages/skill-forge — `@skillforge/skill-forge`**

PLAN.md module 2: "AI builds a NEW skill when a user asks for
something missing; saved forever, instant for everyone." The piece
built here is everything around the act of writing a spec — the
spec format, scaffolding, validation, registration, provenance,
rollback, removal and boot-time reload — all working today with
hand-written specs.

### What was built

- **SkillSpec** — a JSON-friendly object `{ id, name, description,
  input: { required, properties }, source }`. Ids are lowercase
  `namespace.name` (the built-ins' id space); property types are
  the five JSON-ish kinds (`string | number | boolean | object |
  array`), and every `required` entry must exist in `properties`.
  The spec maps onto the Skill Engine's `inputSchema` shape, so the
  registry's required-field validation covers forged skills too.
- **The source contract** — `source` is the TypeScript body of the
  run logic. The scaffolder wraps it verbatim in
  `async function __forgeRun(input, ctx) { ... }`: `input` and
  `ctx` are in scope, the source must `return` its result, and it
  declares no imports or exports (syntax errors in a function body,
  rejected at compile). V1 sources are pure computation over the
  input with the standard library — no Node builtins, no network.
- **The pipeline** — `forgeSkill(spec, registry, { store,
  samples?, now? })` runs four stages, each failing with a
  stage-tagged `ForgeError`: **validate** (structure + id unique
  against the registry) → **compile** (the scaffold transpiled via
  the repo's TypeScript `transpileModule`, diagnostics on; a syntax
  error fails with the compiler's own message and the source line)
  → **smoke** (caller-provided `{ input, expect? }` cases run
  against the compiled skill; `expect` deep-compares; a throw or a
  mismatch fails the forge) → **register**, which happens ONLY on
  full success and pairs the registry entry with a provenance
  record `{ id, spec, specHash, forgedAt }` (`specHash` = SHA-256
  of the spec's canonical, key-order-independent JSON).
- **Rollback** — nothing mutates before the register stage, and a
  failed record save undoes the registration (`registry.unregister`
  — the one additive method this piece added to the Skill Engine,
  a `Map.delete` wrapper, no existing behavior changed). Any failed
  forge leaves registry and store exactly as before; the tests
  prove it for the validate, compile, smoke and register stages.
- **Stores** — a `ForgeStore` in the house mold:
  `InMemoryForgeStore` and `FileForgeStore` (one JSON per skill,
  temp-file + rename writes, copy-in/copy-out). Records carry the
  full spec. The file store's `list()` skips files that do not
  parse as JSON, so a torn or foreign file cannot crash a boot.
- **unforge** — unregisters the skill and drops its record, and
  returns `false` for ids the forge never made: built-ins are
  never removed through the forge.
- **loadForged(registry, store)** — boot reload. Every record is
  re-validated and re-compiled (smoke cases are not stored, so
  they are not re-run) and re-registered; the report is
  `{ loaded, skipped: [{ id, reason }] }`. A record that no longer
  validates, no longer compiles, or whose id is already taken is
  skipped with its reason — never a crashed boot.

### Tests

15 new skill-forge tests, **196 total, all passing; typecheck
clean.** The pre-existing 181 all still pass.

- Happy path: `text.shout` forged from a hand-written spec with
  two sample cases runs through the registry (and the registry's
  own required-field check fires on `{}`); provenance recorded
  with the injected clock's `forgedAt` and the expected hash;
  `specHash` stable across field order, sensitive to content.
- Rejections, each with the registry and store proven untouched:
  eight malformed-spec shapes at the validate stage; duplicate id
  (against a forged skill and against a built-in); a syntax-error
  source and an import-bearing source at the compile stage with
  the compiler's message; a wrong-result and a throwing smoke case
  at the smoke stage; a store whose save throws, at the register
  stage, with the registration rolled back.
- unforge: removal proven (registry lookup, run → not-found,
  record gone), second call an honest `false`, the id forgeable
  again, and a built-in never removed.
- Restart: forged into a `FileForgeStore`, a brand-new registry +
  store over the same directory re-registers `text.shout` via
  `loadForged` and it still runs; a second load skips it as
  already registered, with the reason.
- Corruption: alongside the healthy record, a stored record whose
  spec's source was wiped (skipped, reason names the source), one
  whose source no longer compiles (skipped, reason carries the
  compiler message), and a non-JSON file (skipped by the store's
  `list()`) — the boot completes, the healthy skill runs.
- Store units: in-memory round-trip with caller-mutation isolation
  both ways; file store reads a missing directory as empty.

### Real vs stubbed

- Real: the spec format and its validation, the scaffold +
  transpile + in-process load, smoke execution with deep-compare,
  registration, provenance (hash + timestamp), rollback at every
  stage, both stores, unforge, and boot reload with
  skip-with-reason. Nothing in the pipeline is stubbed.
- **Trust model (stated plainly):** forged skills are FIRST-PARTY
  — written by our own AI under review, not arbitrary user code.
  A compiled spec runs in-process with the host's full privileges,
  exactly like a hand-written built-in; v1 has **no sandbox**. The
  small source contract (no imports, no Node builtins, pure
  computation) is a usability boundary, not isolation. The safety
  is procedural: validation, compile checks, smoke tests,
  provenance, instant unforge. A real sandbox is a hard
  precondition for the future community/marketplace step in
  PLAN.md, where specs would come from third parties.
- **The seam for AI generation:** the only missing piece is the
  spec AUTHOR. When BYOK keys exist, a generator behind the Brain
  Router produces a `SkillSpec` plus sample cases and calls
  `forgeSkill` — that call is the entire integration surface, and
  a bad generated spec fails the same typed stages a bad
  hand-written one does. Type errors in a spec's source are NOT
  checked (transpile-only, by design); full type-checking of
  generated specs can be layered into the compile stage later
  without changing the pipeline's shape.

## 2026-10-22 — Phase 3 integration: one product in the web shell

**apps/web — Memory Core + Automations + Skill Forge wired in**

The pieces built separately (Composer, Memory Core, Automations,
Skill Forge) are now assembled into ONE core that the web shell —
and every future surface — runs on. The shell stops being "skills +
jobs behind HTTP" and becomes the whole platform in one process.

### The assembled core (`apps/web/src/core.ts`)

- `createCore({ dataDir, registry? })` builds one shared instance
  set over the existing data dir (`SKILLFORGE_DATA_DIR` or `.data`):
  - `<dataDir>/jobs/` — `FileJobStore` + Composer (unchanged).
  - `<dataDir>/memory/` — `FileMemoryStore` + `MemoryCore`.
  - `<dataDir>/forge/` — `FileForgeStore`; **boot reload**:
    `loadForged` re-registers every stored forged skill into the
    registry at startup (report kept on the core; the direct-run
    entry logs loaded ids and skipped records with reasons).
  - `<dataDir>/automations/` — `FileScheduleStore` +
    `AutomationEngine`.
- Boot order is deliberate: registry → forge reload → Composer and
  engine over the shared registry, so a job or a schedule can call a
  forged skill from the very first tick.
- The AutomationEngine's runner is the seam the Automations package
  was built around: `schedule.job` is executed as a Composer
  `JobDefinition` through the shared Composer, and the runner
  returns a short string carrying the final job status (plus the
  recorded error when the job failed). A definition error throws
  out of the runner and the engine records it as that schedule's
  error — a broken schedule never breaks the engine or the shell.
- `core.tickAutomations()` wraps `engine.tick()` with an overlap
  guard: a slow pass never stacks a second pass on itself.

### New endpoints (same defensive body rules as the existing ones)

- `GET /api/memory?kind=&tag=` → items via the store's list filter
  (an unknown kind is a 400); `GET /api/memory/stats` → totals.
- `POST /api/memory { kind, text, tags?, importance?, source? }`
  → 201 with the item. This is the store's deduping `add`: a
  near-identical restatement updates the existing item (same id,
  higher importance wins, tags merge) instead of duplicating it.
  Validation failures are a clean 400 (`MemoryValidationError`).
- `DELETE /api/memory/:id` → `{ forgotten: true, id }`, 404 when
  the id is unknown.
- `GET /api/memory/context?q=&budget=` → `{ context,
  estimatedTokens }` from `MemoryCore.buildContext`; the budget is
  honored by the core's guarantee (returned estimate never exceeds
  it). A non-positive-integer budget is a 400.
- `GET /api/automations` → schedules, each with its computed
  `nextDueAt` (ISO, or null for a spent once) from
  `engine.nextDueAt`.
- `POST /api/automations { name, trigger, job, catchUp?, id?,
  enabled? }` → 201 with the created schedule view; trigger and
  schedule validation errors are a 400
  (`ScheduleValidationError`), a non-object `job` is a 400.
- `POST /api/automations/:id/enable` and `/disable` → the updated
  schedule view; unknown id 404 (`ScheduleNotFoundError`).
- `DELETE /api/automations/:id` → `{ removed: true, id }`, 404
  when unknown.
- `GET /api/forge` → forged-skill provenance records.
- `POST /api/forge { spec, samples? }` → 201 `{ skill, record }`.
  A `ForgeError` is a clean 400 carrying `{ error, stage,
  skillId? }` — the stage that rejected it (validate / compile /
  smoke / register) — and the forge's rollback guarantee means a
  failed forge leaves registry and store untouched.
- `DELETE /api/forge/:id` → unforge: `{ unforged: true, id }`;
  404 when the forge never made that id (built-ins included).

### Schedules actually fire

- `startWebShell` starts an interval calling
  `core.tickAutomations()`: default 30 s, overridable per shell
  (`automationIntervalMs` option) or by env
  (`SKILLFORGE_AUTOMATION_INTERVAL_MS`). Zero or negative disables
  it. The timer is `unref`'d and cleared by `close()`, so tests and
  shutdown stay clean; the in-process suites run with the interval
  disabled and fire passes directly through `tickAutomations()`.
- `createWebShell` is now async (it awaits the boot reload);
  `startWebShell`'s signature is unchanged.

### UI additions (same single page, same dark theme)

- **Memory panel** — kind selector + importance + text/tags form
  (Remember), the recent memories with per-item forget, and a
  context box: query + token budget → the assembled context with
  its estimated token count.
- **Automations panel** — schedules with enabled chip, trigger,
  next due and last run result, with enable/disable and delete per
  row; an add form for a daily job (name, time, skill picker fed
  from the shared registry, JSON input) that posts a one-step
  Composer job definition.
- **Forge panel** — forged-skill records with unforge per row, and
  a spec editor (a `text.shout` spec + smoke sample prefilled).
  Forging or unforging refreshes the Skills panel: forged skills
  live in the same registry, so they appear in the skill list, the
  run panel and the automation skill picker immediately.

### Tests

10 new integration tests in `apps/web/test/integration.test.ts`,
**206 total, all passing; typecheck clean.** The suite boots the
real shell in-process on an ephemeral port against a temp data
dir, with a forged `text.shout` record pre-seeded into the forge
store before boot:

- Boot serves the pre-seeded forged skill (14 skills listed), it
  runs over HTTP, and its provenance record lists via `/api/forge`.
- Memory: add + dedupe over HTTP (restatement keeps the id, takes
  the higher importance, merges tags; kind-filtered list and stats
  agree), invalid kind 400, context endpoint honoring a 12-token
  budget (exactly one of three zebra facts admitted, estimate
  within budget) and rejecting a non-numeric budget, forget by id
  with an honest 404 on the second forget.
- Automations: create → list (with `nextDueAt`) → disable → 404
  on an unknown toggle → delete → gone; invalid daily time 400;
  and the runner seam proven deterministically — a due catch-up
  schedule's slugify job executes through the shared Composer and
  records `lastStatus "ok"` with a result carrying `completed`.
- Forge: forge `text.yell` over HTTP with a smoke sample, run it
  through `/api/skills/:id/run`, unforge removes it from the
  skills list (run then 404s, second unforge 404s); a
  syntax-error spec returns 400 with stage `compile` and a
  duplicate id 400 with stage `validate`, both leaving the
  registry untouched.

Verified live as well: the compiled `dist/` server was booted on
a temp data dir (port 4413) — forged `text.shout` over HTTP (201,
spec hash recorded), ran it (`SMOKE TEST!`), added a memory,
fetched its context (12 estimated tokens), created a daily 09:00
automation whose job calls the forged skill (201, `nextDueAt`
computed), and listed everything back (14 skills, the forge
record, the memory, the schedule; files on disk under
`forge/`, `memory/`, `automations/`). Server stopped cleanly.

### Real vs stubbed

- Real: the assembled core and its boot order, every endpoint
  above, schedule firing while the shell runs, the three UI
  panels, persistence across restarts through the four file
  stores, and the compiled artifact (the smoke ran `dist/`).
- What remains, deliberately:
  - **Chat wiring on keys** — the shell's Composer still has no
    chat client, unchanged from Phase 1: a `kind: "chat"` step
    fails cleanly with that recorded. When BYOK keys land, the
    Brain Router plugs into the Composer in `createCore` (one
    place), and the same seam gives the Skill Forge its spec
    author (a model writing specs + samples into `POST /api/forge`
    or `forgeSkill` directly).
  - **The Electron desktop wrapper** (`apps/desktop`) — wraps
    this same core and HTTP surface on the user's machine; the
    folder still holds its placeholder.
  - **The mobile app** (`apps/mobile`) — the control tower
    (commands, handoff taps, reports) against this same API;
    also still a placeholder.
  - Automations fire only while a shell process runs; an
    always-on host (the cloud phase) is what makes schedules
    survive the user's machine being off.
  - Memory is consumed by the UI's context box and the API; the
    Composer does not yet inject a budgeted memory context into
    chat steps — that lands with the chat wiring above.


## 2026-10-22 — Phase 2/3 surface: the Desktop Assistant (`apps/desktop`)

**apps/desktop — `@skillforge/desktop`**

The Electron wrapper that turns the web shell into the Desktop
Assistant app from PLAN.md (desktop = device-side surface over the
same assembled core). The shell's API and data layout are unchanged;
this piece is purely the native frame around them.

### Architecture

- **Shell in-process, not a child process.** `src/main.ts` imports
  `startWebShell` from `apps/web/src/server.ts` by relative path —
  the house pattern, so tsc (rootDir = repo root) emits one
  self-contained `dist/` tree (`dist/apps/desktop/src/` beside
  `dist/apps/web/src/` and `dist/packages/`) that Electron's Node
  resolves directly. In-process was chosen because the import is
  side-effect free (the shell's CLI entry fires only when
  `process.argv[1]` is server.js itself, never under Electron) and
  `startWebShell({ port: 0, dataDir })` returns the two things a
  wrapper needs — the OS-assigned ephemeral port and a `close()`
  handle. The child-process alternative gives up both: the port
  would ride on scraping the child's stdout, and clean shutdown on
  scraping signals. The shell binds 127.0.0.1 only, as before.
- **Data location.** Everything the core persists (jobs, memory,
  forge records, schedules) goes under one dir: Electron's
  `userData` — the per-OS, per-user location a real install
  expects — passed to the shell as its `dataDir`. A
  `SKILLFORGE_DESKTOP_USER_DATA_DIR` env override retargets both
  Electron's own userData (`app.setPath`, before ready) and the
  shell's data dir together, so Chromium state and core data never
  split. Smoke runs and portable installs use it; real users never
  see it.
- **Pure config, tested without a GUI.** `src/config.ts` holds the
  decisions that need no Electron (data-dir resolution with the
  env override, the quit-after parse, build-tree paths for the UI
  dir and preload, the 1280x800 default window size). 7 unit tests
  in `apps/desktop/test/config.test.ts` pin them; the GUI itself
  stays out of vitest.
- **Security flags.** `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`. The preload is a
  hand-written CommonJS `preload.cjs` (a sandboxed preload cannot
  be ESM), copied beside the compiled main by
  `scripts/copy-assets.mjs`, which also copies `apps/web/public`
  to `dist/apps/web/public`, where the compiled shell serves its
  UI from. The preload exposes exactly one bridge value — a frozen
  `window.skillforgeDesktop = { appVersion }` — with the version
  handed over via `additionalArguments` (the documented channel;
  it lands in the preload's `process.argv`). No IPC, no Node, no
  Electron objects cross the bridge.
- **Lifecycle.** A single-instance lock: a second launch focuses
  the running window and exits without booting a shell. Closing
  the last window quits except on macOS (convention; `activate`
  recreates the window over the still-running shell). Quitting
  holds in `before-quit` until the shell server has closed (its
  automation timer cleared, connections drained), then proceeds.
  A `SKILLFORGE_DESKTOP_QUIT_AFTER_MS` env hook quits the app
  through that same clean path — it exists so headless smokes can
  prove the shutdown without a human clicking. Window-close
  hiding to a tray is deliberately OUT of scope; it is a future
  piece, not a stub.

### Packaging groundwork (config only)

- `electron` v45.0.0 and `electron-builder` 26.15.3 are
  devDependencies of the package. `npm start` builds and launches
  Electron; `npm run dist` is build + electron-builder.
- The `build` config in package.json: `appId`
  `dev.skillforge.app` (a placeholder until the product
  name/domain lock), `productName` "Skillforge", Windows target
  `nsis` (per-user, non-one-click), Linux target `AppImage`,
  output under `release/`.
- No installer has been built anywhere. That, plus code signing,
  macOS notarization, icons and auto-update, needs a real
  machine/CI and is deferred — the config is the groundwork, not
  a claim.

### Tests

7 new desktop tests, **213 total, all passing; typecheck clean**
(root tsconfig now includes `apps/desktop/src` + `test`, so the
root check covers the package). The pre-existing 206 all still
pass. The new tests are the pure config helpers only, per the
plan above.

### Verified live in this environment

- `ELECTRON_DISABLE_SANDBOX=1 electron --version` → v45.0.0 (the
  sandbox is disabled only because this VM runs as root; the same
  allowance the browser package already makes).
- A real headless launch under `xvfb-run` with a temp userData
  dir and the quit-after hook at 30 s. Observed, in order: the
  boot log's ephemeral port (34033 on that run); `GET
  /api/health` on that port answering `{"ok":true}`; a `POST
  /api/memory` round-trip whose JSON file then existed under
  `<userData>/memory/` — alongside Chromium's own profile files,
  proving both halves of the data dir landed together; the boot
  diagnostic `preload bridge appVersion=0.1.0`, proving the
  sandboxed preload ran and the bridge carries the real version;
  the main process still alive mid-run; and a clean self-quit —
  exit code 0 after the log's "shell closed, exiting", the
  before-quit shell-close path doing its job.
- Single instance: a second launch against the same userData
  while the first was running exited without ever logging a shell
  boot; the first instance was unaffected and later quit cleanly.

### Real vs stubbed

- Real: the in-process shell boot on an ephemeral port, the
  window and its hardening flags, the preload bridge, the
  userData data placement end to end (API write -> file under
  userData), single-instance behavior, and clean shutdown —
  all observed live above, not just read from the code.
- Deferred to a real machine/CI: installer builds (`.exe` /
  `.AppImage`) and everything around them (signing, notarization,
  icons, auto-update); a human-visible GUI run (this environment
  is headless — the Xvfb launch above is a real Electron window
  on a virtual display, observed through its port, its bridge
  and its files, not by eye); tray behavior (not built);
  device-control features of the Desktop Assistant (OS-level
  mouse/keyboard, app launching) — this piece is the wrapper and
  the shell inside it, nothing more.


## 2026-10-22 — Launch prep: publish-ready repository

The repo is now a clean, self-contained git repository with a first
commit, ready to push the moment a GitHub repo exists for it.

- **License:** the repo carries the **MIT License** (copyright Huzaifa
  Suleman) as the working choice for the open-source core. The final
  open-core license decision (plain MIT vs a BSL-style license for the
  future advanced tier) is still the user's to confirm before the
  public push — the LICENSE file can be swapped up to that moment.

### Ready now

- `.gitignore` — node_modules, dist/release/coverage output, `.data/`,
  `.env*`, logs, OS/editor junk, and `vendor/` (third-party clones are
  study material, never part of this repo). Verified with
  `git check-ignore` for `vendor/rea`, `node_modules` and a `dist`
  path.
- `README.md` — the public face: what Skillforge is, an honest v0.1
  status (what works today vs what is not in yet), the doctrine,
  quickstart (install, test, web shell, desktop app) and the layout.
- `LICENSE` — MIT, copyright Huzaifa Suleman.
- `.github/workflows/ci.yml` — on push/PR: Node 24, `npm ci`,
  Playwright Chromium install (`--with-deps`), `npm test`,
  `npm run typecheck`.
- `CONTRIBUTING.md` — setup, style (TypeScript strict, tests required
  for new behavior), and the two hard rules (no DOM driving / no mouse
  teleporting; rebuild behavior, never copy assets or code).
- First commit with repo-local identity (Huzaifa Suleman
  <huzaifasuleman100@gmail.com>): "Skillforge v0.1: platform core,
  shell, desktop wrapper". Working tree clean, 213 tests passing. No
  remote configured; nothing pushed anywhere.

### Remaining steps for publish day (exact)

1. **User confirms the final license choice** (MIT as committed, or
   BSL-style for the advanced tier) and the public repo name
   (Skillforge is a codename; the final name is still pending).
2. **User creates the empty GitHub repo** under `huzaifa973` (the
   Muse GitHub App cannot create repos) — no README/license added
   there, this repo already has both.
3. Add the remote and push:
   `git remote add origin git@github.com:huzaifa973/<repo>.git`
   then `git push -u origin main`.
4. Watch the first CI run go green on GitHub Actions.
5. Only after the push is public: the viral-launch sequence from
   PLAN.md (demo material, launch posts) — separate work, not part of
   this repo prep.

## 2026-10-22 — Voice stack: Kokoro out, faster-whisper in (`packages/voice`)

**packages/voice — `@skillforge/voice`**

PLAN.md's voice layer, proven end to end on this machine: free,
local engines only — **Kokoro-82M** for speech out and
**faster-whisper** for ears — behind one TypeScript interface, so
surfaces never talk to Python directly.

### Architecture

- The engines are Python. The TypeScript package defines the
  contract (`src/types.ts`): `VoiceEngine` with
  `synthesize(text, { voice? }) -> { wavPath, seconds }` and
  `transcribe(audioPath, { model? }) -> { text, language }`.
- `PythonVoiceEngine` (`src/python-engine.ts`) spawns the package
  venv's python on two small helpers and speaks one JSON line per
  call with them:
  - `python/tts.py --text ... --voice af_heart --out file.wav`
    (Kokoro `KPipeline`; the voice id's first letter picks the
    language pack) writes a 24 kHz mono WAV and prints
    `{ ok, out, seconds }`.
  - `python/stt.py --audio file.wav --model tiny` (faster-whisper,
    CPU int8) prints `{ ok, text, language }`.
  - A helper that exits non-zero, times out (10 min default; first
    runs download weights), cannot be started, or prints no valid
    result line surfaces as a typed `VoiceEngineError` carrying
    the helper name and the tail of its stderr — the real cause
    stays visible, nothing fails silently.
- Output names come from a pure helper (`src/filename.ts`):
  `tts-<slug>-<utc-timestamp>.wav`, slug built from the text
  (diacritics stripped, capped at a word boundary), so repeated
  syntheses never overwrite each other. The engine's work dir is
  configurable; python path and helpers dir are overridable (the
  tests use that to point at a fake executable).

### Setup and install footprint

- `python/setup.sh` creates `python/.venv` and installs the pinned
  `python/requirements.txt`: torch 2.13.0, kokoro 0.9.4,
  soundfile 0.14.0, faster-whisper 1.2.1, plus two compatibility
  pins explained in the file (av 15.1.0 — faster-whisper 1.2.1
  calls `av.open(..., metadata_errors="ignore")`, removed in PyAV
  19; en-core-web-sm 3.8.0 — the spaCy model misaki otherwise
  fetches on first English use). The script was run end to end
  after the environment existed: a clean idempotent pass.
- The venv is **5.5 GB** on disk. Honest accounting: most of that
  is CUDA library packages (cudnn, cublas, nccl, ...) that the
  PyPI torch wheel depends on. They sit unused — torch reports
  `2.13.0+cu130, cuda: False` and runs on CPU. The ~200 MB
  CPU-only wheel would avoid them, but its host
  (download.pytorch.org) timed out repeatedly from this VM across
  many retries while PyPI delivered at full speed, so PyPI is the
  recorded route; setup.sh documents the lighter alternative.
- Model weights live in the HuggingFace cache (**388 MB** total):
  hexgrad/Kokoro-82M **313 MB** (weights + the af_heart voice +
  config) and Systran/faster-whisper-tiny **75 MB**, both
  downloaded on first use.
- espeak-ng: Kokoro's English phonemizer runs on the
  `espeakng-loader` wheel inside the venv — synthesis is proven
  in this environment with **no system espeak-ng present**.
  setup.sh still attempts the apt install as a best-effort
  fallback (time-boxed, never fatal); from this VM apt is slow
  enough that the step timed out and the bundled loader carried
  the run, as designed.

### Round-trip evidence (real, run on this machine)

Source sentence: "Skillforge turns work into skills, and skills
into finished work."

- `tts.py` (voice af_heart) printed
  `{"ok": true, "out": ".../skillforge.wav", "seconds": 4.375}`.
  The WAV verified independently from its header: **210,044
  bytes, 24,000 Hz, mono, 16-bit, 105,000 frames = 4.375 s** —
  the helper's number and the file agree exactly.
- `stt.py` (model tiny) printed
  `{"ok": true, "text": "Skillforge turns work into skills and skills into finished work.", "language": "en"}`.
  Word overlap against the source: **10/10 tokens, 100%** (the
  only difference is the comma the recognizer does not emit).
- The same round trip was then driven through the TypeScript
  engine itself (real venv, not the fake): `synthesize` returned
  `{"wavPath":".../tts-skillforge-turns-work-into-skills-and-skills-<timestamp>.wav","seconds":4.375}`
  and `transcribe` on that file returned the same transcript and
  `language: "en"`. Warm-cache timing: both helper runs together
  took ~40 s wall on this 2-core VM, model loads included.
- The evidence was produced twice with identical results: the
  first run's artifacts sat in /tmp, which this VM wiped mid-work
  (a tmpfs reset that also rolled back an apt-installed
  espeak-ng); everything durable (venv, model cache) lives on the
  home disk and survived, and the regenerated WAV is byte-size
  identical (210,044 bytes).

### Tests

15 new voice tests, **228 total, all passing; typecheck clean.**
The pre-existing 213 all still pass.

- `test/filename.test.ts` (9): slug rules (punctuation,
  diacritics, separator collapsing, empty fallback), the
  word-boundary length cap, UTC timestamp formatting and
  zero-padding, filename composition and fallback.
- `test/python-engine.test.ts` (6): the engine against a FAKE
  python (a tiny shell script emitting canned JSON that echoes
  back the `--out` it was handed) — exact argv for synthesize
  and transcribe (script, flags, defaults af_heart / tiny, the
  workDir output path), JSON parsing into the typed results, a
  failing helper (exit 3) surfacing as `VoiceEngineError` with
  its stderr tail, and a missing executable surfacing the same
  way. The real-engine proof above is deliberately NOT in the
  suite: it needs the venv and downloaded models, so it was run
  once as a temporary test, evidenced here, and removed.

### Real vs stubbed

- Real: both helpers against the real models, the engine's
  process driving, JSON contract and error surfacing, the
  filename helper, the pinned setup. The round trip above ran
  on this machine, twice.
- Stubbed/absent by design:
  - **Chatterbox is not installed.** Voice cloning, emotion and
    its 23 languages are future work; Kokoro is the v1 voice,
    and voice selection is limited to Kokoro's voice list (the
    `voice` option passes through unvalidated — a bad id
    surfaces through Kokoro's error in the stderr tail).
  - **Multilingual is unproven locally.** The only synthesis
    and transcription proven here is English. Broader language
    support rests on faster-whisper's and Chatterbox's
    documented language coverage, not on a local run.
  - No streaming synthesis or playback, and no wiring into the
    web shell or the Electron desktop app yet — surfaces
    consume `VoiceEngine` in a later piece. The shell remains
    the integration point, as with the other packages.
  - `.gitignore` gained a Python section (`.venv/`,
    `__pycache__/`, `*.pyc`) so the 5.5 GB venv can never be
    committed by accident (`git check-ignore` verified).

## 2026-10-24 — Phase 3 integration: budgeted memory context in the Composer

**packages/composer — chat steps now receive Memory Core context**

This closes the gap recorded in the Phase 3 integration entry
("the Composer does not yet inject a budgeted memory context into
chat steps"). The Composer half is built and tested now, ahead of
the chat wiring it was paired with: the injection lives behind the
existing `ChatClient` seam, so the moment a real chat client plugs
in, memory comes with it — no Composer changes needed then.

### What was built

- **A minimal memory surface, house style** (`src/types.ts`) —
  `MemoryContextSource`: one method,
  `buildContext(query, { tokenBudget? }) -> { text }`. The Composer
  already depends on minimal structural interfaces (`SkillRunner`,
  `ChatClient`) instead of sibling packages; memory follows the
  same pattern, and `MemoryCore` from `@skillforge/memory-core`
  satisfies the shape structurally. No new package dependency, no
  new tsconfig/vitest alias.
- **The injection** (`src/composer.ts`) — two new options:
  `memory` (the source) and `memoryTokenBudget` (default
  `DEFAULT_MEMORY_TOKEN_BUDGET` = 800, matching the Memory Core's
  own default). For each chat step, after template resolution, the
  Composer derives the query from the job's title plus the step's
  resolved message contents — the same text the model is about to
  read, so a step referencing an earlier step's output retrieves
  memory about that output. A non-empty result is prepended as one
  `system` message: the Memory Core's `## kind` grouped rendering
  bracketed by the exported delimiters `MEMORY_CONTEXT_OPEN`
  (`[Relevant memory — retrieved from long-term memory for this
  task]`) and `MEMORY_CONTEXT_CLOSE` (`[End of relevant memory]`),
  so the model — and any surface displaying the exchange — can
  tell retrieved long-term memory from the job's own messages.
- **Runtime-only, never persisted.** The stored job definition
  keeps the author's messages untouched; a resumed step re-derives
  its context from memory as it then stands. The Memory Core's
  budget guarantee covers the section body (its estimated tokens
  never exceed the budget); retrieved items get their access
  tracked by the core, as with any `buildContext` call.
- **Enrichment, never a dependency.** No source configured, an
  empty store, zero-overlap memory, a budget too small for any
  item, or a lookup that throws — every one leaves the step's
  messages exactly as defined: no empty section, and a broken
  memory store never fails a job. Skill steps are untouched (they
  have no prompt surface to inject into).
- **Shell wiring** (`apps/web/src/core.ts`) — `createCore` now
  passes its shared `MemoryCore` into the Composer it assembles,
  so jobs and automation-runner jobs in the shell get the context
  automatically once a chat client exists. No endpoint or behavior
  change today (the shell still has no chat client).

### Tests

9 new tests in `packages/composer/test/memory-context.test.ts`,
**237 total, all passing; typecheck clean.** The pre-existing 228
all still pass. Tests drive a real `MemoryCore` over an
`InMemoryMemoryStore` (seeded through its deduping `add`), a
recording `ChatClient` stub, and one real Router + MockProvider:

- Injection: a relevant fact + preference are prepended as a
  delimited system message (open/close markers, `## fact` before
  `## preference`), an irrelevant note is excluded, the step's own
  message follows byte-identical, and the persisted definition
  keeps exactly the author's one message.
- Ordering: within one kind, the high-importance full-overlap fact
  renders ahead of the low-importance partial-overlap one.
- Budget: three kestrel facts under a 20-token budget admit only
  the top-ranked one, and the extracted section body measures
  `estimateTokens <= 20`; under a 200 budget all three are in.
- Query derivation: a chat step saying "Write a summary for
  {{make-slug.slug}}" retrieves the Frankfurt fact — the query ran
  on the resolved slug text, not the raw template.
- End to end through a real Router + MockProvider: the provider's
  recorded messages carry the memory system message first.
- No-ops, each asserting the messages arrive exactly as defined:
  empty store, memory with nothing relevant (no empty section),
  and no memory source configured at all.
- Failure isolation: a memory source whose `buildContext` throws
  still completes the job with the original messages.

### Real vs stubbed

- Real: the query derivation, the budgeted retrieval through the
  actual Memory Core (scoring, budget guarantee, access tracking),
  the delimited injection, the no-op and failure-isolation
  semantics, and the shell's core wiring. Nothing in this piece is
  stubbed.
- Still absent, unchanged from before: a real chat client in the
  shell (BYOK keys pending), so no live model has yet received an
  injected context — the path is proven against the Router +
  MockProvider and the recording stub, and the shell needs no
  further Composer work when keys land.
- The budget is the Memory Core's documented estimate
  (`ceil(chars / 4)`), and it binds the section body; the two
  delimiter lines add a fixed ~20 estimated tokens on top, outside
  the budget — callers needing a hard whole-message cap should
  leave that much headroom.
