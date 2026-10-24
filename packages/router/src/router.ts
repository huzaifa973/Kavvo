import { RateGuard, RateLimitedError } from "@kavvo/rules-engine";
import { KeyRegistry } from "./key-registry.js";
import {
  AllProvidersDownError,
  type AttemptRecord,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type Provider,
} from "./types.js";

export interface RouterOptions {
  /** Providers in priority order: first tried first. */
  providers: Provider[];
  /** Endpoint Rules guard. When a provider has a rule, every call acquires first. */
  guard?: RateGuard;
  /** BYOK keys. Defaults to an empty registry (keyless providers still work). */
  keys?: KeyRegistry;
}

/** Rough pre-call token estimate (chars / 4) used for the guard's daily budget. */
function estimateTokens(messages: ChatMessage[]): number {
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * The Brain Router (original code for Kavvo). Tries providers in
 * priority order; before each attempt it passes the Endpoint Rules guard,
 * and on a rate limit OR a provider failure it fails over to the next
 * provider instead of retry-hammering the same endpoint.
 */
export class Router {
  private readonly providers: Provider[];
  private readonly guard?: RateGuard;
  private readonly keys: KeyRegistry;

  constructor(options: RouterOptions) {
    if (options.providers.length === 0) {
      throw new Error("Router needs at least one provider");
    }
    this.providers = [...options.providers];
    this.guard = options.guard;
    this.keys = options.keys ?? new KeyRegistry();
  }

  get keyRegistry(): KeyRegistry {
    return this.keys;
  }

  providerIds(): string[] {
    return this.providers.map((p) => p.id);
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const attempts: AttemptRecord[] = [];

    for (const provider of this.providers) {
      const keyId = opts.keyId ?? this.keys.firstKeyId(provider.id);

      // Endpoint Rules: nothing calls a provider without passing the guard.
      if (this.guard?.hasRule(provider.id)) {
        try {
          this.guard.acquire(provider.id, keyId ?? "anonymous", {
            estimatedTokens: estimateTokens(messages),
          });
        } catch (err) {
          if (err instanceof RateLimitedError) {
            attempts.push({
              provider: provider.id,
              keyId,
              outcome: "rate-limited",
              detail: `retry after ${err.retryAfterMs}ms`,
            });
            continue; // fail over, never hammer
          }
          throw err;
        }
      }

      try {
        const apiKey = keyId
          ? this.keys.resolveSecret(provider.id, keyId)
          : undefined;
        const response = await provider.chat(messages, { ...opts, apiKey });
        attempts.push({ provider: provider.id, keyId, outcome: "served" });
        if (this.guard?.hasRule(provider.id) && response.usage?.totalTokens) {
          this.guard.recordUsage(
            provider.id,
            keyId ?? "anonymous",
            response.usage.totalTokens,
          );
        }
        return { ...response, provider: provider.id, keyId, attempts };
      } catch (err) {
        attempts.push({
          provider: provider.id,
          keyId,
          outcome: err instanceof RateLimitedError ? "rate-limited" : "error",
          detail: err instanceof Error ? err.message : String(err),
        });
        continue; // fail over to the next provider
      }
    }

    throw new AllProvidersDownError(attempts);
  }
}
