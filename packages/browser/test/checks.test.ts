import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  click,
  detectCheck,
  launchSession,
  waitForHuman,
  HandoffTimeoutError,
  type BrowserSession,
  type HandoffPollInfo,
  type Rng,
} from "../src/index.js";

/** Deterministic RNG so the browser trips are reproducible. */
function mulberry32(seed: number): Rng {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fixture pages, one per documented detection signal. The captcha
// iframe's src is local (no network) but carries the "recaptcha"
// token the detector looks for, exactly like a real widget's URL.
const PAGES: Record<string, string> = {
  "/clean": `<!doctype html>
<html><head><meta charset="utf-8"><title>clean</title></head>
<body style="margin:0">
<h1>A perfectly normal page</h1>
<p>Everything is fine here. The kettle is on and the notes are saved.</p>
<a href="/clean">A normal link</a>
</body></html>`,

  "/captcha": `<!doctype html>
<html><head><meta charset="utf-8"><title>captcha</title></head>
<body style="margin:0">
<h1>One more step</h1>
<p>Complete the check below to continue to your document.</p>
<iframe src="/widgets/recaptcha/anchor" width="304" height="78" title="widget"></iframe>
</body></html>`,

  "/verify": `<!doctype html>
<html><head><meta charset="utf-8"><title>verify</title></head>
<body style="margin:0">
<h1>Verify you are human</h1>
<p>This site needs to confirm the visitor is a person before continuing.</p>
</body></html>`,

  "/login": `<!doctype html>
<html><head><meta charset="utf-8"><title>login</title></head>
<body style="margin:0">
<h1>Sign in to your account</h1>
<form>
<label>Email <input type="email" style="width:240px;height:30px"></label>
<label>Password <input type="password" style="width:240px;height:30px"></label>
<button type="submit" style="width:120px;height:36px">Sign in</button>
</form>
</body></html>`,

  // A wall a human can clear: pressing the button (physically, via
  // the package's human click) swaps the wall for normal content.
  "/challenge": `<!doctype html>
<html><head><meta charset="utf-8"><title>challenge</title></head>
<body style="margin:0">
<div id="wall">
<h1>Verify you are human</h1>
<p>Press the button to prove it and carry on.</p>
<button id="human" style="position:absolute;left:80px;top:140px;width:180px;height:52px">I am human</button>
</div>
<script>
document.getElementById('human').addEventListener('click', function () {
  document.getElementById('wall').innerHTML = '<p>Welcome back. You may continue.</p>';
});
</script>
</body></html>`,
};

const WIDGET_HTML = `<!doctype html><html><body>widget</body></html>`;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const html = PAGES[path] ?? (path.startsWith("/widgets/") ? WIDGET_HTML : null);
    if (html === null) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not bind a port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function withSession<T>(
  profileDir: string,
  fn: (session: BrowserSession) => Promise<T>,
): Promise<T> {
  const session = await launchSession({ profileDir, headless: true });
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

async function tempProfile(): Promise<string> {
  return mkdtemp(join(tmpdir(), "skillforge-checks-"));
}

async function onPage<T>(
  path: string,
  fn: (session: BrowserSession) => Promise<T>,
): Promise<T> {
  const profileDir = await tempProfile();
  try {
    return await withSession(profileDir, async (session) => {
      await session.goto(`${baseUrl}${path}`);
      return fn(session);
    });
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
}

describe("detectCheck (live Chromium, fixture pages)", () => {
  it(
    "detects a page embedding a captcha widget as captcha",
    { timeout: 30_000 },
    async () => {
      await onPage("/captcha", async (session) => {
        const result = await detectCheck(session.page);
        expect(result.kind).toBe("captcha");
        expect(result.evidence).toContain("recaptcha");
      });
    },
  );

  it(
    "returns none for a clean page",
    { timeout: 30_000 },
    async () => {
      await onPage("/clean", async (session) => {
        const result = await detectCheck(session.page);
        expect(result.kind).toBe("none");
      });
    },
  );

  it(
    "detects a 'verify you are human' page as a verify wall",
    { timeout: 30_000 },
    async () => {
      await onPage("/verify", async (session) => {
        const result = await detectCheck(session.page);
        expect(result.kind).toBe("verify-wall");
        expect(result.evidence).toContain("verify you are human");
      });
    },
  );

  it(
    "detects a password field with a sign-in control as a login wall",
    { timeout: 30_000 },
    async () => {
      await onPage("/login", async (session) => {
        const result = await detectCheck(session.page);
        expect(result.kind).toBe("login-wall");
        expect(result.evidence).toContain("password");
      });
    },
  );
});

describe("waitForHuman (layer 3 handoff)", () => {
  it(
    "resolves once a human clears the challenge",
    { timeout: 30_000 },
    async () => {
      await onPage("/challenge", async (session) => {
        const { page } = session;
        const polls: HandoffPollInfo[] = [];
        const waiting = waitForHuman(page, {
          timeoutMs: 20_000,
          pollIntervalMs: 200,
          onPoll: (info) => {
            polls.push(info);
          },
        });
        // The "human": the package's own physical click on the
        // fixture's button, which swaps the wall for clean content.
        await click(page, page.locator("#human"), { rng: mulberry32(3) });
        const result = await waiting;

        expect(result.cleared).toBe(true);
        // Sane timing: the wait really spanned some polls (not an
        // instant false-clear) and finished well inside the timeout.
        expect(result.waitedMs).toBeGreaterThanOrEqual(100);
        expect(result.waitedMs).toBeLessThan(20_000);
        expect(polls.length).toBeGreaterThanOrEqual(2);
        expect(polls[0].check.kind).toBe("verify-wall");
        expect(polls[polls.length - 1].check.kind).toBe("none");
      });
    },
  );

  it(
    "times out with HandoffTimeoutError carrying the last check",
    { timeout: 30_000 },
    async () => {
      await onPage("/captcha", async (session) => {
        const startedAt = Date.now();
        const err = await waitForHuman(session.page, {
          timeoutMs: 1_200,
          pollIntervalMs: 200,
        }).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(HandoffTimeoutError);
        const timeout = err as HandoffTimeoutError;
        expect(timeout.lastCheck.kind).toBe("captcha");
        expect(timeout.waitedMs).toBeGreaterThanOrEqual(1_200);
        // ... and the short test timeout kept the suite fast.
        expect(Date.now() - startedAt).toBeLessThan(10_000);
      });
    },
  );
});
