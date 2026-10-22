import { SkillInputError, type Skill } from "../types.js";

export type UrlCodecAction = "encode" | "decode";

export interface UrlCodecInput {
  text: string;
  action: UrlCodecAction;
}

export interface UrlCodecResult {
  text: string;
}

export const urlCodecSkill: Skill<UrlCodecInput, UrlCodecResult> = {
  id: "text.url-codec",
  name: "URL Encode / Decode",
  description:
    "Percent-encodes or decodes a single URL component (encodeURIComponent semantics).",
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
    if (action !== "encode" && action !== "decode") {
      throw new SkillInputError(
        "text.url-codec",
        `"action" must be "encode" or "decode"`,
      );
    }
    try {
      return {
        text:
          action === "encode"
            ? encodeURIComponent(text)
            : decodeURIComponent(text),
      };
    } catch (err) {
      // decodeURIComponent throws URIError on malformed % sequences and
      // encodeURIComponent on lone surrogates; surface both cleanly.
      throw new SkillInputError(
        "text.url-codec",
        err instanceof Error ? err.message : String(err),
      );
    }
  },
};
