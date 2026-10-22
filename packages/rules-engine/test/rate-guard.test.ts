import { describe, expect, it } from "vitest";
import {
  RateGuard,
  RateLimitedError,
  UnknownProviderError,
  type ProviderRule,
} from "../src/index.js";

const GROQ: ProviderRule = {
  provider: "groq",
  requestsPerMinute: 2,
  tokensPerDay: 1000,
  backoffBaseMs: 250,
};

function makeGuard(start = 1_000_000) {
  let now = start;
  const guard = new RateGuard([GROQ], { now: () => now });
  return {
    guard,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("RateGuard.acquire — request limit", () => {
  it("lets under-limit acquires pass", () => {
    const { guard } = makeGuard();
    expect(() => guard.acquire("groq", "key-a")).not.toThrow();
    expect(() => guard.acquire("groq", "key-a")).not.toThrow();
    expect(guard.usage("groq", "key-a").requestsLastMinute).toBe(2);
  });

  it("throws a typed RateLimitedError with a sane retryAfterMs when over the limit", () => {
    const { guard } = makeGuard();
    guard.acquire("groq", "key-a");
    guard.acquire("groq", "key-a");

    let caught: unknown;
    try {
      guard.acquire("groq", "key-a");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RateLimitedError);
    const err = caught as RateLimitedError;
    expect(err.provider).toBe("groq");
    expect(err.keyId).toBe("key-a");
    expect(err.limit).toBe("requestsPerMinute");
    expect(err.retryAfterMs).toBeGreaterThan(0);
    expect(err.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("does not record a rejected acquire", () => {
    const { guard } = makeGuard();
    guard.acquire("groq", "key-a");
    guard.acquire("groq", "key-a");
    expect(() => guard.acquire("groq", "key-a")).toThrow(RateLimitedError);
    expect(guard.usage("groq", "key-a").requestsLastMinute).toBe(2);
  });

  it("tracks keys independently — one exhausted key does not block another", () => {
    const { guard } = makeGuard();
    guard.acquire("groq", "key-a");
    guard.acquire("groq", "key-a");
    expect(() => guard.acquire("groq", "key-a")).toThrow(RateLimitedError);
    expect(() => guard.acquire("groq", "key-b")).not.toThrow();
  });

  it("frees capacity once the minute window rolls past", () => {
    const { guard, advance } = makeGuard();
    guard.acquire("groq", "key-a");
    guard.acquire("groq", "key-a");
    expect(() => guard.acquire("groq", "key-a")).toThrow(RateLimitedError);
    advance(60_001);
    expect(() => guard.acquire("groq", "key-a")).not.toThrow();
  });

  it("throws UnknownProviderError for a provider with no rule", () => {
    const { guard } = makeGuard();
    expect(() => guard.acquire("nope", "key-a")).toThrow(UnknownProviderError);
    expect(guard.hasRule("groq")).toBe(true);
    expect(guard.hasRule("nope")).toBe(false);
  });
});

describe("RateGuard.acquire — daily token budget", () => {
  it("throws with limit tokensPerDay once the daily budget would be exceeded", () => {
    const { guard } = makeGuard();
    guard.acquire("groq", "key-a", { estimatedTokens: 600 });
    let caught: unknown;
    try {
      guard.acquire("groq", "key-a", { estimatedTokens: 600 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RateLimitedError);
    expect((caught as RateLimitedError).limit).toBe("tokensPerDay");
    expect((caught as RateLimitedError).retryAfterMs).toBeGreaterThan(0);
    expect(guard.usage("groq", "key-a").tokensLastDay).toBe(600);
  });

  it("recordUsage adds post-hoc token accounting", () => {
    const { guard } = makeGuard();
    guard.recordUsage("groq", "key-a", 42);
    expect(guard.usage("groq", "key-a").tokensLastDay).toBe(42);
  });
});

describe("RateGuard.nextBackoffMs", () => {
  it("grows exponentially from the provider base", () => {
    const { guard } = makeGuard();
    expect(guard.nextBackoffMs(0, "groq")).toBe(250);
    expect(guard.nextBackoffMs(1, "groq")).toBe(500);
    expect(guard.nextBackoffMs(2, "groq")).toBe(1000);
    expect(guard.nextBackoffMs(3, "groq")).toBe(2000);
  });

  it("is capped at 60s", () => {
    const { guard } = makeGuard();
    expect(guard.nextBackoffMs(20, "groq")).toBe(60_000);
  });
});
