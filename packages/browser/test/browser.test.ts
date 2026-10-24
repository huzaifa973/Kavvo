import { createServer, type Server } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  click,
  launchSession,
  typeText,
  type BrowserSession,
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

// A page that watches the mouse the way a behavior-scoring check would:
// every mousemove is recorded with a timestamp, the button records its
// clicks, and there is a text input to type into.
const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>kavvo browser fixture</title></head>
<body style="margin:0">
<button id="btn" style="position:absolute;left:320px;top:220px;width:140px;height:48px">Do the thing</button>
<input id="field" style="position:absolute;left:60px;top:60px;width:340px;height:34px" type="text">
<script>
window.__fixture = { clicks: 0, clickPoint: null, moves: [] };
document.addEventListener('mousemove', function (e) {
  window.__fixture.moves.push({ x: e.clientX, y: e.clientY, t: performance.now() });
});
document.getElementById('btn').addEventListener('click', function (e) {
  window.__fixture.clicks += 1;
  window.__fixture.clickPoint = { x: e.clientX, y: e.clientY };
});
</script>
</body></html>`;

interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

let server: Server;
let fixtureUrl: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(FIXTURE_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not bind a port");
  }
  fixtureUrl = `http://127.0.0.1:${address.port}/`;
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
  return mkdtemp(join(tmpdir(), "kavvo-browser-"));
}

describe("Real-Human Browser (live Chromium, fixture page)", () => {
  it(
    "clicks the button with a long, curved mousemove trail that arrives over time",
    { timeout: 30_000 },
    async () => {
      const profileDir = await tempProfile();
      try {
        await withSession(profileDir, async (session) => {
          const { page } = session;
          await session.goto(fixtureUrl);
          const clickedAt = await click(page, page.locator("#btn"), {
            rng: mulberry32(42),
          });

          const clicks = (await page.evaluate("window.__fixture.clicks")) as number;
          const clickPoint = (await page.evaluate(
            "window.__fixture.clickPoint",
          )) as { x: number; y: number };
          const moves = (await page.evaluate("window.__fixture.moves")) as TrailPoint[];

          // The click really landed, inside the button.
          expect(clicks).toBe(1);
          expect(Math.abs(clickPoint.x - clickedAt.x)).toBeLessThan(1.5);
          expect(Math.abs(clickPoint.y - clickedAt.y)).toBeLessThan(1.5);
          expect(clickPoint.x).toBeGreaterThanOrEqual(320);
          expect(clickPoint.x).toBeLessThanOrEqual(460);
          expect(clickPoint.y).toBeGreaterThanOrEqual(220);
          expect(clickPoint.y).toBeLessThanOrEqual(268);

          // The trail is many points, spread over real time — the
          // opposite of a teleport, which would record ~one event.
          expect(moves.length).toBeGreaterThanOrEqual(20);
          const elapsed = moves[moves.length - 1].t - moves[0].t;
          expect(elapsed).toBeGreaterThanOrEqual(100);

          // And it curves: total travel beats the straight-line
          // distance, and some point strays off the direct line.
          const first = moves[0];
          const straight = Math.hypot(clickPoint.x - first.x, clickPoint.y - first.y);
          let travelled = 0;
          let maxDeviation = 0;
          for (let i = 1; i < moves.length; i++) {
            travelled += Math.hypot(moves[i].x - moves[i - 1].x, moves[i].y - moves[i - 1].y);
            const cross =
              (moves[i].x - first.x) * (clickPoint.y - first.y) -
              (moves[i].y - first.y) * (clickPoint.x - first.x);
            maxDeviation = Math.max(maxDeviation, Math.abs(cross) / straight);
          }
          expect(travelled).toBeGreaterThan(straight * 1.02);
          expect(maxDeviation).toBeGreaterThan(2);
        });
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
  );

  it(
    "types the exact text into the input, key by key",
    { timeout: 30_000 },
    async () => {
      const profileDir = await tempProfile();
      try {
        await withSession(profileDir, async (session) => {
          const { page } = session;
          await session.goto(fixtureUrl);
          const text = "Hello, Forge! 123";
          await typeText(page, page.locator("#field"), text, {
            rng: mulberry32(7),
          });
          const value = (await page.evaluate(
            "document.getElementById('field').value",
          )) as string;
          expect(value).toBe(text);
        });
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
  );

  it(
    "session helpers report the URL and write a real screenshot",
    { timeout: 30_000 },
    async () => {
      const profileDir = await tempProfile();
      const shotPath = join(profileDir, "shot.png");
      try {
        await withSession(profileDir, async (session) => {
          await session.goto(fixtureUrl);
          expect(session.currentUrl()).toBe(fixtureUrl);
          await session.screenshot(shotPath);
          const info = await stat(shotPath);
          expect(info.size).toBeGreaterThan(0);
        });
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
  );

  it(
    "keeps state across relaunches with the same profile directory",
    { timeout: 30_000 },
    async () => {
      const profileDir = await tempProfile();
      try {
        await withSession(profileDir, async (session) => {
          await session.goto(fixtureUrl);
          await session.page.evaluate(
            "localStorage.setItem('kavvo-marker', 'still-here')",
          );
        });
        // A brand-new launch on the same profile dir is a new browser
        // process — anything readable now survived on disk, like a
        // real user's login session would.
        await withSession(profileDir, async (session) => {
          await session.goto(fixtureUrl);
          const value = (await session.page.evaluate(
            "localStorage.getItem('kavvo-marker')",
          )) as string | null;
          expect(value).toBe("still-here");
        });
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
  );
});
