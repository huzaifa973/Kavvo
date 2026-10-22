import { join } from "node:path";

/**
 * Pure desktop-shell configuration: every decision the Electron main
 * process makes that does NOT need Electron itself lives here, so it
 * can be unit-tested without a GUI. main.ts feeds these helpers the
 * real values (env, Electron's userData path, the compiled module
 * dir) and acts on what they return.
 */

/** Env override for the data dir (smoke tests, portable runs). */
export const USER_DATA_ENV = "SKILLFORGE_DESKTOP_USER_DATA_DIR";

/**
 * Env smoke hook: when set to a positive number of milliseconds, the
 * app quits itself that long after boot. Exists so headless CI/smoke
 * runs can exercise a genuinely clean quit (shell server closed via
 * the normal before-quit path) without a human clicking anything.
 */
export const QUIT_AFTER_ENV = "SKILLFORGE_DESKTOP_QUIT_AFTER_MS";

/** Default BrowserWindow size. */
export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 800 } as const;

/**
 * Where the shell's data (jobs, memory, forge, automations) lives.
 * The env override wins when set to a non-blank value; otherwise the
 * OS-appropriate per-user location Electron reports as userData.
 */
export function resolveUserDataDir(
  envValue: string | undefined,
  electronUserData: string,
): string {
  const trimmed = envValue?.trim();
  return trimmed ? trimmed : electronUserData;
}

/**
 * Parse the quit-after smoke hook. Anything that is not a positive
 * finite number means "do not auto-quit" (undefined).
 */
export function parseQuitAfterMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

/**
 * The shell's static UI dir inside the desktop build tree. tsc emits
 * the compiled web shell to dist/apps/web/src/ (rootDir is the repo
 * root, the same self-contained-tree trick apps/web uses), and the
 * desktop build copies apps/web/public to dist/apps/web/public — so
 * from the compiled main (dist/apps/desktop/src/) the UI sits at
 * ../../web/public.
 */
export function resolvePublicDir(mainModuleDir: string): string {
  return join(mainModuleDir, "..", "..", "web", "public");
}

/**
 * The preload script's path. It is a hand-written CommonJS file (a
 * sandboxed preload cannot be ESM), copied next to the compiled
 * main by the desktop build.
 */
export function resolvePreloadPath(mainModuleDir: string): string {
  return join(mainModuleDir, "preload.cjs");
}
