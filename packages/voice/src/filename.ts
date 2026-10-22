/**
 * Pure helpers for naming synthesized-audio output files. Kept free
 * of any I/O so they are unit-testable without Python or a disk.
 */

/** Lowercase, diacritic-free slug of at most ~48 chars (may be ""). */
export function slugifyForFilename(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= 48) return slug;
  // Cut on a word boundary when one exists in the back half.
  const cut = slug.lastIndexOf("-", 48);
  return slug.slice(0, cut > 24 ? cut : 48).replace(/-+$/g, "");
}

/** Compact UTC timestamp: 20261022T081530 (no separators Date.parse hates less). */
export function filenameTimestamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

/**
 * The WAV filename for one synthesis: `tts-<slug>-<timestamp>.wav`.
 * The slug captures a readable hint of the text; the timestamp keeps
 * repeated syntheses of the same text from overwriting each other.
 * Text with no slug-able characters falls back to `tts-<timestamp>.wav`.
 */
export function buildWavFilename(text: string, now: Date): string {
  const slug = slugifyForFilename(text);
  const stamp = filenameTimestamp(now);
  return slug ? `tts-${slug}-${stamp}.wav` : `tts-${stamp}.wav`;
}
