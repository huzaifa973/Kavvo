// Human handoff: layer 3 of the check doctrine.
//
// When a check needs a person, the task PAUSES here instead of dying
// or trying to defeat the check. `waitForHuman` polls the page until
// the check is gone (the human cleared it in the real browser) or the
// timeout runs out. It never clicks, types or otherwise attempts to
// solve the check itself — observation via `detectCheck` only.
//
// Progress is reported through the optional `onPoll` callback. That
// callback is the seam a future mobile push / UI layer hooks into to
// tell the user "your task needs you"; this module deliberately
// builds no notifications of its own.

import type { Page } from "playwright";
import { detectCheck, type CheckResult } from "./checks.js";

export interface HandoffPollInfo {
  /** 1-based poll count. */
  attempt: number;
  /** Milliseconds since the wait started, at this poll. */
  elapsedMs: number;
  /** The most recent detection result (kept across unreadable polls). */
  check: CheckResult;
}

export interface WaitForHumanOptions {
  /**
   * Give up after this long. Defaults to 300_000 (5 minutes): long
   * enough for a person to notice a push and walk to the machine.
   */
  timeoutMs?: number;
  /** Delay between polls. Defaults to 2_000 ms. */
  pollIntervalMs?: number;
  /**
   * Caller-supplied clear condition, for checks detection cannot see
   * (or for pages where "cleared" means something more specific, like
   * a URL change). When provided it decides; `detectCheck` still runs
   * each poll so the timeout error can carry the last detected check.
   */
  isCleared?: (page: Page) => Promise<boolean>;
  /** Progress hook, called once per poll including the final one. */
  onPoll?: (info: HandoffPollInfo) => void | Promise<void>;
}

export interface HandoffResult {
  cleared: true;
  /** Milliseconds from the start of the wait until clearance was seen. */
  waitedMs: number;
}

/** The wait ran out with a check still on the page. */
export class HandoffTimeoutError extends Error {
  /** The last check detection saw (or the last readable one). */
  readonly lastCheck: CheckResult;
  /** How long the wait lasted before giving up. */
  readonly waitedMs: number;

  constructor(lastCheck: CheckResult, waitedMs: number) {
    super(
      `@kavvo/browser: human handoff timed out after ${waitedMs}ms; ` +
        `last check: ${lastCheck.kind} (${lastCheck.evidence})`,
    );
    this.name = "HandoffTimeoutError";
    this.lastCheck = lastCheck;
    this.waitedMs = waitedMs;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const UNREADABLE: CheckResult = {
  kind: "none",
  evidence: "page state could not be read yet",
};

/**
 * Pause until a human clears the check on `page`.
 *
 * Resolves `{ cleared: true, waitedMs }` as soon as a poll finds the
 * page clear. Throws `HandoffTimeoutError` (carrying the last
 * detected check) when the timeout runs out.
 *
 * A poll that cannot read the page at all (mid-navigation, which is
 * exactly what a cleared check often causes, or a replaced execution
 * context) counts as "not cleared yet" and keeps the previous
 * detection for reporting; the timeout still bounds the wait, so a
 * dead page cannot hang a task forever. An error thrown by a
 * caller-supplied `isCleared` or `onPoll` propagates immediately.
 */
export async function waitForHuman(
  page: Page,
  options: WaitForHumanOptions = {},
): Promise<HandoffResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const startedAt = Date.now();
  let attempt = 0;
  let lastCheck: CheckResult = UNREADABLE;

  for (;;) {
    attempt += 1;

    let readable = true;
    try {
      lastCheck = await detectCheck(page);
    } catch {
      readable = false;
    }

    let cleared = false;
    if (options.isCleared) {
      cleared = await options.isCleared(page);
    } else if (readable) {
      cleared = lastCheck.kind === "none";
    }

    const elapsedMs = Date.now() - startedAt;
    await options.onPoll?.({ attempt, elapsedMs, check: lastCheck });

    if (cleared) {
      return { cleared: true, waitedMs: elapsedMs };
    }
    if (elapsedMs >= timeoutMs) {
      throw new HandoffTimeoutError(lastCheck, elapsedMs);
    }
    await sleep(Math.min(pollIntervalMs, timeoutMs - elapsedMs));
  }
}
