import { RateLimitedError } from "@skillforge/rules-engine";
import { KeyRegistry } from "./key-registry.js";
import type {
  ChatMessage,
  Provider,
  ProviderChatOptions,
  ProviderResponse,
} from "./types.js";

export type FetchImpl = typeof fetch;

export interface OpenAICompatibleProviderConfig {
  /** Provider id, matching the Router / rules-engine id (e.g. "groq"). */
  id: string;
  /** API root, e.g. "https://api.groq.com/openai/v1". Trailing slashes are fine. */
  baseUrl: string;
  /** Model to request. Required — there is deliberately no default model. */
  model: string;
  /**
   * BYOK key id this adapter uses by default. The secret itself is resolved
   * at call time and never stored on the instance.
   */
  keyId?: string;
  /**
   * Registry used to resolve `keyId` at call time when the Router has not
   * already supplied `opts.apiKey`. Optional: keyless endpoints (Ollama)
   * need neither a registry nor a key id.
   */
  keys?: KeyRegistry;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: FetchImpl;
}

/**
 * Typed failure from a provider adapter: a non-2xx response (carrying the
 * HTTP status and a trimmed, secret-redacted body snippet), a network
 * failure, or a malformed success body. HTTP 429 is NOT reported through
 * this class — it throws RateLimitedError so the Router fails over.
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status?: number;
  readonly bodySnippet?: string;

  constructor(args: {
    provider: string;
    message: string;
    status?: number;
    bodySnippet?: string;
    cause?: unknown;
  }) {
    super(args.message, args.cause !== undefined ? { cause: args.cause } : undefined);
    this.name = "ProviderError";
    this.provider = args.provider;
    this.status = args.status;
    this.bodySnippet = args.bodySnippet;
  }
}

const MAX_BODY_SNIPPET = 200;
const DEFAULT_RETRY_AFTER_MS = 1000;

interface OpenAIChatCompletion {
  model?: string;
  choices?: { message?: { content?: unknown } }[];
  usage?: {
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

/**
 * Adapter for any OpenAI-compatible chat endpoint (Groq, OpenRouter,
 * Gemini's OpenAI surface, a local Ollama, ...). Implements the router's
 * Provider interface, so every call still passes the Endpoint Rules guard
 * in the Router before it gets here.
 *
 * Secret handling: the API key is resolved at call time — from
 * `opts.apiKey` when the Router supplied one, otherwise from the injected
 * KeyRegistry via this adapter's key id — and is kept in a local variable
 * only. It is never stored on the instance, never logged, and is redacted
 * out of any error text the endpoint might echo back.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly keyId?: string;
  private readonly keys?: KeyRegistry;
  private readonly fetchImpl: FetchImpl;

  constructor(config: OpenAICompatibleProviderConfig) {
    if (!config.id) throw new Error("OpenAICompatibleProvider needs an id");
    if (!config.baseUrl) {
      throw new Error(`Provider "${config.id}" needs a baseUrl`);
    }
    if (!config.model) {
      throw new Error(
        `Provider "${config.id}" needs a model — there is no default model`,
      );
    }
    this.id = config.id;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.model = config.model;
    this.keyId = config.keyId;
    this.keys = config.keys;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  async chat(
    messages: ChatMessage[],
    opts: ProviderChatOptions,
  ): Promise<ProviderResponse> {
    const keyId = opts.keyId ?? this.keyId;
    const apiKey = this.resolveApiKey(opts, keyId);
    const model = opts.model ?? this.model;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const body: Record<string, unknown> = { model, messages };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ProviderError({
        provider: this.id,
        message: this.redact(
          `Provider "${this.id}" request failed before a response: ` +
            (err instanceof Error ? err.message : String(err)),
          apiKey,
        ),
        cause: err,
      });
    }

    const text = await response.text();

    if (response.status === 429) {
      throw new RateLimitedError({
        provider: this.id,
        keyId: keyId ?? "anonymous",
        limit: "requestsPerMinute",
        retryAfterMs: this.retryAfterMs(response),
      });
    }

    if (!response.ok) {
      const snippet = this.redact(text.trim().slice(0, MAX_BODY_SNIPPET), apiKey);
      throw new ProviderError({
        provider: this.id,
        message:
          `Provider "${this.id}" request failed with HTTP ${response.status}` +
          (snippet ? `: ${snippet}` : ""),
        status: response.status,
        bodySnippet: snippet || undefined,
      });
    }

    let parsed: OpenAIChatCompletion;
    try {
      parsed = JSON.parse(text) as OpenAIChatCompletion;
    } catch (err) {
      throw new ProviderError({
        provider: this.id,
        message: `Provider "${this.id}" returned a non-JSON success body`,
        status: response.status,
        cause: err,
      });
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new ProviderError({
        provider: this.id,
        message: `Provider "${this.id}" returned a malformed completion (no message content)`,
        status: response.status,
      });
    }

    const totalTokens =
      parsed.usage?.total_tokens ??
      (parsed.usage?.prompt_tokens !== undefined &&
      parsed.usage?.completion_tokens !== undefined
        ? parsed.usage.prompt_tokens + parsed.usage.completion_tokens
        : undefined);

    return {
      content,
      model: parsed.model ?? model,
      usage: totalTokens !== undefined ? { totalTokens } : undefined,
    };
  }

  /**
   * Resolve the secret for this call. The Router's already-resolved
   * `opts.apiKey` wins; otherwise the injected registry is consulted with
   * the pinned/configured key id (falling back to the registry's first key
   * for this provider). Returns undefined for keyless endpoints.
   */
  private resolveApiKey(
    opts: ProviderChatOptions,
    keyId: string | undefined,
  ): string | undefined {
    if (opts.apiKey) return opts.apiKey;
    if (!this.keys) return undefined;
    const id = keyId ?? this.keys.firstKeyId(this.id);
    return id ? this.keys.resolveSecret(this.id, id) : undefined;
  }

  /** Retry-After is expressed in seconds; fall back to a sane default. */
  private retryAfterMs(response: Response): number {
    const header = response.headers.get("Retry-After");
    const seconds = header ? Number(header) : NaN;
    return Number.isFinite(seconds) && seconds > 0
      ? Math.round(seconds * 1000)
      : DEFAULT_RETRY_AFTER_MS;
  }

  /** Belt-and-braces: a key must never surface inside an error, even if an endpoint echoes it back. */
  private redact(text: string, apiKey: string | undefined): string {
    return apiKey ? text.split(apiKey).join("[redacted]") : text;
  }
}
