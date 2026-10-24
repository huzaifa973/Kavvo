import { isDeepStrictEqual } from "node:util";
import type { Skill, SkillRegistry } from "@kavvo/skill-engine";
import { buildSkill, compileSpec } from "./compile.js";
import type { ForgeStore } from "./store.js";
import { assertValidRecord, assertValidSpec, specHash } from "./validate.js";
import {
  ForgeError,
  type ForgedSkillRecord,
  type SkillSampleCase,
  type SkillSpec,
} from "./types.js";

export interface ForgeOptions {
  /** Provenance store the forged skill's record is written to. */
  store: ForgeStore;
  /**
   * Smoke cases run against the compiled skill before anything is
   * registered. When a case carries `expect`, the result must
   * deep-equal it. Any failing case fails the whole forge.
   */
  samples?: SkillSampleCase[];
  /** Clock, injectable for tests. Defaults to the real clock. */
  now?: () => Date;
}

export interface ForgeResult {
  skill: Skill;
  record: ForgedSkillRecord;
}

/**
 * The forge pipeline. Stages, in order, each failing with a ForgeError
 * tagged with its stage:
 *
 * 1. validate — the spec is structurally sound and its id is unique
 *    against the target registry.
 * 2. compile — the scaffolded source transpiles cleanly.
 * 3. smoke — every sample case runs; `expect` cases deep-compare.
 * 4. register — ONLY on full success: the skill enters the registry
 *    and its provenance record enters the store.
 *
 * Rollback: nothing mutates before stage 4, and if the record save
 * fails after registration, the registration is undone — any failure
 * leaves the registry and the store exactly as they were.
 */
export async function forgeSkill(
  spec: SkillSpec,
  registry: SkillRegistry,
  opts: ForgeOptions,
): Promise<ForgeResult> {
  assertValidSpec(spec);
  if (registry.has(spec.id)) {
    throw new ForgeError(
      "validate",
      `Skill "${spec.id}" is already registered`,
      spec.id,
    );
  }

  const runFn = await compileSpec(spec);
  const skill = buildSkill(spec, runFn);

  const samples = opts.samples ?? [];
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const label = `Sample case ${i + 1} for "${spec.id}"`;
    if (
      sample === null ||
      typeof sample !== "object" ||
      sample.input === null ||
      typeof sample.input !== "object"
    ) {
      throw new ForgeError("smoke", `${label} has no input object`, spec.id);
    }
    let actual: unknown;
    try {
      actual = await skill.run(sample.input, {});
    } catch (err) {
      throw new ForgeError(
        "smoke",
        `${label} threw: ${(err as Error).message}`,
        spec.id,
      );
    }
    if ("expect" in sample && !isDeepStrictEqual(actual, sample.expect)) {
      throw new ForgeError(
        "smoke",
        `${label} returned ${JSON.stringify(actual)} but expected ` +
          JSON.stringify(sample.expect),
        spec.id,
      );
    }
  }

  const record: ForgedSkillRecord = {
    id: spec.id,
    spec: structuredClone(spec),
    specHash: specHash(spec),
    forgedAt: (opts.now ? opts.now() : new Date()).toISOString(),
  };
  registry.register(skill);
  try {
    await opts.store.save(record);
  } catch (err) {
    registry.unregister(spec.id);
    throw new ForgeError(
      "register",
      `Forged skill "${spec.id}" was registered but its record failed to ` +
        `save (${(err as Error).message}); the registration was rolled back`,
      spec.id,
    );
  }
  return { skill, record };
}

/**
 * Remove a forged skill: unregister it and drop its provenance record.
 * Returns false when the forge has no record for the id — the forge
 * only unmakes what it made, so built-in skills are never removed
 * through here.
 */
export async function unforge(
  registry: SkillRegistry,
  store: ForgeStore,
  skillId: string,
): Promise<boolean> {
  const record = await store.get(skillId);
  if (!record) return false;
  registry.unregister(skillId);
  await store.remove(skillId);
  return true;
}

/** One stored record `loadForged` could not re-register, with why. */
export interface LoadForgedSkip {
  id: string;
  reason: string;
}

export interface LoadForgedReport {
  loaded: string[];
  skipped: LoadForgedSkip[];
}

/**
 * Boot-time reload: re-register every stored forged skill into the
 * registry, re-running the same validation and compilation as the
 * original forge (smoke cases are not stored, so they are not
 * re-run). A record that no longer validates, no longer compiles, or
 * whose id is already taken is skipped with its reason recorded in
 * the report — a bad record never crashes the boot.
 */
export async function loadForged(
  registry: SkillRegistry,
  store: ForgeStore,
): Promise<LoadForgedReport> {
  const report: LoadForgedReport = { loaded: [], skipped: [] };
  const records = await store.list();
  for (const record of records) {
    const id =
      record !== null &&
      typeof record === "object" &&
      typeof (record as { id?: unknown }).id === "string"
        ? (record as { id: string }).id
        : "<unknown>";
    try {
      assertValidRecord(record);
      if (registry.has(record.id)) {
        report.skipped.push({
          id,
          reason: `Skill "${record.id}" is already registered`,
        });
        continue;
      }
      const runFn = await compileSpec(record.spec);
      registry.register(buildSkill(record.spec, runFn));
      report.loaded.push(record.id);
    } catch (err) {
      report.skipped.push({ id, reason: (err as Error).message });
    }
  }
  return report;
}
