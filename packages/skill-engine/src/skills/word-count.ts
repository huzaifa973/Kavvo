import type { Skill } from "../types.js";

export interface WordCountInput {
  text: string;
}

export interface WordCountResult {
  words: number;
  characters: number;
  charactersNoSpaces: number;
  sentences: number;
  paragraphs: number;
  /** Reading time at an average 200 words per minute. */
  readingTimeMinutes: number;
  readingTimeSeconds: number;
}

const WORDS_PER_MINUTE = 200;

export const wordCountSkill: Skill<WordCountInput, WordCountResult> = {
  id: "text.word-count",
  name: "Word Count",
  description:
    "Counts words, characters, sentences and paragraphs in a text and estimates reading time.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  run(input) {
    const text = typeof input?.text === "string" ? input.text : "";
    const words = text.match(/\S+/g)?.length ?? 0;
    const sentences =
      text
        .split(/[.!?]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0).length || (words > 0 ? 1 : 0);
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0).length;
    const readingTimeMinutes =
      Math.round((words / WORDS_PER_MINUTE) * 100) / 100;
    return {
      words,
      characters: text.length,
      charactersNoSpaces: text.replace(/\s/g, "").length,
      sentences,
      paragraphs,
      readingTimeMinutes,
      readingTimeSeconds: Math.ceil((words / WORDS_PER_MINUTE) * 60),
    };
  },
};
