// Browser session: a persistent Chromium profile.
//
// Layer 1 of the check-handling doctrine is prevention, and prevention
// starts here: the agent works in the user's REAL browser profile, so
// logins, cookies and history persist between runs in `profileDir`,
// exactly as if the person opened their own browser. Nothing is faked
// in the page — the session is a real browser with a real profile, and
// the human mouse/keyboard modules do the acting inside it.

import { chromium, type BrowserContext, type Page } from "playwright";

export interface LaunchSessionOptions {
  /** Directory holding the persistent browser profile (created if absent). */
  profileDir: string;
  /** Defaults to true; pass false to watch the browser work. */
  headless?: boolean;
  /** Extra Chromium launch arguments, appended after the defaults. */
  args?: string[];
}

export class BrowserSession {
  /** The underlying Playwright context, for advanced callers. */
  readonly context: BrowserContext;
  /** The session's working page. Drive it with the mouse/typing modules. */
  readonly page: Page;
  /** The profile directory this session persists to. */
  readonly profileDir: string;

  private constructor(context: BrowserContext, page: Page, profileDir: string) {
    this.context = context;
    this.page = page;
    this.profileDir = profileDir;
  }

  static async launch(options: LaunchSessionOptions): Promise<BrowserSession> {
    const args = [...(options.args ?? [])];
    // Chromium's sandbox cannot initialize as root (containers, VMs).
    // Detect it and disable the sandbox rather than failing to launch;
    // a normal desktop user never hits this branch.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      args.unshift("--no-sandbox");
    }
    const context = await chromium.launchPersistentContext(options.profileDir, {
      headless: options.headless ?? true,
      args,
    });
    const page = context.pages()[0] ?? (await context.newPage());
    return new BrowserSession(context, page, options.profileDir);
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url);
  }

  currentUrl(): string {
    return this.page.url();
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path });
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

/** Launch a persistent session in the given profile directory. */
export async function launchSession(
  options: LaunchSessionOptions,
): Promise<BrowserSession> {
  return BrowserSession.launch(options);
}
