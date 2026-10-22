// Human mouse path generation.
//
// The cursor never teleports and never travels in a straight line. A path
// is a cubic Bezier from the current position to a point just PAST the
// target (a human overshoot), followed by a short settle curve back onto
// the exact target. Control points are pushed sideways off the straight
// line by a randomized amount, so no two trips between the same points
// trace the same route. This is our own implementation of the approach
// popularized by Ghost Cursor; no code or dependency is taken from it.

export interface Point {
  x: number;
  y: number;
}

/** Axis-aligned box, same shape as Playwright's boundingBox(). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Random source in [0, 1). Injectable so tests can seed it. */
export type Rng = () => number;

export interface MousePathOptions {
  rng?: Rng;
  /** Pixels to travel past the target before settling. Randomized when omitted. */
  overshootDistance?: number;
}

export interface MousePath {
  /** Full trail to replay, in order. The last point is exactly the target. */
  points: Point[];
  /** The farthest point past the target, where the main curve ends. */
  overshootPoint: Point;
  /** Index into `points` of the overshoot point; the settle starts there. */
  settleStartIndex: number;
  /** Where the path ultimately lands. */
  target: Point;
}

const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, value));

function cubic(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/** Slow start, fast middle, slow arrival — how a hand actually moves. */
const easeInOut = (t: number): number =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 2);

/** Total travel distance of a point trail. */
export function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

export function generateMousePath(
  from: Point,
  to: Point,
  options: MousePathOptions = {},
): MousePath {
  const rng = options.rng ?? Math.random;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);

  // Already there: a degenerate single-point path, no invented motion.
  if (dist < 2) {
    return {
      points: [{ ...to }],
      overshootPoint: { ...to },
      settleStartIndex: 0,
      target: { ...to },
    };
  }

  const ux = dx / dist;
  const uy = dy / dist;
  // Perpendicular unit vector, used for curve bow and settle wobble.
  const nx = -uy;
  const ny = ux;

  // Overshoot: travel a little past the target, slightly off-axis.
  const overshootDistance =
    options.overshootDistance ??
    clamp(4 + dist * 0.05 * (0.6 + rng() * 0.8), 4, 42);
  const sideJitter = (rng() - 0.5) * Math.min(10, overshootDistance);
  const overshootPoint: Point = {
    x: to.x + ux * overshootDistance + nx * sideJitter,
    y: to.y + uy * overshootDistance + ny * sideJitter,
  };

  // Main curve: both control points bowed off the straight line by
  // independent random amounts, so paths curve (sometimes in an S).
  const bend1 = (rng() - 0.5) * 2 * dist * 0.22;
  const bend2 = (rng() - 0.5) * 2 * dist * 0.22;
  const c1: Point = {
    x: from.x + ux * dist * 0.3 + nx * bend1,
    y: from.y + uy * dist * 0.3 + ny * bend1,
  };
  const c2: Point = {
    x: overshootPoint.x - ux * dist * 0.3 + nx * bend2,
    y: overshootPoint.y - uy * dist * 0.3 + ny * bend2,
  };

  const mainSteps = clamp(Math.round(dist / 7), 14, 80);
  const points: Point[] = [];
  for (let i = 0; i <= mainSteps; i++) {
    points.push(cubic(from, c1, c2, overshootPoint, easeInOut(i / mainSteps)));
  }
  const settleStartIndex = points.length - 1;

  // Settle: ease back from the overshoot point onto the exact target,
  // with a small sideways wobble that decays as the cursor arrives.
  const settleSteps = clamp(Math.round(overshootDistance / 3), 4, 10);
  const settleJitter = 1 + rng() * 2;
  for (let i = 1; i <= settleSteps; i++) {
    const s = i / settleSteps;
    const e = easeOut(s);
    const wobble = Math.sin(s * Math.PI) * settleJitter * (1 - s);
    points.push({
      x: overshootPoint.x + (to.x - overshootPoint.x) * e + nx * wobble,
      y: overshootPoint.y + (to.y - overshootPoint.y) * e + ny * wobble,
    });
  }
  // Land exactly on the target regardless of rounding in the curve math.
  points[points.length - 1] = { ...to };

  return { points, overshootPoint, settleStartIndex, target: { ...to } };
}

/**
 * A randomized point inside a box — never the dead center twice, never
 * hugging the very edge where a real hand would risk slipping off.
 */
export function pickPointInBox(box: Box, rng: Rng = Math.random): Point {
  const fx = 0.18 + rng() * 0.64;
  const fy = 0.18 + rng() * 0.64;
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}
