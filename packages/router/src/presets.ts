import { KeyRegistry } from "./key-registry.js";
import {
  OpenAICompatibleProvider,
  type FetchImpl,
} from "./openai-compatible.js";

export interface ProviderPresetOptions {
  /** Model to request. Required — presets deliberately ship no default model. */
  model: string;
  /** BYOK key id to resolve at call time. Not needed for Ollama. */
  keyId?: string;
  /** Registry the key id resolves against. Not needed for Ollama. */
  keys?: KeyRegistry;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: FetchImpl;
}

/** Groq — https://api.groq.com/openai/v1 (BYOK key required). */
export function groqProvider(options: ProviderPresetOptions): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    ...options,
  });
}

/** OpenRouter — https://openrouter.ai/api/v1 (BYOK key required). */
export function openrouterProvider(
  options: ProviderPresetOptions,
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    ...options,
  });
}

/** Gemini via its OpenAI-compatible surface — https://generativelanguage.googleapis.com/v1beta/openai/ (BYOK key required). */
export function geminiProvider(options: ProviderPresetOptions): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    ...options,
  });
}

/** Local Ollama — http://localhost:11434/v1. Keyless: pass no keyId/keys. */
export function ollamaProvider(options: ProviderPresetOptions): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "ollama",
    baseUrl: "http://localhost:11434/v1",
    ...options,
  });
}
