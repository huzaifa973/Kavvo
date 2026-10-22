import { SkillInputError, type Skill } from "../types.js";

export type Base64Action = "encode" | "decode";

export interface Base64Input {
  text: string;
  action: Base64Action;
}

export interface Base64Result {
  text: string;
}

/** Canonical base64: groups of 4 alphabet chars, optional = padding. */
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const base64Skill: Skill<Base64Input, Base64Result> = {
  id: "text.base64",
  name: "Base64 Encode / Decode",
  description:
    "Encodes text to base64 or decodes base64 back to text, UTF-8 safe in both directions.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      action: { type: "string", enum: ["encode", "decode"] },
    },
    required: ["text", "action"],
  },
  run(input) {
    const text = typeof input?.text === "string" ? input.text : "";
    const action = input?.action;
    if (action === "encode") {
      return { text: Buffer.from(text, "utf8").toString("base64") };
    }
    if (action === "decode") {
      // Buffer.from(..., "base64") silently ignores invalid characters,
      // so decode validates strictly and rejects malformed input with a
      // SkillInputError instead of returning garbage.
      const compact = text.replace(/\s/g, "");
      if (!BASE64_PATTERN.test(compact)) {
        throw new SkillInputError(
          "text.base64",
          "input is not valid base64 (standard alphabet, correct padding required)",
        );
      }
      return { text: Buffer.from(compact, "base64").toString("utf8") };
    }
    throw new SkillInputError(
      "text.base64",
      `"action" must be "encode" or "decode"`,
    );
  },
};
