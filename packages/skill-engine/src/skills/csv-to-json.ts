import type { Skill } from "../types.js";

export interface CsvToJsonInput {
  csv: string;
}

export interface CsvToJsonResult {
  rows: Array<Record<string, string>>;
}

/**
 * Minimal RFC-4180-style CSV parser: quoted fields may contain commas,
 * newlines and escaped quotes (""), and both LF and CRLF line endings
 * are accepted. Returns one string array per record.
 */
export function parseCsv(csv: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };
  let i = 0;
  while (i < csv.length) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      endRecord();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Flush a final record that has no trailing newline.
  if (field.length > 0 || record.length > 0) endRecord();
  return records;
}

export const csvToJsonSkill: Skill<CsvToJsonInput, CsvToJsonResult> = {
  id: "data.csv-to-json",
  name: "CSV to JSON",
  description:
    "Parses CSV text (first row is the header) into an array of row objects.",
  inputSchema: {
    type: "object",
    properties: { csv: { type: "string" } },
    required: ["csv"],
  },
  run(input) {
    const csv = typeof input?.csv === "string" ? input.csv : "";
    const records = parseCsv(csv);
    if (records.length === 0) return { rows: [] };
    const headers = records[0];
    const rows = records.slice(1).map((record) => {
      const row: Record<string, string> = {};
      headers.forEach((header, idx) => {
        row[header] = record[idx] ?? "";
      });
      return row;
    });
    return { rows };
  },
};
