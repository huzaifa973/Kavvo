# @skillforge/desktop — the Desktop Assistant app

An Electron wrapper around the web shell (`apps/web`). It boots the
shell **in-process** on an ephemeral localhost port and shows it in a
hardened BrowserWindow, with every byte of app data (jobs, memory,
forge records, schedules) persisted under Electron's `userData` dir —
the per-OS, per-user location a real install expects.

## Run it

```bash
npm install          # once, at the repo root (links the workspaces)
cd apps/desktop
npm start            # builds (tsc -> dist/ + asset copies), then launches Electron
```

Environment:

- `SKILLFORGE_DESKTOP_USER_DATA_DIR` — overrides both Electron's
  `userData` and the shell's data dir. For smoke tests and portable
  runs; unset, data lives in the OS default (e.g.
  `~/.config/@skillforge/desktop` on Linux).
- `SKILLFORGE_DESKTOP_QUIT_AFTER_MS` — smoke hook: when set to a
  positive number, the app quits itself that many ms after boot,
  through the normal clean-quit path (shell closed first).
- The shell's own env still applies where relevant (the automation
  tick interval defaults to 30 s, as in `apps/web`).

## How it is put together

- `src/main.ts` imports `startWebShell` from the web shell's source
  by relative path, the house pattern: tsc (rootDir = repo root)
  emits one self-contained `dist/` tree — `dist/apps/desktop/src/`
  beside `dist/apps/web/src/` and `dist/packages/` — that Electron's
  Node resolves directly. Importing the shell module has no side
  effects (its CLI entry only fires when it is `process.argv[1]`),
  and `startWebShell({ port: 0, dataDir })` returns the bound port
  and a `close()` handle, so quitting the app closes the server
  cleanly from the `before-quit` handler. (The alternative — running
  the shell as a child process — was rejected: the ephemeral port
  and shutdown would ride on scraping the child's stdout.)
- `src/config.ts` holds the pure decisions (data-dir resolution,
  quit-after parsing, build-tree paths, window size) with no
  Electron imports, so vitest covers them without a GUI.
- `preload.cjs` is hand-written CommonJS — a sandboxed preload
  cannot be ESM — and exposes exactly one value to the page via the
  context bridge: a frozen `window.skillforgeDesktop = { appVersion }`.
  The version reaches the preload through `additionalArguments`.
  The build (`scripts/copy-assets.mjs`) copies it next to the
  compiled main, and copies `apps/web/public` to
  `dist/apps/web/public`, where the compiled shell serves its UI.

## Security posture

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
The page has no Node access and no Electron surface beyond the
frozen version value above. The shell binds 127.0.0.1 only, on an
OS-assigned ephemeral port, and stays unauthenticated exactly like
the web shell — it is a local app, not a hosted service.

Other behavior: a single-instance lock (a second launch focuses the
running window and exits); closing the last window quits except on
macOS (convention), where the shell stays alive and `activate`
recreates the window. Window-close-to-tray is deliberately NOT
implemented yet.

## Packaging: configured vs proven

Configured in `package.json` (`build` key, electron-builder 26):

- `appId` `dev.skillforge.app` — a PLACEHOLDER until the product
  name/domain lock; `productName` `Skillforge`.
- Windows target `nsis` (per-user, non-one-click), Linux target
  `AppImage`, output to `release/`, `npm run dist` wired as
  build + electron-builder.

NOT proven anywhere yet: no installer has been built. Producing a
real `.exe`/`.AppImage` needs a run of `npm run dist` on a suitable
machine/CI (Windows target realistically on Windows or a CI image
with the right tooling), plus everything this config deliberately
leaves out: code signing, macOS notarization, icons, auto-update.
Electron itself (v45) is a devDependency; `electron --version` and
a real headless launch under Xvfb were verified in the dev
environment — see BUILD-LOG.md for exactly what was observed.
