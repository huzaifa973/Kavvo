import { SkillInputError, type Skill } from "../types.js";

export type JsonFormatMode = "pretty" | "minify";

export interface JsonFormatInput {
  text: string;
  mode: JsonFormatMode;
}

export interface JsonFormatResult {
  text: string;
}

export const jsonFormatSkill: Skill<JsonFormatInput, JsonFormatResult> = {
  id: "data.json-format",
  name: "JSON Format",
  description:
    "Pretty-prints JSON with 2-space indentation or minifies it onto one line.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      mode: { type: "string", enum: ["pretty", "minify"] },
    },
    required: ["text", "mode"],
  },
  run(input) {
    const text = typeof input?.text === "string" ? input.text : "";
    const mode = input?.mode;
    if (mode !== "pretty" && mode !== "minify") {
      throw new SkillInputError(
        "data.json-format",
        `"mode" must be "pretty" or "minify"`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new SkillInputError(
        "data.json-format",
        `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {
      text:
        mode === "pretty"
          ? JSON.stringify(parsed, null, 2)
          : JSON.stringify(parsed),
    };
  },
};
