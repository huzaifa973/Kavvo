import { StepReferenceError } from "./types.js";

/**
 * Step-output references.
 *
 * Inside any string in a step's input (or a chat step's messages), a
 * placeholder `{{stepId}}` or `{{stepId.field}}` / `{{stepId.a.b.c}}`
 * points at the output of an earlier, completed step:
 *
 *   - `stepId` is the id of a previous step in the same job.
 *   - The optional dot path walks into that step's output value
 *     (object fields and array indexes).
 *
 * Two substitution modes:
 *
 *   - A string that is exactly one placeholder is replaced by the
 *     referenced value AS-IS, keeping its type (object, number, ...).
 *   - Placeholders embedded in a longer string are interpolated as
 *     text: primitives via String(), objects via JSON.stringify().
 *
 * Resolution walks plain objects and arrays recursively; other values
 * pass through untouched. Referencing a step that has not completed, or
 * a field that does not exist, throws StepReferenceError, which the
 * Composer records as that step's failure.
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g;
const WHOLE_PLACEHOLDER =
  /^\{\{\s*([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+)*)\s*\}\}$/;

function lookup(
  outputs: ReadonlyMap<string, unknown>,
  stepId: string,
  path: string,
  raw: string,
): unknown {
  if (!outputs.has(stepId)) {
    throw new StepReferenceError(
      `${raw} — step "${stepId}" has not completed (references may only point to earlier, completed steps)`,
    );
  }
  let current: unknown = outputs.get(stepId);
  if (path) {
    for (const segment of path.slice(1).split(".")) {
      if (
        current === null ||
        typeof current !== "object" ||
        !(segment in current)
      ) {
        throw new StepReferenceError(
          `${raw} — step "${stepId}" output has no field "${segment}"`,
        );
      }
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

function resolveString(
  value: string,
  outputs: ReadonlyMap<string, unknown>,
): unknown {
  const whole = WHOLE_PLACEHOLDER.exec(value);
  if (whole) return lookup(outputs, whole[1], whole[2] ?? "", value);
  return value.replace(PLACEHOLDER, (raw, stepId: string, path: string) => {
    const resolved = lookup(outputs, stepId, path ?? "", raw);
    return typeof resolved === "object" && resolved !== null
      ? JSON.stringify(resolved)
      : String(resolved);
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Deep-resolve every placeholder in `value` against completed step outputs. */
export function resolveTemplates<T>(
  value: T,
  outputs: ReadonlyMap<string, unknown>,
): T {
  if (typeof value === "string") {
    return resolveString(value, outputs) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplates(item, outputs)) as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = resolveTemplates(item, outputs);
    }
    return out as T;
  }
  return value;
}
