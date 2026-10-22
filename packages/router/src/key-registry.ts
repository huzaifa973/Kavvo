interface KeyEntry {
  keyId: string;
  secret: string;
}

/**
 * BYOK key registry: the user's own provider keys, held in memory only.
 * The public surface exposes key IDS, never secrets. Secrets leave the
 * registry only through resolveSecret(), called by the Router at call time
 * and passed straight to the provider adapter. Nothing here logs anything.
 */
export class KeyRegistry {
  private readonly keys = new Map<string, KeyEntry[]>();

  addKey(provider: string, keyId: string, secret: string): void {
    const list = this.keys.get(provider) ?? [];
    if (list.some((k) => k.keyId === keyId)) {
      throw new Error(`Key id "${keyId}" already registered for provider "${provider}"`);
    }
    list.push({ keyId, secret });
    this.keys.set(provider, list);
  }

  removeKey(provider: string, keyId: string): boolean {
    const list = this.keys.get(provider);
    if (!list) return false;
    const next = list.filter((k) => k.keyId !== keyId);
    if (next.length === list.length) return false;
    if (next.length === 0) this.keys.delete(provider);
    else this.keys.set(provider, next);
    return true;
  }

  /** Key ids only — safe to display or log. */
  listKeyIds(provider: string): string[] {
    return (this.keys.get(provider) ?? []).map((k) => k.keyId);
  }

  providers(): string[] {
    return [...this.keys.keys()];
  }

  firstKeyId(provider: string): string | undefined {
    return this.keys.get(provider)?.[0]?.keyId;
  }

  /** Internal: resolve the secret for a key id at call time. Never log the result. */
  resolveSecret(provider: string, keyId: string): string | undefined {
    return this.keys.get(provider)?.find((k) => k.keyId === keyId)?.secret;
  }
}
