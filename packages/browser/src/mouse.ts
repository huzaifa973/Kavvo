// Human mouse movement and clicking.
//
// Everything here goes through Playwright's real mouse API, one step at
// a time, with small variable delays between steps. The cursor is never
// teleported and no element is ever clicked through the DOM — a click
// is a physical trip along a generated curve, then a button press with
// a human duration.

import type { Locator, Page } from "playwright";
import {
  generateMousePath,
  pickPointInBox,
  type Point,
  type Rng,
} from "./path.js";

export interface MoveOptions {
  rng?: Rng;
  /** Delay between individual mouse steps. Defaults: 5–12 ms, randomized. */
  minStepDelayMs?: number;
  maxStepDelayMs?: number;
}

export interface ClickOptions extends MoveOptions {
  /** How long the button stays pressed. Defaults: 45–110 ms, randomized. */
  minPressMs?: number;
  maxPressMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const between = (rng: Rng, min: number, max: number): number =>
  min + rng() * (max - min);

// Playwright does not report the cursor position back, so the last
// point we moved to is tracked per page. A fresh page's cursor starts
// at (0, 0), which is also Playwright's own starting position.
const positions = new WeakMap<Page, Point>();

export function lastKnownPosition(page: Page): Point {
  return positions.get(page) ?? { x: 0, y: 0 };
}

/**
 * Travel to (x, y) along a human path. Returns the points replayed,
 * ending exactly at the destination.
 */
export async function moveTo(
  page: Page,
  x: number,
  y: number,
  options: MoveOptions = {},
): Promise<Point[]> {
  const rng = options.rng ?? Math.random;
  const minDelay = options.minStepDelayMs ?? 5;
  const maxDelay = options.maxStepDelayMs ?? 12;
  const path = generateMousePath(lastKnownPosition(page), { x, y }, { rng });
  const { points } = path;
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    await page.mouse.move(point.x, point.y);
    positions.set(page, point);
    if (i < points.length - 1) {
      await sleep(between(rng, minDelay, maxDelay));
    }
  }
  return points;
}

/**
 * Click an element the way a person does: look up where it is, travel
 * to a naturally off-center point inside it, press, hold briefly,
 * release. Returns the point that was clicked.
 */
export async function click(
  page: Page,
  locator: Locator,
  options: ClickOptions = {},
): Promise<Point> {
  // Geometry lookup only — reading where an element sits, like eyes do.
  // The click itself is performed by the physical mouse below.
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(
      "@skillforge/browser: cannot click an element with no bounding box (not visible?)",
    );
  }
  const rng = options.rng ?? Math.random;
  const target = pickPointInBox(box, rng);
  await moveTo(page, target.x, target.y, options);
  await page.mouse.down();
  await sleep(between(rng, options.minPressMs ?? 45, options.maxPressMs ?? 110));
  await page.mouse.up();
  return target;
}
