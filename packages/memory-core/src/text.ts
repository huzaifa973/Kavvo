/**
 * Text utilities behind the Memory Core's low-token design: normalization
 * for duplicate detection, tokenization for keyword retrieval, and the
 * token estimator every budget is measured with.
 */

/**
 * Rough token estimate: ~4 characters per token, the same chars/4
 * heuristic the Brain Router documents for its pre-call estimates.
 *
 * This is an ESTIMATE, not a count. Real tokenizers vary by model and by
 * text (code, URLs and non-English text all skew it). Budgets in this
 * package are enforced against this estimate, so the context the brain
 * receives is bounded in estimated tokens; a caller that needs a hard
 * guarantee against a specific model's tokenizer should leave headroom.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Canonical form for comparison: lowercase, punctuation replaced by
 * spaces, whitespace collapsed. "User lives in Multan." and
 * "user  lives in multan" normalize to the same string.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "as", "at", "by",
  "in", "on", "of", "to", "and", "or", "for", "with", "it", "its",
  "this", "that",
]);

/**
 * Significant tokens of a text: normalized, split, single characters and
 * stopwords dropped. Returned as a set, so repeats count once — keyword
 * overlap is about coverage, not frequency.
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of normalizeText(text).split(" ")) {
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

/** Jaccard similarity of two token sets: |intersection| / |union|. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Two texts are near-duplicates when their normalized forms are equal
 * (case / punctuation / whitespace variants) or their significant-token
 * sets overlap at or above this threshold (word-order variants, a
 * dropped filler word). Deliberately conservative: "user likes tea" vs
 * "user likes coffee" scores 0.5 and stays two memories.
 */
export const NEAR_DUPLICATE_THRESHOLD = 0.8;

export function areNearDuplicates(a: string, b: string): boolean {
  if (normalizeText(a) === normalizeText(b)) return true;
  return jaccardSimilarity(tokenize(a), tokenize(b)) >= NEAR_DUPLICATE_THRESHOLD;
}
