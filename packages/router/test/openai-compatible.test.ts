import { describe, expect, it } from "vitest";
import { RateGuard, RateLimitedError } from "@kavvo/rules-engine";
import {
  KeyRegistry,
  MockProvider,
  ProviderError,
  Router,
  geminiProvider,
  groqProvider,
  ollamaProvider,
  openrouterProvider,
  type ChatMessage,
  type FetchImpl,
} from "../src/index.js";

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hello" }];

interface CapturedCall {
  url: string;
  init: RequestInit;
}

/** A fetch stub that records every call and never touches the network. */
function stubFetch(
  respond: (call: CapturedCall) => Response | Promise<Response>,
) {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const call: CapturedCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as unknown as FetchImpl;
  return { calls, fetchImpl };
}

function successBody(content = "real reply") {
  return {
    model: "test-model-1",
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42 },
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function headersOf(call: CapturedCall): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

describe("OpenAICompatibleProvider — success path", () => {
  it("maps an OpenAI-style response into a ProviderResponse and builds the request", async () => {
    const { calls, fetchImpl } = stubFetch(() => jsonResponse(successBody()));
    const provider = groqProvider({ model: "test-model-1", fetchImpl });

    const result = await provider.chat(MESSAGES, {
      temperature: 0.5,
      maxTokens: 64,
    });

    expect(result.content).toBe("real reply");
    expect(result.model).toBe("test-model-1");
    expect(result.usage).toEqual({ totalTokens: 42 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(calls[0]?.init.method).toBe("POST");
    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(sent.model).toBe("test-model-1");
    expect(sent.messages).toEqual(MESSAGES);
    expect(sent.temperature).toBe(0.5);
    expect(sent.max_tokens).toBe(64);
  });

  it("lets a per-call model override the configured model", async () => {
    const { calls, fetchImpl } = stubFetch(() => jsonResponse(successBody()));
    const provider = groqProvider({ model: "configured", fetchImpl });

    await provider.chat(MESSAGES, { model: "override" });
    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(sent.model).toBe("override");
  });

  it("requires a model — presets ship no default", () => {
    expect(() => groqProvider({ model: "" })).toThrow(/model/);
  });
});

describe("OpenAICompatibleProvider — BYOK key resolution", () => {
  it("sends the Authorization header from the key resolved through the registry", async () => {
    const keys = new KeyRegistry();
    keys.addKey("groq", "main", "sk-registry-secret");
    const { calls, fetchImpl } = stubFetch(() => jsonResponse(successBody()));
    const provider = groqProvider({
      model: "test-model-1",
      keys,
      keyId: "main",
      fetchImpl,
    });

    await provider.chat(MESSAGES, {});
    expect(headersOf(calls[0]!).Authorization).toBe("Bearer sk-registry-secret");
  });

  it("sends no Authorization header for keyless Ollama", async () => {
    const { calls, fetchImpl } = stubFetch(() => jsonResponse(successBody()));
    const provider = ollamaProvider({ model: "local-model", fetchImpl });

    await provider.chat(MESSAGES, {});
    expect(calls[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(headersOf(calls[0]!)).not.toHaveProperty("Authorization");
  });

  it("never lets the secret appear in results, errors, or the serialized instance", async () => {
    const secret = "sk-super-secret-value";
    const keys = new KeyRegistry();
    keys.addKey("groq", "main", secret);
    // A hostile/buggy endpoint echoes the key back in its error body.
    const { fetchImpl } = stubFetch(
      () =>
        new Response(`{"error":"key ${secret} was rejected"}`, { status: 500 }),
    );
    const provider = groqProvider({
      model: "test-model-1",
      keys,
      keyId: "main",
      fetchImpl,
    });

    let caught: unknown;
    try {
      await provider.chat(MESSAGES, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    const err = caught as ProviderError;
    expect(err.message).not.toContain(secret);
    expect(err.bodySnippet).not.toContain(secret);
    expect(err.bodySnippet).toContain("[redacted]");
    expect(JSON.stringify(err)).not.toContain(secret);
    expect(JSON.stringify(provider)).not.toContain(secret);
  });
});

describe("OpenAICompatibleProvider — presets", () => {
  it("posts to the OpenRouter and Gemini OpenAI-compatible endpoints", async () => {
    const a = stubFetch(() => jsonResponse(successBody()));
    await openrouterProvider({ model: "m", fetchImpl: a.fetchImpl }).chat(
      MESSAGES,
      {},
    );
    expect(a.calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");

    const b = stubFetch(() => jsonResponse(successBody()));
    await geminiProvider({ model: "m", fetchImpl: b.fetchImpl }).chat(MESSAGES, {});
    expect(b.calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
  });
});

describe("OpenAICompatibleProvider — error mapping", () => {
  it("maps HTTP 429 to the RateLimitedError the Router fails over on", async () => {
    const { fetchImpl } = stubFetch(
      () => new Response("slow down", { status: 429, headers: { "Retry-After": "2" } }),
    );
    const provider = groqProvider({ model: "m", fetchImpl });

    let caught: unknown;
    try {
      await provider.chat(MESSAGES, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RateLimitedError);
    const err = caught as RateLimitedError;
    expect(err.provider).toBe("groq");
    expect(err.retryAfterMs).toBe(2000);
  });

  it("fails over through a real Router to a backup provider on 429", async () => {
    const keys = new KeyRegistry();
    keys.addKey("groq", "k1", "sk-router-secret");
    const { fetchImpl } = stubFetch(() => new Response("limited", { status: 429 }));
    const groq = groqProvider({ model: "m", fetchImpl });
    const backup = new MockProvider("backup", { content: "from backup" });
    const router = new Router({ providers: [groq, backup], keys });

    const result = await router.chat(MESSAGES);
    expect(result.provider).toBe("backup");
    expect(result.content).toBe("from backup");
    expect(result.attempts[0]).toMatchObject({
      provider: "groq",
      outcome: "rate-limited",
    });
    expect(result.attempts[1]).toMatchObject({
      provider: "backup",
      outcome: "served",
    });
  });

  it("maps HTTP 500 to a typed ProviderError carrying status and body snippet", async () => {
    const { fetchImpl } = stubFetch(
      () => new Response("internal boom: upstream exploded", { status: 500 }),
    );
    const provider = groqProvider({ model: "m", fetchImpl });

    let caught: unknown;
    try {
      await provider.chat(MESSAGES, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    const err = caught as ProviderError;
    expect(err.provider).toBe("groq");
    expect(err.status).toBe(500);
    expect(err.bodySnippet).toContain("internal boom");
    expect(err.message).toContain("HTTP 500");
  });

  it("maps a network failure to a typed ProviderError without a status", async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new Error("socket hangup");
    });
    const provider = groqProvider({ model: "m", fetchImpl });

    let caught: unknown;
    try {
      await provider.chat(MESSAGES, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    const err = caught as ProviderError;
    expect(err.status).toBeUndefined();
    expect(err.message).toContain("socket hangup");
  });
});

describe("OpenAICompatibleProvider — usage reporting", () => {
  it("reports usage through the Router into the RateGuard", async () => {
    const guard = new RateGuard([
      {
        provider: "groq",
        requestsPerMinute: 60,
        tokensPerDay: 100_000,
        backoffBaseMs: 100,
      },
    ]);
    const keys = new KeyRegistry();
    keys.addKey("groq", "k1", "sk-router-secret");
    const { fetchImpl } = stubFetch(() => jsonResponse(successBody()));
    const groq = groqProvider({ model: "test-model-1", fetchImpl });
    const router = new Router({ providers: [groq], guard, keys });

    const result = await router.chat(MESSAGES);
    expect(result.usage).toEqual({ totalTokens: 42 });

    const snapshot = guard.usage("groq", "k1");
    expect(snapshot.requestsLastMinute).toBe(1);
    // 42 real tokens from the response, on top of the Router's pre-call estimate.
    expect(snapshot.tokensLastDay).toBeGreaterThanOrEqual(42);
  });
});
