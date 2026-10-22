/** Context handed to a skill at run time. Grows as the platform does. */
export interface SkillContext {
  /** The router/LLM handle lands here later; pure skills ignore it. */
  [key: string]: unknown;
}

/**
 * A Skill: one small unit of work the platform can do natively and instantly,
 * without opening a web page. `inputSchema` is a plain JSON-Schema-shaped
 * object describing the expected input (used for validation and, later, for
 * the Agent Composer and Skill Forge).
 */
export interface Skill<I = Record<string, unknown>, O = unknown> {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(input: I, ctx: SkillContext): Promise<O> | O;
}

export class DuplicateSkillError extends Error {
  readonly skillId: string;
  constructor(skillId: string) {
    super(`Skill "${skillId}" is already registered`);
    this.name = "DuplicateSkillError";
    this.skillId = skillId;
  }
}

export class SkillNotFoundError extends Error {
  readonly skillId: string;
  constructor(skillId: string) {
    super(`Skill "${skillId}" is not registered`);
    this.name = "SkillNotFoundError";
    this.skillId = skillId;
  }
}

export class SkillInputError extends Error {
  readonly skillId: string;
  constructor(skillId: string, detail: string) {
    super(`Invalid input for skill "${skillId}": ${detail}`);
    this.name = "SkillInputError";
    this.skillId = skillId;
  }
}
