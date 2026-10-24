# Contributing to Kavvo

Thanks for helping build the agent that just does it. This guide is short
on purpose — the codebase and its tests are the long version.

## Getting set up

```bash
npm install                          # repo root; npm workspaces
npx playwright install chromium      # once, for the browser tests
npm test                             # full vitest suite
npm run typecheck                    # strict TypeScript, whole repo
```

Node 24 is the development baseline. Everything runs from the repo root;
tests execute against package sources, so there is no build step before
`npm test`.

## Code style

- **TypeScript strict** everywhere. `npm run typecheck` must be clean —
  no `any` escapes, no suppressed errors without a comment saying why.
- **Tests are required for new behavior.** If you add it, a test proves
  it; if you change behavior, the tests change with it. Bug fixes land
  with a regression test. The suite boots real servers and a real
  Chromium where the package under test does — follow the existing
  patterns in the package you are touching.
- **Errors are typed and honest.** Failures surface as typed errors with
  the cause recorded (see the Router's attempt log, the Composer's job
  state, the Forge's staged `ForgeError`) — never swallowed, never faked
  into a success.
- **Secrets never touch disk or logs.** Provider keys are BYOK: they are
  resolved at call time, passed to the adapter, and redacted out of any
  error text. If your change can see a key, it must not print one.
- **Persistence is file-backed and atomic** (temp-file + rename), in the
  mold of the existing stores. If you add a store, match that pattern.

## Two hard rules

1. **The browser is driven like a real person — no exceptions.** The
   cursor physically travels along curved paths and clicks in real
   time; typing goes key by key. Never act through the DOM (no
   `element.click()` or setting values via injected JavaScript), and
   never teleport the mouse. Reading page state is observation and is
   fine; acting is always physical. See `packages/browser` and its
   README before touching anything browser-shaped.
2. **Rebuild behavior, never copy.** Features inspired by other apps
   are re-implemented from observed behavior in original code. No
   copied source, assets, branding or exact screen layouts — from any
   app, ever.

## Before you open a PR

- `npm test` passes and `npm run typecheck` is clean.
- New behavior has tests; changed behavior has updated tests.
- User-facing claims stay honest: if it is stubbed, planned or
  unverified against a live service, say so in the code and the docs,
  the way `BUILD-LOG.md` does.
