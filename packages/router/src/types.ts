export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Pin a specific BYOK key id for this call. Defaults to the first registered key. */
  keyId?: string;
}

/** Options handed to a provider. `apiKey` is the resolved BYOK secret, if any. */
export interface ProviderChatOptions extends ChatOptions {
  apiKey?: string;
}

export interface ProviderResponse {
  content: string;
  model?: string;
  usage?: { totalTokens?: number };
}

/**
 * A model provider behind the Brain Router. Real adapters (Groq, Gemini,
 * Ollama, ...) implement this interface; nothing outside the Router calls a
 * provider directly, so every call passes the Endpoint Rules guard first.
 */
export interface Provider {
  readonly id: string;
  chat(messages: ChatMessage[], opts: ProviderChatOptions): Promise<ProviderResponse>;
}

/** One entry in the Router's attempt log for a single chat() call. */
export interface AttemptRecord {
  provider: string;
  keyId?: string;
  outcome: "served" | "rate-limited" | "error";
  detail?: string;
}

export interface ChatResult extends ProviderResponse {
  /** Id of the provider that actually served the request. */
  provider: string;
  /** Key id used for the serving call, when a BYOK key was involved. */
  keyId?: string;
  /** Every provider tried, in order, including the one that served. */
  attempts: AttemptRecord[];
}

/** Thrown when every configured provider failed or was rate-limited. */
export class AllProvidersDownError extends Error {
  readonly attempts: AttemptRecord[];

  constructor(attempts: AttemptRecord[]) {
    super(
      `All providers failed (${attempts.length} tried): ` +
        attempts.map((a) => `${a.provider}:${a.outcome}`).join(", "),
    );
    this.name = "AllProvidersDownError";
    this.attempts = attempts;
  }
}
