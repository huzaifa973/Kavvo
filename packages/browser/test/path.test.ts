import { describe, expect, it } from "vitest";
import {
  generateMousePath,
  pathLength,
  pickPointInBox,
  type Point,
  type Rng,
} from "../src/index.js";

/** Deterministic RNG so path assertions are exact, not probabilistic. */
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

const FROM: Point = { x: 0, y: 0 };
const TO: Point = { x: 300, y: 200 };
const STRAIGHT = Math.hypot(TO.x - FROM.x, TO.y - FROM.y);

/** Signed distance of p past the target along the direction of travel. */
function overshootProjection(p: Point): number {
  const ux = (TO.x - FROM.x) / STRAIGHT;
  const uy = (TO.y - FROM.y) / STRAIGHT;
  return (p.x - TO.x) * ux + (p.y - TO.y) * uy;
}

/** Perpendicular distance of p from the straight FROM->TO line. */
function deviation(p: Point): number {
  const cross =
    (p.x - FROM.x) * (TO.y - FROM.y) - (p.y - FROM.y) * (TO.x - FROM.x);
  return Math.abs(cross) / STRAIGHT;
}

describe("generateMousePath", () => {
  it("produces a long, curved trail that overshoots then settles on the target", () => {
    const path = generateMousePath(FROM, TO, { rng: mulberry32(42) });

    // Many intermediate points, not a two-point jump.
    expect(path.points.length).toBeGreaterThanOrEqual(40);

    // Curved + overshooting travel is longer than the straight line.
    expect(pathLength(path.points)).toBeGreaterThan(STRAIGHT * 1.05);

    // The trail genuinely leaves the straight line.
    const maxDeviation = Math.max(...path.points.map(deviation));
    expect(maxDeviation).toBeGreaterThan(5);

    // The main curve ends past the target: a real overshoot.
    expect(overshootProjection(path.overshootPoint)).toBeGreaterThan(5);
    expect(path.points[path.settleStartIndex]).toEqual(path.overshootPoint);

    // The settle walks back in: strictly closer a couple of steps in,
    // and the final point is exactly the target.
    const distToTarget = (p: Point) => Math.hypot(p.x - TO.x, p.y - TO.y);
    expect(distToTarget(path.points[path.settleStartIndex])).toBeGreaterThan(
      distToTarget(path.points[path.settleStartIndex + 2]),
    );
    expect(path.points[path.points.length - 1]).toEqual(TO);
    expect(path.target).toEqual(TO);
  });

  it("never traces the same route twice for different random draws", () => {
    const a = generateMousePath(FROM, TO, { rng: mulberry32(1) });
    const b = generateMousePath(FROM, TO, { rng: mulberry32(2) });
    expect(JSON.stringify(a.points)).not.toBe(JSON.stringify(b.points));
  });

  it("degenerates to a single point when already at the target", () => {
    const path = generateMousePath({ x: 5, y: 5 }, { x: 5, y: 5 }, {
      rng: mulberry32(42),
    });
    expect(path.points).toEqual([{ x: 5, y: 5 }]);
    expect(pathLength(path.points)).toBe(0);
    expect(path.settleStartIndex).toBe(0);
  });

  it("honors an explicit overshoot distance", () => {
    const path = generateMousePath(FROM, TO, {
      rng: mulberry32(42),
      overshootDistance: 30,
    });
    // Projection is the along-track component of the overshoot: the
    // requested distance, modulo floating-point dust (the sideways
    // jitter only ever reduces it).
    expect(overshootProjection(path.overshootPoint)).toBeGreaterThan(20);
    expect(overshootProjection(path.overshootPoint)).toBeLessThan(30.01);
  });
});

describe("pickPointInBox", () => {
  const box = { x: 100, y: 50, width: 200, height: 80 };

  it("picks inside the box, away from edges and dead center", () => {
    for (const seed of [1, 7, 42, 99]) {
      const p = pickPointInBox(box, mulberry32(seed));
      expect(p.x).toBeGreaterThan(box.x + box.width * 0.1);
      expect(p.x).toBeLessThan(box.x + box.width * 0.9);
      expect(p.y).toBeGreaterThan(box.y + box.height * 0.1);
      expect(p.y).toBeLessThan(box.y + box.height * 0.9);
    }
    const seeded = pickPointInBox(box, mulberry32(42));
    expect(seeded.x).not.toBe(box.x + box.width / 2);
    expect(seeded.y).not.toBe(box.y + box.height / 2);
  });
});
