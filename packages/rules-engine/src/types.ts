/**
 * Rules for one provider endpoint. Every model call in Kavvo must pass
 * the RateGuard built from these rules before it touches a provider, so keys
 * and accounts stay inside the provider's published limits.
 */
export interface ProviderRule {
  /** Provider id, matching the id used by the Brain Router (e.g. "groq"). */
  provider: string;
  /** Max requests allowed inside any rolling 60-second window, per key. */
  requestsPerMinute: number;
  /** Max tokens allowed inside any rolling 24-hour window, per key. */
  tokensPerDay: number;
  /** Base delay in ms for exponential backoff (attempt 0 waits this long). */
  backoffBaseMs: number;
}

export type RateLimitKind = "requestsPerMinute" | "tokensPerDay";

/**
 * Thrown when a provider+key is over its rule limits. Carries `retryAfterMs`
 * so callers can fail over (the Router) or schedule a later retry instead of
 * hammering the endpoint.
 */
export class RateLimitedError extends Error {
  readonly provider: string;
  readonly keyId: string;
  readonly limit: RateLimitKind;
  readonly retryAfterMs: number;

  constructor(args: {
    provider: string;
    keyId: string;
    limit: RateLimitKind;
    retryAfterMs: number;
  }) {
    super(
      `Rate limit hit for provider "${args.provider}" (key "${args.keyId}"): ` +
        `${args.limit} exceeded, retry after ${args.retryAfterMs}ms`,
    );
    this.name = "RateLimitedError";
    this.provider = args.provider;
    this.keyId = args.keyId;
    this.limit = args.limit;
    this.retryAfterMs = args.retryAfterMs;
  }
}

/** Thrown when acquire() is called for a provider with no registered rule. */
export class UnknownProviderError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(`No rule registered for provider "${provider}"`);
    this.name = "UnknownProviderError";
    this.provider = provider;
  }
}
