/**
 * Memory Core data model.
 *
 * A memory is one durable, human-readable statement about the user:
 * a fact, a preference, a person, a project, or a free-form note. The
 * core stores many of them cheaply and spends tokens only at retrieval
 * time, where a strict budget decides what enters the brain's context
 * (see core.ts for the scoring rule and the budget contract).
 */

export type MemoryKind = "fact" | "preference" | "person" | "project" | "note";

export const MEMORY_KINDS: readonly MemoryKind[] = [
  "fact",
  "preference",
  "person",
  "project",
  "note",
];

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  /** The memory itself, as one terse statement. Terseness is token budget. */
  text: string;
  tags: string[];
  /** Integer 1 (background) to 5 (never lose this). Weighs retrieval. */
  importance: number;
  createdAt: string;
  updatedAt: string;
  /** Last time retrieval actually surfaced this item. */
  lastAccessedAt: string;
  accessCount: number;
  /** Where the memory came from ("user", "composer-job-42", ...). */
  source?: string;
}

/** What a caller supplies to `MemoryStore.add`; the store fills the rest. */
export interface AddMemoryInput {
  kind: MemoryKind;
  text: string;
  tags?: string[];
  /** Defaults to 3. */
  importance?: number;
  source?: string;
}

export interface MemoryListFilter {
  kind?: MemoryKind;
  /** Case-insensitive exact tag match. */
  tag?: string;
}

export interface MemoryStats {
  total: number;
  byKind: Record<MemoryKind, number>;
}

export interface RetrieveOptions {
  /**
   * Budget in ESTIMATED tokens (see estimateTokens in text.ts). Items are
   * admitted greedily in score order while their rendered cost fits.
   * Defaults to 800.
   */
  tokenBudget?: number;
  /** Hard cap on returned items regardless of budget. Defaults to 10. */
  maxItems?: number;
}

export interface ScoredMemoryItem {
  item: MemoryItem;
  /** 3 * overlap + 2 * (importance / 5) + recency. See core.ts. */
  score: number;
  /** Fraction of the query's significant tokens found in the item, 0..1. */
  overlap: number;
  /** Estimated tokens of this item's rendered context line ("- text"). */
  estimatedTokens: number;
}

export interface MemoryContext {
  /** The assembled context string, grouped by kind. "" when nothing fit. */
  text: string;
  items: ScoredMemoryItem[];
  /** estimateTokens(text). Guaranteed <= the requested budget. */
  estimatedTokens: number;
}

export interface CompressionReport {
  /** Items removed because they merged into a survivor. */
  merged: number;
  before: number;
  after: number;
}

/** Thrown when a memory or add-input fails validation. */
export class MemoryValidationError extends Error {
  constructor(detail: string) {
    super(`Invalid memory: ${detail}`);
    this.name = "MemoryValidationError";
  }
}
