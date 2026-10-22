import { areNearDuplicates, estimateTokens, tokenize } from "./text.js";
import type { MemoryStore } from "./store.js";
import {
  MEMORY_KINDS,
  type CompressionReport,
  type MemoryContext,
  type MemoryItem,
  type MemoryKind,
  type RetrieveOptions,
  type ScoredMemoryItem,
} from "./types.js";

/**
 * Retrieval and compression: the low-token surface of the Memory Core.
 *
 * The store may hold thousands of memories; none of them cost a token
 * until a task asks. Retrieval scores every item against the query and
 * admits the best ones inside a strict ESTIMATED-token budget, so what
 * reaches the brain is a small, relevant, terse context — never a raw
 * history dump.
 *
 * Scoring rule (scoreMemoryItem), all components in 0..1:
 *
 *   score = 3 * overlap + 2 * (importance / 5) + 1 * recency
 *
 * - overlap: fraction of the query's significant tokens found in the
 *   item's text or tags. It carries the largest weight, and it is a
 *   hard gate: zero-overlap items are NEVER returned, however
 *   important or recent they are.
 * - importance: the item's 1..5 rating, normalized. With overlap tied,
 *   its swing (up to 1.6 between rating 1 and 5) always beats
 *   recency's maximum swing (1.0) — a crucial old fact outranks a
 *   trivial new one.
 * - recency: exponential decay on updatedAt with a 30-day half-life,
 *   2^(-ageDays / 30). A memory touched today scores 1, one untouched
 *   for a month 0.5, for three months 0.125.
 */

export const DEFAULT_TOKEN_BUDGET = 800;
export const DEFAULT_MAX_ITEMS = 10;

const DAY_MS = 86_400_000;
const RECENCY_HALF_LIFE_DAYS = 30;

export interface MemoryCoreOptions {
  /** Injectable clock for tests (ms epoch). Defaults to Date.now. */
  now?: () => number;
}

export interface ItemScore {
  score: number;
  overlap: number;
}

/** Scores one item against pre-tokenized query tokens. Pure. */
export function scoreMemoryItem(
  item: MemoryItem,
  queryTokens: ReadonlySet<string>,
  nowMs: number,
): ItemScore {
  if (queryTokens.size === 0) return { score: 0, overlap: 0 };
  const itemTokens = tokenize(item.text);
  for (const tag of item.tags) {
    for (const token of tokenize(tag)) itemTokens.add(token);
  }
  let hits = 0;
  for (const token of queryTokens) if (itemTokens.has(token)) hits++;
  const overlap = hits / queryTokens.size;

  const updatedMs = Date.parse(item.updatedAt);
  const ageDays = Number.isNaN(updatedMs)
    ? Number.POSITIVE_INFINITY
    : Math.max(0, (nowMs - updatedMs) / DAY_MS);
  const recency = Math.pow(2, -ageDays / RECENCY_HALF_LIFE_DAYS);

  return {
    overlap,
    score: 3 * overlap + 2 * (item.importance / 5) + recency,
  };
}

/** The one rendered line an item contributes to a context string. */
export function renderContextLine(item: MemoryItem): string {
  return `- ${item.text}`;
}

function byScoreThenStable(
  a: ScoredMemoryItem,
  b: ScoredMemoryItem,
): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.item.importance !== a.item.importance) {
    return b.item.importance - a.item.importance;
  }
  if (b.item.updatedAt !== a.item.updatedAt) {
    return b.item.updatedAt < a.item.updatedAt ? -1 : 1;
  }
  return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
}

export class MemoryCore {
  private readonly now: () => number;

  constructor(
    readonly store: MemoryStore,
    options: MemoryCoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** All items with nonzero overlap, scored and sorted, budget ignored. */
  private async candidates(query: string): Promise<ScoredMemoryItem[]> {
    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) return [];
    const nowMs = this.now();
    const scored: ScoredMemoryItem[] = [];
    for (const item of await this.store.list()) {
      const { score, overlap } = scoreMemoryItem(item, queryTokens, nowMs);
      if (overlap === 0) continue;
      scored.push({
        item,
        score,
        overlap,
        estimatedTokens: estimateTokens(renderContextLine(item)),
      });
    }
    return scored.sort(byScoreThenStable);
  }

  /** Swaps in the post-bump copies recordAccess returns. */
  private async bumpAccess(
    selected: ScoredMemoryItem[],
  ): Promise<ScoredMemoryItem[]> {
    const out: ScoredMemoryItem[] = [];
    for (const entry of selected) {
      const updated = await this.store.recordAccess(entry.item.id);
      out.push(updated ? { ...entry, item: updated } : entry);
    }
    return out;
  }

  /**
   * The top memories for a query that fit the token budget.
   *
   * Admission is greedy in score order with skip-and-continue: an item
   * whose rendered line would push the running total over the budget is
   * skipped, and smaller items behind it may still fit. The sum of the
   * returned items' estimatedTokens never exceeds the budget. Returned
   * items have their access tracked (accessCount + 1, lastAccessedAt
   * set — persisted by the file store).
   */
  async retrieve(
    query: string,
    options: RetrieveOptions = {},
  ): Promise<ScoredMemoryItem[]> {
    const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
    const selected: ScoredMemoryItem[] = [];
    let used = 0;
    for (const entry of await this.candidates(query)) {
      if (selected.length >= maxItems) break;
      if (used + entry.estimatedTokens > tokenBudget) continue;
      used += entry.estimatedTokens;
      selected.push(entry);
    }
    return this.bumpAccess(selected);
  }

