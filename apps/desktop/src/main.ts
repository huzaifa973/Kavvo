import { app, BrowserWindow } from "electron";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The web shell is imported in-process, by relative path, exactly
// like the shell itself imports the core packages: tsc then emits
// one self-contained dist/ tree (dist/apps/web/... +
// dist/packages/... beside dist/apps/desktop/...) that Electron's
// Node resolves directly. Importing server.js is side-effect free —
// its direct-run entry only fires when process.argv[1] IS server.js,
// which under Electron is the desktop entry, never the shell — and
// startWebShell hands back the bound port and a close() handle,
// which a child process would only give us by scraping stdout.
import {
  startWebShell,
  type RunningWebShell,
} from "../../web/src/server.js";
import {
  DEFAULT_WINDOW_SIZE,
  QUIT_AFTER_ENV,
  USER_DATA_ENV,
  parseQuitAfterMs,
  resolvePreloadPath,
  resolvePublicDir,
  resolveUserDataDir,
} from "./config.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | undefined;
let shell: RunningWebShell | undefined;
let shellCloseStarted = false;

// All app data (jobs, memory, forge records, schedules — everything
// the core persists) lives in ONE dir: Electron's userData, the
// per-OS per-user location a real install expects. An env override
// (smoke tests, portable runs) retargets both Electron's own
// userData and the shell's data dir, so Chromium state and core data
// stay together. setPath must happen before the app is ready.
const dataDir = resolveUserDataDir(
  process.env[USER_DATA_ENV],
  app.getPath("userData"),
);
if (dataDir !== app.getPath("userData")) {
  app.setPath("userData", dataDir);
}

async function boot(): Promise<void> {
  // Port 0: the OS assigns an ephemeral localhost port. Nothing else
  // on the user's machine can collide with it, and the shell still
  // binds 127.0.0.1 only — this is a local app, not a service.
  shell = await startWebShell({
    port: 0,
    host: "127.0.0.1",
    dataDir,
    publicDir: resolvePublicDir(moduleDir),
  });
  console.log(
    `kavvo desktop: shell listening on ${shell.url} (data dir: ${shell.dataDir})`,
  );
  createWindow(shell.url);

  const quitAfterMs = parseQuitAfterMs(process.env[QUIT_AFTER_ENV]);
  if (quitAfterMs !== undefined) {
    console.log(
      `kavvo desktop: ${QUIT_AFTER_ENV} set — quitting in ${quitAfterMs}ms`,
    );
    const timer = setTimeout(() => app.quit(), quitAfterMs);
    timer.unref();
  }
}

function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: DEFAULT_WINDOW_SIZE.width,
    height: DEFAULT_WINDOW_SIZE.height,
    webPreferences: {
      preload: resolvePreloadPath(moduleDir),
      // Hardened by default: the page gets no Node, no direct
      // Electron access, and an isolated context whose only bridge
      // is the preload's frozen { appVersion } value.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The documented channel for handing the preload one value:
      // it arrives in the preload's process.argv.
      additionalArguments: [`--kavvo-app-version=${app.getVersion()}`],
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  void mainWindow.loadURL(url);
  // Boot diagnostic: proves the preload ran and the bridge carries
  // the real app version before any page code could interfere.
  mainWindow.webContents.once("did-finish-load", () => {
    void mainWindow?.webContents
      .executeJavaScript(
        "typeof window.kavvoDesktop === 'object' ? window.kavvoDesktop.appVersion : 'missing'",
      )
      .then((version: unknown) => {
        console.log(`kavvo desktop: preload bridge appVersion=${String(version)}`);
      })
      .catch((err: unknown) => {
        console.error("kavvo desktop: preload bridge check failed", err);
      });
  });
}

// Single instance: a second launch focuses the running window
// instead of starting a second shell over the same data dir.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app
    .whenReady()
    .then(boot)
    .catch((err: unknown) => {
      console.error("kavvo desktop: boot failed", err);
      app.quit();
    });

  app.on("window-all-closed", () => {
    // macOS convention: the app (and its shell) stay alive until
    // the user quits explicitly; everywhere else, closing the last
    // window is quitting.
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (shell && !mainWindow) createWindow(shell.url);
  });

  // Clean shutdown: hold the quit until the shell server has closed
  // (its automation timer cleared, connections drained), then quit
  // for real. The flag makes the re-entrant before-quit a pass-through.
  app.on("before-quit", (event) => {
    if (!shell || shellCloseStarted) return;
    event.preventDefault();
    shellCloseStarted = true;
    const running = shell;
    shell = undefined;
    running
      .close()
      .catch((err: unknown) => {
        console.error("kavvo desktop: shell close failed", err);
      })
      .finally(() => {
        console.log("kavvo desktop: shell closed, exiting");
        app.quit();
      });
  });
}
