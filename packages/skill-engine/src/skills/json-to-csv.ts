import { SkillInputError, type Skill } from "../types.js";

export interface JsonToCsvInput {
  rows: Array<Record<string, unknown>>;
}

export interface JsonToCsvResult {
  csv: string;
}

/** Quotes a field when it contains a comma, quote or newline (RFC 4180). */
function escapeField(value: string): string {
  return /[",\n\r]/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value) ?? "";
}

export const jsonToCsvSkill: Skill<JsonToCsvInput, JsonToCsvResult> = {
  id: "data.json-to-csv",
  name: "JSON to CSV",
  description:
    "Serializes an array of flat objects to CSV, with headers from the union of keys in first-seen order.",
  inputSchema: {
    type: "object",
    properties: {
      rows: { type: "array", items: { type: "object" } },
    },
    required: ["rows"],
  },
  run(input) {
    const rows = input?.rows;
    if (!Array.isArray(rows)) {
      throw new SkillInputError(
        "data.json-to-csv",
        `"rows" must be an array of objects`,
      );
    }
    for (const row of rows) {
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        throw new SkillInputError(
          "data.json-to-csv",
          `"rows" must be an array of objects`,
        );
      }
    }
    if (rows.length === 0) return { csv: "" };
    const headers: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) {
          seen.add(key);
          headers.push(key);
        }
      }
    }
    const lines = [headers.map(escapeField).join(",")];
    for (const row of rows) {
      lines.push(
        headers.map((header) => escapeField(cellText(row[header]))).join(","),
      );
    }
    return { csv: lines.join("\n") };
  },
};
