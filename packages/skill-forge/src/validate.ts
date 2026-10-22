import { createHash } from "node:crypto";
import {
  ForgeError,
  type ForgedSkillRecord,
  type SkillPropertyType,
  type SkillSpec,
} from "./types.js";

/**
 * Spec ids are `namespace.name` (further dotted segments allowed),
 * lowercase throughout: a letter-led segment of lowercase letters,
 * digits and hyphens, then one or more dot-separated segments of the
 * same shape. Matches the built-ins (`text.slugify`, `data.csv-to-json`).
 */
export const SPEC_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

const PROPERTY_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "object",
  "array",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(detail: string, skillId?: string): ForgeError {
  return new ForgeError("validate", detail, skillId);
}

/**
 * Structural validation of a spec. Throws a ForgeError at stage
 * "validate" on the first problem found. Accepts `unknown` because
 * specs arrive from stored records and (later) model output — neither
 * is trusted to be well-formed.
 */
export function assertValidSpec(spec: unknown): asserts spec is SkillSpec {
  if (!isPlainObject(spec)) throw invalid("Skill spec must be an object");
  const id = spec.id;
  if (typeof id !== "string" || !SPEC_ID_PATTERN.test(id)) {
    throw invalid(
      `Skill spec id must be lowercase "namespace.name" (got ${JSON.stringify(id)})`,
      typeof id === "string" ? id : undefined,
    );
  }
  if (typeof spec.name !== "string" || spec.name.trim() === "") {
    throw invalid(`Skill "${id}": name must be a non-empty string`, id);
  }
  if (typeof spec.description !== "string" || spec.description.trim() === "") {
    throw invalid(`Skill "${id}": description must be a non-empty string`, id);
  }
  if (!isPlainObject(spec.input)) {
    throw invalid(`Skill "${id}": input must be an object`, id);
  }
  const { required, properties } = spec.input as {
    required?: unknown;
    properties?: unknown;
  };
  if (!isPlainObject(properties)) {
    throw invalid(`Skill "${id}": input.properties must be an object`, id);
  }
  for (const [field, type] of Object.entries(properties)) {
    if (field === "") {
      throw invalid(`Skill "${id}": input.properties has an empty field name`, id);
    }
    if (typeof type !== "string" || !PROPERTY_TYPES.has(type)) {
      throw invalid(
        `Skill "${id}": input.properties.${field} must be one of ` +
          `${[...PROPERTY_TYPES].join(", ")} (got ${JSON.stringify(type)})`,
        id,
      );
    }
  }
  if (!Array.isArray(required)) {
    throw invalid(`Skill "${id}": input.required must be an array of field names`, id);
  }
  const seen = new Set<string>();
  for (const field of required) {
    if (typeof field !== "string") {
      throw invalid(`Skill "${id}": input.required entries must be strings`, id);
    }
    if (seen.has(field)) {
      throw invalid(`Skill "${id}": input.required lists "${field}" twice`, id);
    }
    seen.add(field);
    if (!(field in properties)) {
      throw invalid(
        `Skill "${id}": input.required lists "${field}", which is not in input.properties`,
        id,
      );
    }
  }
  if (typeof spec.source !== "string" || spec.source.trim() === "") {
    throw invalid(`Skill "${id}": source must be a non-empty string`, id);
  }
}

/**
 * Structural validation of a stored provenance record. A record whose
 * spec no longer validates (older format, hand-edited file, corruption)
 * fails here, which is how `loadForged` knows to skip it with a reason
 * instead of crashing the boot.
 */
export function assertValidRecord(
  record: unknown,
): asserts record is ForgedSkillRecord {
  if (!isPlainObject(record)) throw invalid("Forged skill record must be an object");
  assertValidSpec(record.spec);
  const spec = record.spec as SkillSpec;
  if (record.id !== spec.id) {
    throw invalid(
      `Forged skill record id ${JSON.stringify(record.id)} does not match its spec id "${spec.id}"`,
      spec.id,
    );
  }
  if (typeof record.specHash !== "string" || record.specHash === "") {
    throw invalid(`Forged skill record "${spec.id}": specHash must be a non-empty string`, spec.id);
  }
  if (typeof record.forgedAt !== "string" || record.forgedAt === "") {
    throw invalid(`Forged skill record "${spec.id}": forgedAt must be a non-empty string`, spec.id);
  }
}

/** The Skill Engine inputSchema for a spec, in the built-ins' shape. */
export function buildInputSchema(spec: SkillSpec): Record<string, unknown> {
  const properties: Record<string, { type: SkillPropertyType }> = {};
  for (const [field, type] of Object.entries(spec.input.properties)) {
    properties[field] = { type };
  }
  return {
    type: "object",
    properties,
    required: [...spec.input.required],
  };
}

/** Canonical JSON: object keys sorted at every depth, so the hash is field-order independent. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(",")}}`;
}

/** Stable SHA-256 of a spec's full content. Recorded as provenance at forge time. */
export function specHash(spec: SkillSpec): string {
  return createHash("sha256").update(canonicalize(spec), "utf8").digest("hex");
}
