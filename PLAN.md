# Skillforge — Master Plan (codename; user to confirm name)
Created 2026-10-21. Owner: Huzaifa Suleman. Builder: Graze.

## The idea in one line
One AI platform that DOES work instead of browsing for it — skill-first agent, real-human browser, layered check handling, one brain across everything. "OpenClaw browses. Ours just does it." / "Other agents get blocked. Ours finishes."

## Name (proposed)
- Primary: **Skillforge** — skills are forged/added; dev-respectable, global.
- Alternates: Unblockd (the anti-block wedge), Karo ("do it").
- Tagline: "The agent that just does it."

## What goes inside (every module)
1. **Skill Engine (the heart)** — native skills do small work instantly, no web pages.
   Launch set (~20): media converters (audio/video/image — DollarWise ffmpeg.wasm engines),
   PDF tools, background remover, summarizer, translator, writer/reply drafter, data/table
   cleaner, web researcher, form filler, social poster, inbox triager, job applier,
   screenshot/recording tools, file organizer.
2. **Skill Forge** — AI builds a NEW skill when a user asks for something missing; saved
   forever, instant for everyone. Community skills + (later) a skill marketplace.
3. **Agent Composer (brain)** — chains skills for big jobs ("PDF -> video -> post it"),
   checkpoint + resume on every task, remembers user files/prefs/brand.
4. **Brain Router** — our own original router code inside the product; users plug
   their OWN free keys (BYOK) + local Ollama support. Platform inference cost = $0
   at any scale. (FreeLLMAPI removed entirely, user directive 2026-10-22: not used
   for building, not shipped in the product.)
5. **Real-Human Browser** — used only when a task truly needs the web. Drives like a
   person: Ghost Cursor (MIT) real mouse paths (Bezier, overshoot/correct), humanized
   typing, user's REAL browser + logged-in sessions. NO DOM/code shortcuts.
   Checks in 3 layers: prevent (real session + human behavior) -> solve (own vision-model
   solver on open VLMs; build our own, avoid AGPL solver repos) -> WhatsApp tap handoff.
6. **Studio (module 2)** — AI image/video generation + editor (Higgsfield/Clipchamp corner).
7. **Automations (module 3)** — schedules + triggers ("daily 9am: post + report").
8. **Mobile App Remote** — our own mobile app is the control tower (commands, handoff
   tap push notifications, voice, reports). WhatsApp is only an optional extra channel,
   never the primary (user directive 2026-10-21).
9. **Vault** — user logins/keys encrypted on their own device. Trust feature.
10. **Demand Board (user directive 2026-10-21)** — built-in feature-request system:
    users tell us what they need/want added; requests are public, others upvote and
    comment. Top-voted requests feed the Skill Forge queue (most-wanted skill gets
    forged next) and a public roadmap shows planned / in-progress / shipped. This is
    the community flywheel: users ask -> we forge -> they bring more users.

## Build method
- REA (morluto/rea, MIT) studies target-app features -> AI rebuilds them ORIGINAL.
  Legal line: rebuild behavior, never copy brand/assets/exact design.
- Graze builds everything directly. No third-party router anywhere in the stack:
  the product's Brain Router is original code written for this platform.

## Strategy (user directives 2026-10-21)
1. **Open source first** — early versions public on GitHub (user's account huzaifa973;
   he creates the repo — Muse GitHub App cannot). License chosen deliberately at setup
   (MIT core vs BSL-style protection — decide before first push).
2. **Go viral** — GitHub stars flywheel, demo videos, Product Hunt, Hacker News,
   "free alternative to X" SEO via DollarWise (1,488 pages), build-in-public on socials.
3. **Then close the advanced version** — core stays open; advanced/cloud goes closed:
   hosted always-on agent, pro skill packs, team features, Studio Pro.
4. **Host only after viral** — cloud tier launches on user's hosting once demand is
   proven (waitlist/stars), so hosting money is spent only when it returns.

