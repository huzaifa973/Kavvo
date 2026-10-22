import type {
  ChatMessage,
  Provider,
  ProviderChatOptions,
  ProviderResponse,
} from "./types.js";

export interface MockProviderOptions {
  /** Fixed content to return. Ignored when `handler` is set. */
  content?: string;
  /** Error to throw on every call (simulates a provider outage). */
  error?: Error;
  /** Custom behaviour; takes precedence over content/error. */
  handler?: (
    messages: ChatMessage[],
    opts: ProviderChatOptions,
  ) => Promise<ProviderResponse> | ProviderResponse;
}

/** Test double for a real provider adapter. Records every call it receives. */
export class MockProvider implements Provider {
  readonly id: string;
  callCount = 0;
  lastMessages: ChatMessage[] | undefined;
  lastOpts: ProviderChatOptions | undefined;

  constructor(id: string, private readonly options: MockProviderOptions = {}) {
    this.id = id;
  }

  async chat(
    messages: ChatMessage[],
    opts: ProviderChatOptions,
  ): Promise<ProviderResponse> {
    this.callCount += 1;
    this.lastMessages = messages;
    this.lastOpts = opts;
    if (this.options.handler) return this.options.handler(messages, opts);
    if (this.options.error) throw this.options.error;
    return {
      content: this.options.content ?? `mock response from ${this.id}`,
      model: `${this.id}-mock`,
      usage: { totalTokens: 10 },
    };
  }
}
