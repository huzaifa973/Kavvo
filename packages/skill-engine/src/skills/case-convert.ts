import { SkillInputError, type Skill } from "../types.js";

export type CaseConvertMode =
  | "upper"
  | "lower"
  | "title"
  | "camel"
  | "pascal"
  | "snake"
  | "kebab";

export interface CaseConvertInput {
  text: string;
  mode: CaseConvertMode;
}

export interface CaseConvertResult {
  text: string;
}

const MODES: readonly CaseConvertMode[] = [
  "upper",
  "lower",
  "title",
  "camel",
  "pascal",
  "snake",
  "kebab",
];

/** Splits text into alphanumeric word tokens on any separator run. */
function wordsOf(text: string): string[] {
  return text.split(/[^a-zA-Z0-9]+/).filter((w) => w.length > 0);
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

export const caseConvertSkill: Skill<CaseConvertInput, CaseConvertResult> = {
  id: "text.case-convert",
  name: "Case Convert",
  description:
    "Converts text between upper, lower, title, camel, pascal, snake and kebab case.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      mode: { type: "string", enum: [...MODES] },
    },
    required: ["text", "mode"],
  },
  run(input) {
    const text = typeof input?.text === "string" ? input.text : "";
    const mode = input?.mode;
    if (!MODES.includes(mode)) {
      throw new SkillInputError(
        "text.case-convert",
        `"mode" must be one of: ${MODES.join(", ")}`,
      );
    }
    switch (mode) {
      case "upper":
        return { text: text.toUpperCase() };
      case "lower":
        return { text: text.toLowerCase() };
      case "title":
        return {
          text: text.replace(/\w\S*/g, (word) => capitalize(word)),
        };
      case "camel": {
        const words = wordsOf(text);
        return {
          text: words
            .map((word, i) =>
              i === 0 ? word.toLowerCase() : capitalize(word),
            )
            .join(""),
        };
      }
      case "pascal":
        return { text: wordsOf(text).map(capitalize).join("") };
      case "snake":
        return {
          text: wordsOf(text)
            .map((word) => word.toLowerCase())
            .join("_"),
        };
      case "kebab":
        return {
          text: wordsOf(text)
            .map((word) => word.toLowerCase())
            .join("-"),
        };
    }
  },
};
