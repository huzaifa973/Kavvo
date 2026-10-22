import { describe, expect, it } from "vitest";
import { RateGuard } from "@skillforge/rules-engine";
import {
  AllProvidersDownError,
  KeyRegistry,
  MockProvider,
  Router,
  type ChatMessage,
} from "../src/index.js";

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hello" }];

describe("Router — happy path", () => {
  it("serves from the first provider and records who served", async () => {
    const a = new MockProvider("alpha", { content: "from alpha" });
    const b = new MockProvider("beta", { content: "from beta" });
    const router = new Router({ providers: [a, b] });

    const result = await router.chat(MESSAGES);
    expect(result.content).toBe("from alpha");
    expect(result.provider).toBe("alpha");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.outcome).toBe("served");
    expect(b.callCount).toBe(0);
  });

  it("rejects construction with no providers", () => {
    expect(() => new Router({ providers: [] })).toThrow();
  });
});

describe("Router — failover", () => {
  it("fails over to the next provider when the first is rate-limited by the guard", async () => {
    const guard = new RateGuard([
      { provider: "alpha", requestsPerMinute: 1, tokensPerDay: 100_000, backoffBaseMs: 100 },
      { provider: "beta", requestsPerMinute: 30, tokensPerDay: 100_000, backoffBaseMs: 100 },
    ]);
    // Exhaust alpha's single per-minute slot before the router call.
    guard.acquire("alpha", "anonymous", { estimatedTokens: 1 });

    const a = new MockProvider("alpha", { content: "from alpha" });
    const b = new MockProvider("beta", { content: "from beta" });
    const router = new Router({ providers: [a, b], guard });

    const result = await router.chat(MESSAGES);
    expect(result.content).toBe("from beta");
    expect(result.provider).toBe("beta");
    expect(a.callCount).toBe(0); // guard stopped the call before it happened
    expect(result.attempts[0]).toMatchObject({ provider: "alpha", outcome: "rate-limited" });
    expect(result.attempts[1]).toMatchObject({ provider: "beta", outcome: "served" });
  });

  it("fails over when the provider itself throws a rate-limit error", async () => {
    const { RateLimitedError } = await import("@skillforge/rules-engine");
    const a = new MockProvider("alpha", {
      error: new RateLimitedError({
        provider: "alpha",
        keyId: "k",
        limit: "requestsPerMinute",
        retryAfterMs: 1000,
      }),
    });
    const b = new MockProvider("beta", { content: "from beta" });
    const router = new Router({ providers: [a, b] });

    const result = await router.chat(MESSAGES);
    expect(result.provider).toBe("beta");
    expect(result.attempts[0]?.outcome).toBe("rate-limited");
  });

  it("fails over when the first provider errors", async () => {
    const a = new MockProvider("alpha", { error: new Error("provider exploded") });
    const b = new MockProvider("beta", { content: "from beta" });
    const router = new Router({ providers: [a, b] });

    const result = await router.chat(MESSAGES);
    expect(result.content).toBe("from beta");
    expect(result.provider).toBe("beta");
    expect(result.attempts[0]).toMatchObject({ provider: "alpha", outcome: "error" });
  });

  it("throws AllProvidersDownError with the full attempt log when everything fails", async () => {
    const a = new MockProvider("alpha", { error: new Error("down a") });
    const b = new MockProvider("beta", { error: new Error("down b") });
    const router = new Router({ providers: [a, b] });

    let caught: unknown;
    try {
      await router.chat(MESSAGES);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AllProvidersDownError);
    const err = caught as AllProvidersDownError;
    expect(err.attempts).toHaveLength(2);
    expect(err.attempts.map((x) => x.provider)).toEqual(["alpha", "beta"]);
  });
});

describe("Router — BYOK key registry", () => {
  it("exposes key ids only and passes the resolved secret to the provider", async () => {
    const keys = new KeyRegistry();
    keys.addKey("alpha", "my-key-1", "sk-secret-value");
    expect(keys.listKeyIds("alpha")).toEqual(["my-key-1"]);
    expect(JSON.stringify(keys.listKeyIds("alpha"))).not.toContain("sk-secret-value");

    const a = new MockProvider("alpha");
    const router = new Router({ providers: [a], keys });
    const result = await router.chat(MESSAGES);
    expect(result.keyId).toBe("my-key-1");
    expect(a.lastOpts?.apiKey).toBe("sk-secret-value");
  });

  it("rejects duplicate key ids for the same provider", () => {
    const keys = new KeyRegistry();
    keys.addKey("alpha", "k1", "s1");
    expect(() => keys.addKey("alpha", "k1", "s2")).toThrow();
  });

  it("works keyless for providers with no registered keys", async () => {
    const local = new MockProvider("ollama", { content: "local reply" });
    const router = new Router({ providers: [local] });
    const result = await router.chat(MESSAGES);
    expect(result.provider).toBe("ollama");
    expect(result.keyId).toBeUndefined();
    expect(local.lastOpts?.apiKey).toBeUndefined();
  });
});
