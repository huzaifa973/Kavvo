// Human typing.
//
// The field is clicked first (physically, via the human mouse), then
// the text goes in one key at a time through Playwright's real keyboard
// API, with a human spread of per-key delays and the occasional longer
// pause, the way a person hesitates mid-sentence. Field values are
// never assigned through the DOM.

import type { Locator, Page } from "playwright";
import { click, type ClickOptions } from "./mouse.js";
import type { Rng } from "./path.js";

export interface TypeOptions extends ClickOptions {
  /** Delay after each key. Defaults: 45–130 ms, randomized per key. */
  minKeyDelayMs?: number;
  maxKeyDelayMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const between = (rng: Rng, min: number, max: number): number =>
  min + rng() * (max - min);

export async function typeText(
  page: Page,
  locator: Locator,
  text: string,
  options: TypeOptions = {},
): Promise<void> {
  const rng = options.rng ?? Math.random;
  await click(page, locator, options);
  for (const ch of text) {
    await page.keyboard.type(ch);
    let delay = between(rng, options.minKeyDelayMs ?? 45, options.maxKeyDelayMs ?? 130);
    // Roughly one key in sixteen is followed by a thinking pause.
    if (rng() < 0.06) {
      delay += between(rng, 120, 260);
    }
    await sleep(delay);
  }
}
