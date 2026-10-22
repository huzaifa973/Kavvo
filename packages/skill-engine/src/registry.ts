import {
  DuplicateSkillError,
  SkillInputError,
  SkillNotFoundError,
  type Skill,
  type SkillContext,
} from "./types.js";

/**
 * Registry of every skill the platform can run. Skills register once at
 * startup; the Agent Composer and the Skill Forge build on top of this.
 */
export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  register<I, O>(skill: Skill<I, O>): void {
    if (this.skills.has(skill.id)) throw new DuplicateSkillError(skill.id);
    this.skills.set(skill.id, skill as Skill);
  }

  /** Remove a skill by id. Returns true when one was registered. */
  unregister(id: string): boolean {
    return this.skills.delete(id);
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  has(id: string): boolean {
    return this.skills.has(id);
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  /**
   * Executor: validates the skill exists, checks the input carries the
   * fields the skill's inputSchema marks required, then runs it.
   */
  async runSkill(
    id: string,
    input: Record<string, unknown>,
    ctx: SkillContext = {},
  ): Promise<unknown> {
    const skill = this.skills.get(id);
    if (!skill) throw new SkillNotFoundError(id);
    if (input === null || typeof input !== "object") {
      throw new SkillInputError(id, "input must be an object");
    }
    const required = (skill.inputSchema as { required?: unknown }).required;
    if (Array.isArray(required)) {
      for (const field of required) {
        if (typeof field === "string" && !(field in input)) {
          throw new SkillInputError(id, `missing required field "${field}"`);
        }
      }
    }
    return skill.run(input, ctx);
  }
}
