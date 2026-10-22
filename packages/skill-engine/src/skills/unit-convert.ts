import { SkillInputError, type Skill } from "../types.js";

export interface UnitConvertInput {
  value: number;
  from: string;
  to: string;
}

export interface UnitConvertResult {
  value: number;
  /** The target unit (the input's `to`, lowercased). */
  unit: string;
}

type UnitFamily = "length" | "weight" | "temperature";

/** Linear units: factor to the family base (metre for length, gram for weight). */
const LINEAR_UNITS: Record<string, { family: UnitFamily; toBase: number }> = {
  mm: { family: "length", toBase: 0.001 },
  cm: { family: "length", toBase: 0.01 },
  m: { family: "length", toBase: 1 },
  km: { family: "length", toBase: 1000 },
  in: { family: "length", toBase: 0.0254 },
  ft: { family: "length", toBase: 0.3048 },
  yd: { family: "length", toBase: 0.9144 },
  mi: { family: "length", toBase: 1609.344 },
  g: { family: "weight", toBase: 1 },
  kg: { family: "weight", toBase: 1000 },
  lb: { family: "weight", toBase: 453.59237 },
  oz: { family: "weight", toBase: 28.349523125 },
};

const TEMPERATURE_UNITS: ReadonlySet<string> = new Set(["c", "f", "k"]);

function familyOf(unit: string): UnitFamily | undefined {
  if (TEMPERATURE_UNITS.has(unit)) return "temperature";
  return LINEAR_UNITS[unit]?.family;
}

function toCelsius(value: number, unit: string): number {
  if (unit === "f") return ((value - 32) * 5) / 9;
  if (unit === "k") return value - 273.15;
  return value;
}

function fromCelsius(value: number, unit: string): number {
  if (unit === "f") return (value * 9) / 5 + 32;
  if (unit === "k") return value + 273.15;
  return value;
}

/** Trims binary floating-point noise (e.g. 25.400000000000002 -> 25.4). */
function tidy(value: number): number {
  return Number(value.toPrecision(12));
}

export const unitConvertSkill: Skill<UnitConvertInput, UnitConvertResult> = {
  id: "util.unit-convert",
  name: "Unit Convert",
  description:
    "Converts between length (mm, cm, m, km, in, ft, yd, mi), weight (g, kg, lb, oz) and temperature (c, f, k) units.",
  inputSchema: {
    type: "object",
    properties: {
      value: { type: "number" },
      from: { type: "string" },
      to: { type: "string" },
    },
    required: ["value", "from", "to"],
  },
  run(input) {
    const value = input?.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new SkillInputError(
        "util.unit-convert",
        `"value" must be a finite number`,
      );
    }
    const from =
      typeof input?.from === "string" ? input.from.toLowerCase() : "";
    const to = typeof input?.to === "string" ? input.to.toLowerCase() : "";
    const fromFamily = familyOf(from);
    const toFamily = familyOf(to);
    if (!fromFamily) {
      throw new SkillInputError(
        "util.unit-convert",
        `unknown "from" unit "${input?.from}"`,
      );
    }
    if (!toFamily) {
      throw new SkillInputError(
        "util.unit-convert",
        `unknown "to" unit "${input?.to}"`,
      );
    }
    if (fromFamily !== toFamily) {
      throw new SkillInputError(
        "util.unit-convert",
        `cannot convert ${fromFamily} (${from}) to ${toFamily} (${to})`,
      );
    }
    const converted =
      fromFamily === "temperature"
        ? fromCelsius(toCelsius(value, from), to)
        : (value * LINEAR_UNITS[from].toBase) / LINEAR_UNITS[to].toBase;
    return { value: tidy(converted), unit: to };
  },
};
