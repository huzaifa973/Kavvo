import { randomUUID } from "node:crypto";
import type { Skill } from "../types.js";

export interface UuidInput {
  /** How many UUIDs to generate. Defaults to 1, capped at 100. */
  count?: number;
}

export interface UuidResult {
  uuids: string[];
}

const MAX_COUNT = 100;

export const uuidSkill: Skill<UuidInput, UuidResult> = {
  id: "util.uuid",
  name: "Generate UUID",
  description: "Generates random UUID v4 values (1 by default, up to 100).",
  inputSchema: {
    type: "object",
    properties: {
      count: { type: "number", minimum: 1, maximum: MAX_COUNT },
    },
    required: [],
  },
  run(input) {
    // Out-of-range counts are clamped into 1..100 rather than rejected,
    // so a caller asking for "a lot" still gets a useful answer.
    const raw =
      typeof input?.count === "number" && Number.isFinite(input.count)
        ? Math.floor(input.count)
        : 1;
    const count = Math.min(MAX_COUNT, Math.max(1, raw));
    return {
      uuids: Array.from({ length: count }, () => randomUUID()),
    };
  },
};
