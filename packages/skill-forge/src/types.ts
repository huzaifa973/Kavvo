/**
 * The Skill Forge turns a SkillSpec — a JSON-friendly description plus a
 * TypeScript source body — into a working, validated, registered skill.
 * Later an AI model will WRITE specs; everything around that act
 * (validation, scaffolding, compilation, smoke tests, registration,
 * provenance, rollback, removal, boot-time reload) lives in this package
 * and works today with hand-written specs.
 *
 * Trust model (v1): forged skills are FIRST-PARTY — written by our own
 * AI under review, never arbitrary user code. A compiled spec runs
 * in-process with the host's full privileges, exactly like a
 * hand-written built-in skill. There is deliberately no sandbox in v1;
 * the safety is procedural (spec validation, compile check, mandatory
 * smoke tests, provenance records, instant unforge). A sandbox is a
 * precondition for ever forging unreviewed third-party specs.
 */

/** The only property types a spec may declare for its input fields. */
export type SkillPropertyType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array";

/** The input contract of a spec: which fields exist, and which are required. */
export interface SkillSpecInput {
  required: string[];
  properties: Record<string, SkillPropertyType>;
}

/**
 * A forgeable skill description. JSON-friendly end to end (it is stored
 * verbatim in the provenance record), with the run logic carried as a
 * TypeScript source body written against the contract in the README:
 * the source exports nothing, sits inside an async function with
 * `input` and `ctx` in scope, and must `return` the result.
 */
export interface SkillSpec {
  id: string;
  name: string;
  description: string;
  input: SkillSpecInput;
  source: string;
}

/** One smoke case: run the compiled skill on `input`; when `expect` is present, deep-compare. */
export interface SkillSampleCase {
  input: Record<string, unknown>;
  expect?: unknown;
}

/**
 * Provenance for one forged skill: the full spec (so the skill can be
 * rebuilt at boot), the hash of that spec, and when it was forged.
 */
export interface ForgedSkillRecord {
  id: string;
  spec: SkillSpec;
  specHash: string;
  forgedAt: string;
}

/** The pipeline stage a ForgeError came from. */
export type ForgeStage = "validate" | "compile" | "smoke" | "register";

export class ForgeError extends Error {
  readonly stage: ForgeStage;
  readonly skillId?: string;
  constructor(stage: ForgeStage, detail: string, skillId?: string) {
    super(detail);
    this.name = "ForgeError";
    this.stage = stage;
    this.skillId = skillId;
  }
}