## Money (closed phase) — model locked 2026-10-21
- **BYOK + hosting is the core.** Local app free forever (user's own keys). Cloud =
  hosting subscription (user's own keys on our always-on servers) via Paddle ->
  Payoneer (Pakistan-compatible). Zero inference cost, zero key-ban risk, all margin.
- NEVER serve customers on free-tier keys (personal-use terms — illegal + one ban kills
  the platform). Paid-key "we provide everything" only as a LATER add-on:
  managed credit packs on proper paid API plans, priced with margin + hard limits,
  never unlimited (heavy users / abuse / rate limits land on us otherwise).
- Skill marketplace cut (later). AppSumo lifetime deal at cloud launch.
- Math anchor: 1,000 users x $5/mo = $5,000/mo.

## Endpoint Rules Engine (user directive 2026-10-21 — "very important")
- All agentic work follows each provider endpoint's rules: per-key rate limits and
  quotas tracked, exponential backoff, failover to the next key/model INSTEAD of
  retry-hammering, per-provider policy flags (what each endpoint allows).
- Purpose: keys and accounts stay alive; no bans, no burned quotas. This layer sits
  between the Brain Router and every provider — nothing calls an endpoint directly.

## Three surfaces, one brain (user directives 2026-10-21)
- **Desktop Assistant** — runs on the user's PC, HANDLES THE DEVICE: opens apps,
  OS-level mouse/keyboard, files, system actions, local models (Ollama). Full power.
- **Web Assistant** — runs in the browser/cloud; handles web work (research, pages,
  accounts via the Real-Human Browser). Device control limited/absent by design —
  the honest split: web = reach, desktop = control.
- **Mobile App (our OWN app — user directive 2026-10-21)** — the control tower:
  users command their desktop/cloud agent from our own mobile app, receive handoff
  taps (push notifications), voice control, live task view + reports. NOT dependent
  on WhatsApp or other chat extensions as the primary channel (WhatsApp may stay
  as an optional extra). Own app = brand on the phone + reliable push for taps.
- Same skills, same memory, same voice — one identity across desktop, web, mobile.

## Memory Core (user directive 2026-10-21)
- Strong long-term memory: user facts, preferences, files, people, project history.
- Low token consumption, high-level outputs: memory is compressed/summarized and
  RETRIEVED selectively (only what the task needs enters context) instead of raw
  history dumps. Cheap runs, smart answers.

## Voice + Interface (user directive 2026-10-21)
- Jarvis-style voice layer: voice in/out, swappable voices, voice cloning support.
- **Ears (transcription):** faster-whisper (Whisper large) — free, local, multilingual
  (~99 languages). Advanced transcriptor, zero per-minute cost.
- **Voice out (ElevenLabs-quality but FREE — user directive 2026-10-21):**
  - Default: **Kokoro-82M** (Apache-2.0) — tiny, runs on CPU, natural voices, fast.
  - Cloning + multilingual + emotion: **Chatterbox** (Resemble AI, MIT) — zero-shot
    clone from ~5s of audio, 23 languages, emotion/paralinguistic tags; beat
    ElevenLabs in blind tests. Alternate: Qwen3-TTS (Apache-2.0, 3s cloning).
  - AVOID XTTS-v2 in the commercial product (Coqui license = non-commercial).
  - All local/self-hosted = $0 per character forever; ElevenLabs remains available
    as a BYOK option for users who bring their own key.
- Highly aesthetic interface with a theme system (themes changeable per user).

## Build order
- Phase 0: setup — install REA, create repo, confirm name/domain.
- Phase 1 (v0.1): shell + brain router + skill engine + first ~20 skills + composer.
- Phase 2 (v0.2): real-human browser + check layers + WhatsApp remote.
- Phase 3 (v0.3 -> v1.0): skill forge, Studio, automations.
- Phase 4: viral launch push.
- Phase 5: closed advanced version + hosted cloud.

## User provides
Domain, repo creation, launch accounts/taps, hosting (phase 5). Graze builds everything else.
