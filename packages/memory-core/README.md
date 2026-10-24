# @kavvo/memory-core — Memory Core

Strong long-term memory with a strict token budget. The store may hold
thousands of memories about the user (facts, preferences, people,
projects, notes); none of them cost a token until a task asks, and
retrieval returns only what the task needs, inside a budget.

## Memory items

```ts
interface MemoryItem {
  id: string;
  kind: "fact" | "preference" | "person" | "project" | "note";
  text: string;            // one terse statement — terseness is budget
  tags: string[];
  importance: number;      // integer 1..5
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;  // last time retrieval surfaced this item
  accessCount: number;
  source?: string;
}
```

## Stores

`MemoryStore` has two implementations, mirroring the Composer's
JobStore split:

- `InMemoryMemoryStore` — per-process; copies in and out.
- `FileMemoryStore` — one JSON file per memory (`<dir>/<id>.json`)
  under a caller-provided directory, temp-file + rename writes, the
  disk as source of truth. A new instance over the same directory
  sees everything a previous one wrote, including access bumps:
  memories survive full process restarts.

`add(input)` is the smart front door. If an item of the same kind has
near-identical normalized text, it is updated instead of duplicated:
`updatedAt` refreshes, the higher importance wins, tags merge, and the
existing id is returned. Near-identical means: the normalized texts
(lowercase, punctuation stripped, whitespace collapsed) are equal, or
their significant-token sets have Jaccard similarity ≥ 0.8 (word-order
variants). "user likes tea" vs "user likes coffee" scores 0.5 and
stays two memories.

`save(item)` is the raw, validated upsert (used by compression and by
callers managing whole items). Also on the interface: `get`, `list`
(filter by kind and/or case-insensitive tag), `forget(id)` (returns
whether anything was removed), `recordAccess(id)`, and `stats()`
(counts by kind). Stores take an injectable clock (`now`, ms epoch)
for tests.

## Retrieval

`MemoryCore.retrieve(query, { tokenBudget = 800, maxItems = 10 })`
scores every item and admits the best inside the budget:

```
score = 3 * overlap + 2 * (importance / 5) + recency
```

- **overlap** — fraction of the query's significant tokens (tokenized,
  stopwords and single characters dropped) found in the item's text or
  tags. Zero-overlap items are never returned, however important.
- **importance** — with overlap tied, its swing (up to 1.6) always
  beats recency's maximum swing (1.0): a crucial old fact outranks a
  trivial new one.
- **recency** — `2^(-ageDays / 30)` on `updatedAt`: a 30-day
  half-life.

Admission is greedy in score order with skip-and-continue: an item
whose rendered line would exceed the budget is skipped, and smaller
items behind it may still fit. Returned items get their access
tracked (`accessCount + 1`, `lastAccessedAt` set — persisted by the
file store).

`MemoryCore.buildContext(query, opts)` returns the string the brain
actually consumes: items grouped under terse `## kind` headers in
fixed kind order, one `- text` line each, score order within a kind.
Admission re-renders the whole string (headers included) per item, so
the returned `estimatedTokens` NEVER exceeds the budget.

### Token estimates are estimates

All budgets are enforced against `estimateTokens(text) =
ceil(chars / 4)`, the same documented heuristic the Brain Router uses
for pre-call estimates. Real tokenizers vary by model and text; a
caller needing a hard guarantee against a specific model's tokenizer
should leave headroom under the budget.

## Compression

`MemoryCore.compress()` is rule-based in v1: it merges near-duplicate
clusters (same rule as `add`, so duplicates that arrived via raw
files or old data collapse too) and returns
`{ merged, before, after }`. Per cluster, the survivor keeps the id
and text of the strongest member (highest importance, then most
recently updated) with the cluster's max importance, unioned tags,
summed access counts, earliest `createdAt` and latest
`lastAccessedAt`. Nothing distinct is ever dropped or rewritten.

**The model-summary seam:** a future model-written summarizer (fold a
cluster, or an old tail of notes, into one shorter memory) plugs into
`compress()` behind this same report shape, so callers never change.
It is deliberately absent in v1: no model call may silently rewrite
what the user remembers.

## Usage

```ts
import { FileMemoryStore, MemoryCore } from "@kavvo/memory-core";

const core = new MemoryCore(new FileMemoryStore("./data/memory"));
await core.store.add({
  kind: "preference",
  text: "User prefers tea in the morning",
  tags: ["drinks"],
  importance: 4,
});

const { text, estimatedTokens } = await core.buildContext(
  "what does the user drink in the morning",
  { tokenBudget: 400 },
);
// text is ready to drop into a prompt; estimatedTokens <= 400.
```