  /**
   * The compact context string the brain consumes: retrieved items
   * grouped by kind under terse `## kind` headers, one `- text` line
   * each, kinds in MEMORY_KINDS order and items in score order within
   * a kind.
   *
   * Budget guarantee: admission re-renders the whole string (headers
   * included) for every candidate and only commits items that keep
   * estimateTokens(text) <= tokenBudget, so the returned
   * estimatedTokens NEVER exceeds the budget. Only the items actually
   * included get their access tracked.
   */
  async buildContext(
    query: string,
    options: RetrieveOptions = {},
  ): Promise<MemoryContext> {
    const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
    const groups = new Map<MemoryKind, ScoredMemoryItem[]>();
    const selected: ScoredMemoryItem[] = [];

    const render = (
      extra?: { kind: MemoryKind; entry: ScoredMemoryItem },
    ): string => {
      const sections: string[] = [];
      for (const kind of MEMORY_KINDS) {
        const entries = [...(groups.get(kind) ?? [])];
        if (extra && extra.kind === kind) entries.push(extra.entry);
        if (entries.length === 0) continue;
        sections.push(
          `## ${kind}\n${entries.map((e) => renderContextLine(e.item)).join("\n")}`,
        );
      }
      return sections.join("\n");
    };

    for (const entry of await this.candidates(query)) {
      if (selected.length >= maxItems) break;
      const tentative = render({ kind: entry.item.kind, entry });
      if (estimateTokens(tentative) > tokenBudget) continue;
      const group = groups.get(entry.item.kind) ?? [];
      group.push(entry);
      groups.set(entry.item.kind, group);
      selected.push(entry);
    }

    const text = render();
    const bumped = await this.bumpAccess(selected);
    return { text, items: bumped, estimatedTokens: estimateTokens(text) };
  }

  /**
   * Rule-based compression, v1: merges near-duplicate clusters (same
   * kind, same areNearDuplicates rule as add()) and reports what it
   * did. Nothing else is dropped or rewritten — v1 never destroys a
   * distinct memory.
   *
   * Per cluster, the survivor keeps the id and text of the strongest
   * member (highest importance, then most recently updated); the
   * merged item takes the cluster's max importance, the union of its
   * tags, the sum of its accessCounts, its earliest createdAt and its
   * latest lastAccessedAt.
   *
   * SEAM FOR LATER: model-written summaries plug in here. A summarizer
   * that folds a cluster (or an old tail of notes) into one shorter
   * memory would run inside compress() behind this same report shape,
   * so callers never change. It is deliberately absent in v1: no model
   * call may silently rewrite what the user remembers.
   */
  async compress(): Promise<CompressionReport> {
    const items = await this.store.list();
    const before = items.length;

    // Union-find over near-duplicate pairs of the same kind.
    const parent = items.map((_, i) => i);
    const find = (i: number): number => {
      let root = i;
      while (parent[root] !== root) root = parent[root]!;
      while (parent[i] !== root) {
        const next = parent[i]!;
        parent[i] = root;
        i = next;
      }
      return root;
    };
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]!;
        const b = items[j]!;
        if (a.kind === b.kind && areNearDuplicates(a.text, b.text)) {
          const ra = find(i);
          const rb = find(j);
          if (ra !== rb) parent[ra] = rb;
        }
      }
    }
    const clusters = new Map<number, MemoryItem[]>();
    items.forEach((item, i) => {
      const root = find(i);
      const cluster = clusters.get(root) ?? [];
      cluster.push(item);
      clusters.set(root, cluster);
    });

    let merged = 0;
    for (const cluster of clusters.values()) {
      if (cluster.length < 2) continue;
      const ranked = [...cluster].sort((a, b) => {
        if (b.importance !== a.importance) return b.importance - a.importance;
        if (b.updatedAt !== a.updatedAt) return b.updatedAt < a.updatedAt ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      });
      const survivor = ranked[0]!;
      const tags: string[] = [];
      const seenTags = new Set<string>();
      for (const member of ranked) {
        for (const tag of member.tags) {
          const key = tag.toLowerCase();
          if (seenTags.has(key)) continue;
          seenTags.add(key);
          tags.push(tag);
        }
      }
      const mergedItem: MemoryItem = {
        ...survivor,
        tags,
        importance: Math.max(...cluster.map((m) => m.importance)),
        accessCount: cluster.reduce((sum, m) => sum + m.accessCount, 0),
        createdAt: cluster.reduce(
          (min, m) => (m.createdAt < min ? m.createdAt : min),
          survivor.createdAt,
        ),
        lastAccessedAt: cluster.reduce(
          (max, m) => (m.lastAccessedAt > max ? m.lastAccessedAt : max),
          survivor.lastAccessedAt,
        ),
        updatedAt: new Date(this.now()).toISOString(),
      };
      if (mergedItem.source === undefined) {
        mergedItem.source = cluster.find((m) => m.source !== undefined)?.source;
      }
      await this.store.save(mergedItem);
      for (const member of cluster) {
        if (member.id === survivor.id) continue;
        await this.store.forget(member.id);
        merged++;
      }
    }

    return { merged, before, after: before - merged };
  }
}
