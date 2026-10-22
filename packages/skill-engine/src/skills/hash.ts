import { createHash } from "node:crypto";
import { SkillInputError, type Skill } from "../types.js";

export type HashAlgorithm = "sha256" | "sha1" | "md5";

export interface HashInput {
  text: string;
  algorithm: HashAlgorithm;
}

export interface HashResult {
  /** Lowercase hex digest. */
  hash: string;
}

const ALGORITHMS: readonly HashAlgorithm[] = ["sha256", "sha1", "md5"];

export const hashSkill: Skill<HashInput, HashResult> = {
  id: "text.hash",
  name: "Hash Text",
  description: "Computes a sha256, sha1 or md5 hex digest of a text.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      algorithm: { type: "string", enum: [...ALGORITHMS] },
    },
    required: ["text", "algorithm"],
  },
  run(input) {
    const text = typeof input?.text === "string" ? input.text : "";
    const algorithm = input?.algorithm;
    if (!ALGORITHMS.includes(algorithm)) {
      throw new SkillInputError(
        "text.hash",
        `"algorithm" must be one of: ${ALGORITHMS.join(", ")}`,
      );
    }
    return {
      hash: createHash(algorithm).update(text, "utf8").digest("hex"),
    };
  },
};
