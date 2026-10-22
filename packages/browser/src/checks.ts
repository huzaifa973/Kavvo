// Check detection: OBSERVATION ONLY.
//
// Layer 3 of the check doctrine (and the future layer-2 solver) both
// need to know what is on the page before anything acts. This module
// only reads: it scans the page's elements and visible text for the
// shapes of common blockers and reports a typed result. It never
// clicks, never fills, never tries to pass a check.
//
// Every signal here is a heuristic. The README documents each one and
// its false-positive risks; treat a result as "a human should look",
// not as ground truth.

import type { Page } from "playwright";

export type CheckKind = "captcha" | "verify-wall" | "login-wall" | "none";

export interface CheckResult {
  kind: CheckKind;
  /** Human-readable description of the signal that decided the kind. */
  evidence: string;
}

/**
 * Substrings that mark a captcha widget when they appear in an
 * element's src, class or id, or when an element carries a
 * `data-sitekey` attribute. Ordered specific-first so the evidence
 * names the most precise token.
 */
export const CAPTCHA_TOKENS: readonly string[] = [
  "recaptcha",
  "hcaptcha",
  "h-captcha",
  "turnstile",
  "challenges.cloudflare",
  "arkose",
  "funcaptcha",
  "geetest",
  "captcha",
];

/**
 * Visible-text phrases that mark an interstitial verification wall.
 * Matched case-insensitively against the page's rendered text, with
 * apostrophes and whitespace normalized.
 */
export const VERIFY_TEXT_PATTERNS: readonly string[] = [
  "verify you are human",
  "verify you're human",
  "checking your browser",
  "are you a robot",
  "prove you are human",
  "i'm not a robot",
  "just a moment",
  "unusual traffic",
  "security check",
];

/** Labels that mark a sign-in control for the login-wall heuristic. */
export const SIGN_IN_LABELS: readonly string[] = [
  "sign in",
  "log in",
  "login",
  "sign-in",
];

// --- In-page scan ----------------------------------------------------
// The scan runs inside the page via evaluate and only reads. It is
// written against the minimal structural surface below so this file
// needs no DOM lib types; everything it returns is plain data.

interface ScanConfig {
  tokens: string[];
  phrases: string[];
  signInLabels: string[];
}

interface RawScan {
  captcha: string[];
  phrases: string[];
  passwordVisible: boolean;
  signInText: string | null;
}

interface DomRectLike {
  width: number;
  height: number;
}

interface DomElementLike {
  tagName: string;
  className?: unknown;
  id?: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): DomRectLike;
  textContent: string | null;
}

interface DomDocumentLike {
  body: { innerText?: string; textContent: string | null } | null;
  querySelectorAll(selector: string): ArrayLike<DomElementLike>;
}

function scanPage(cfg: ScanConfig): RawScan {
  const global = globalThis as unknown as {
    document: DomDocumentLike;
    getComputedStyle?: (
      el: DomElementLike,
    ) => { display: string; visibility: string };
  };
  const doc = global.document;
  const scan: RawScan = {
    captcha: [],
    phrases: [],
    passwordVisible: false,
    signInText: null,
  };
  if (!doc || !doc.body) {
    return scan;
  }

  const isVisible = (el: DomElementLike): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) {
      return false;
    }
    if (typeof global.getComputedStyle === "function") {
      try {
        const style = global.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
      } catch {
        // A style lookup failing says nothing; size already passed.
      }
    }
    return true;
  };

  const normalize = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, " ")
      .trim();

  // Captcha widgets: captcha tokens in an element's src/class/id, or
  // a data-sitekey attribute (only captcha vendors use one). The
  // always-present reCAPTCHA v3 badge is explicitly not a challenge,
  // so it is skipped: it sits on countless ordinary pages.
  const widgetEls = doc.querySelectorAll("iframe, div, form, span, section");
  const widgetCap = Math.min(widgetEls.length, 4000);
  for (let i = 0; i < widgetCap; i++) {
    const el = widgetEls[i];
    const className = typeof el.className === "string" ? el.className : "";
    if (className.toLowerCase().includes("grecaptcha-badge")) {
      continue;
    }
    if (!isVisible(el)) {
      continue;
    }
    const tag = el.tagName.toLowerCase();
    if (el.hasAttribute("data-sitekey")) {
      scan.captcha.push(`<${tag}> carries a data-sitekey attribute`);
      continue;
    }
    const src = (el.getAttribute("src") ?? "").toLowerCase();
    const haystacks: Array<{ where: string; text: string }> = [
      { where: "src", text: src },
      { where: "class/id", text: `${className} ${el.id ?? ""}`.toLowerCase() },
    ];
    for (const token of cfg.tokens) {
      const hit = haystacks.find((h) => h.text.includes(token));
      if (hit) {
        scan.captcha.push(`<${tag}> ${hit.where} matches "${token}"`);
        break;
      }
    }
  }

  // Verification-wall text: the page's rendered text, normalized.
  const bodyText = normalize(doc.body.innerText ?? doc.body.textContent ?? "");
  for (const phrase of cfg.phrases) {
    if (bodyText.includes(normalize(phrase))) {
      scan.phrases.push(phrase);
    }
  }

  // Login wall (deliberately simple): a visible password field plus a
  // visible sign-in heading, link or button.
  const passwordEls = doc.querySelectorAll('input[type="password"]');
  for (let i = 0; i < passwordEls.length; i++) {
    if (isVisible(passwordEls[i])) {
      scan.passwordVisible = true;
      break;
    }
  }
  if (scan.passwordVisible) {
    const controlEls = doc.querySelectorAll(
      'button, a, h1, h2, h3, input[type="submit"]',
    );
    const controlCap = Math.min(controlEls.length, 1000);
    for (let i = 0; i < controlCap; i++) {
      const el = controlEls[i];
      if (!isVisible(el)) {
        continue;
      }
      const label = normalize(
        el.textContent ?? el.getAttribute("value") ?? "",
      );
      if (label && cfg.signInLabels.some((s) => label.includes(s))) {
        scan.signInText = label.slice(0, 60);
        break;
      }
    }
  }

  return scan;
}

// --- Classification ---------------------------------------------------

/**
 * Look at the page and report which blocker, if any, is showing.
 * Precedence: a concrete captcha widget beats wall text (captcha
 * pages often carry "verify you are human" wording too), which beats
 * the login-wall heuristic.
 *
 * Rejects if the page cannot be read at all (closed, or mid-
 * navigation with no execution context). Callers that poll, like
 * `waitForHuman`, decide for themselves how to treat that.
 */
export async function detectCheck(page: Page): Promise<CheckResult> {
  const scan = await page.evaluate<RawScan, ScanConfig>(scanPage, {
    tokens: [...CAPTCHA_TOKENS],
    phrases: [...VERIFY_TEXT_PATTERNS],
    signInLabels: [...SIGN_IN_LABELS],
  });

  if (scan.captcha.length > 0) {
    const extra =
      scan.captcha.length > 1 ? ` (+${scan.captcha.length - 1} more)` : "";
    return { kind: "captcha", evidence: `${scan.captcha[0]}${extra}` };
  }
  if (scan.phrases.length > 0) {
    return {
      kind: "verify-wall",
      evidence: `page text matches "${scan.phrases[0]}"`,
    };
  }
  if (scan.passwordVisible && scan.signInText) {
    return {
      kind: "login-wall",
      evidence: `visible password field with sign-in control "${scan.signInText}"`,
    };
  }
  return {
    kind: "none",
    evidence: "no captcha widget, verification text or login wall found",
  };
}
