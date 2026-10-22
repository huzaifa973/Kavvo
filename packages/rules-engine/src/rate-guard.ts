import {
  RateLimitedError,
  UnknownProviderError,
  type ProviderRule,
} from "./types.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_BACKOFF_MS = 60_000;

interface KeyState {
  /** Timestamps (ms) of requests inside the current minute window. */
  requestTimes: number[];
  /** Token usage events inside the current day window. */
  tokenEvents: { at: number; tokens: number }[];
}

export interface RateGuardOptions {
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface UsageSnapshot {
  provider: string;
  keyId: string;
  requestsLastMinute: number;
  tokensLastDay: number;
}

/**
 * Per-provider, per-key rate guard. Sits between the Brain Router and every
 * provider endpoint: the Router must acquire() before calling, and on a
 * RateLimitedError it fails over to the next provider instead of retrying.
 *
 * Windows are rolling (last 60s / last 24h), which is stricter and simpler
 * than calendar windows and never lets a burst straddle a boundary.
 */
export class RateGuard {
  private readonly rules = new Map<string, ProviderRule>();
  private readonly state = new Map<string, KeyState>();
  private readonly now: () => number;

  constructor(rules: ProviderRule[] = [], options: RateGuardOptions = {}) {
    this.now = options.now ?? Date.now;
    for (const rule of rules) this.registerRule(rule);
  }

  registerRule(rule: ProviderRule): void {
    this.rules.set(rule.provider, { ...rule });
  }

  hasRule(provider: string): boolean {
    return this.rules.has(provider);
  }

  getRule(provider: string): ProviderRule {
    const rule = this.rules.get(provider);
    if (!rule) throw new UnknownProviderError(provider);
    return rule;
  }

  /**
   * Reserve one request (plus an estimated token cost) for provider+key.
   * Throws RateLimitedError when either the per-minute request cap or the
   * per-day token cap would be exceeded. A rejected acquire records nothing.
   */
  acquire(
    provider: string,
    keyId: string,
    options: { estimatedTokens?: number } = {},
  ): void {
    const rule = this.getRule(provider);
    const estimatedTokens = Math.max(0, options.estimatedTokens ?? 0);
    const now = this.now();
    const state = this.stateFor(provider, keyId);
    this.prune(state, now);

    if (state.requestTimes.length >= rule.requestsPerMinute) {
      const oldest = state.requestTimes[0] ?? now;
      throw new RateLimitedError({
        provider,
        keyId,
        limit: "requestsPerMinute",
        retryAfterMs: Math.max(1, oldest + MINUTE_MS - now),
      });
    }

    const tokensUsed = state.tokenEvents.reduce((sum, e) => sum + e.tokens, 0);
    if (tokensUsed + estimatedTokens > rule.tokensPerDay) {
      const oldest = state.tokenEvents[0]?.at ?? now;
      throw new RateLimitedError({
        provider,
        keyId,
        limit: "tokensPerDay",
        retryAfterMs: Math.max(1, oldest + DAY_MS - now),
      });
    }

    state.requestTimes.push(now);
    if (estimatedTokens > 0) state.tokenEvents.push({ at: now, tokens: estimatedTokens });
  }

  /** Record actual token usage after a call completes (post-hoc accounting). */
  recordUsage(provider: string, keyId: string, tokens: number): void {
    if (!this.hasRule(provider)) throw new UnknownProviderError(provider);
    if (tokens <= 0) return;
    const now = this.now();
    const state = this.stateFor(provider, keyId);
    this.prune(state, now);
    state.tokenEvents.push({ at: now, tokens });
  }

  usage(provider: string, keyId: string): UsageSnapshot {
    const now = this.now();
    const state = this.stateFor(provider, keyId);
    this.prune(state, now);
    return {
      provider,
      keyId,
      requestsLastMinute: state.requestTimes.length,
      tokensLastDay: state.tokenEvents.reduce((sum, e) => sum + e.tokens, 0),
    };
  }

  /**
   * Exponential backoff for retry scheduling: base * 2^attempt, capped at 60s.
   * Deterministic on purpose so behaviour is testable and predictable. Uses
   * the provider's own backoffBaseMs when a provider is named, otherwise the
   * smallest registered base, otherwise 500ms.
   */
  nextBackoffMs(attempt: number, provider?: string): number {
    let base = provider ? this.rules.get(provider)?.backoffBaseMs : undefined;
    if (base === undefined) {
      const first = this.rules.values().next().value as ProviderRule | undefined;
      base = first?.backoffBaseMs ?? 500;
    }
    const step = Math.max(0, Math.floor(attempt));
    return Math.min(MAX_BACKOFF_MS, base * 2 ** step);
  }

  private stateFor(provider: string, keyId: string): KeyState {
    const id = `${provider}${keyId}`;
    let state = this.state.get(id);
    if (!state) {
      state = { requestTimes: [], tokenEvents: [] };
      this.state.set(id, state);
    }
    return state;
  }

  private prune(state: KeyState, now: number): void {
    const minuteCutoff = now - MINUTE_MS;
    state.requestTimes = state.requestTimes.filter((t) => t > minuteCutoff);
    const dayCutoff = now - DAY_MS;
    state.tokenEvents = state.tokenEvents.filter((e) => e.at > dayCutoff);
  }
}
