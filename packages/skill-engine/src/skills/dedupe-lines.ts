import type { Skill } from "../types.js";

export interface DedupeLinesInput {
  text: string;
  /** When true, the surviving unique lines are sorted alphabetically. */
  sort?: boolean;
}

export interface DedupeLinesResult {
  text: string;
  /** How many duplicate lines were removed. */
  removed: number;
}

export const dedupeLinesSkill: Skill<DedupeLinesInput, DedupeLinesResult> = {
  id: "text.dedupe-lines",
  name: "Dedupe Lines",
  description:
    "Removes duplicate lines from a text, keeping first-occurrence order (or sorted order on request).",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      sort: { type: "boolean" },
    },
    required: ["text"],
  },
  run(input) {
    const text = typeof input?.text === "string" ? input.text : "";
    // A trailing newline terminates the last line; it is not an extra
    // empty line, so the split artifact is dropped and the newline is
    // restored on the output.
    const hasTrailingNewline = /\n$/.test(text);
    const lines = text.split(/\r?\n/);
    if (hasTrailingNewline) lines.pop();
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const line of lines) {
      if (!seen.has(line)) {
        seen.add(line);
        unique.push(line);
      }
    }
    const removed = lines.length - unique.length;
    if (input?.sort === true) unique.sort();
    return {
      text: unique.join("\n") + (hasTrailingNewline ? "\n" : ""),
      removed,
    };
  },
};
