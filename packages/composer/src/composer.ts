import { randomUUID } from "node:crypto";
import type { JobStore } from "./store.js";
import { resolveTemplates } from "./template.js";
import {
  JobDefinitionError,
  JobNotFoundError,
  type ChatClient,
  type JobDefinition,
  type JobState,
  type JobStepDef,
  type ResolvedStepDef,
  type SkillRunner,
} from "./types.js";

export interface ComposerOptions {
  /** Skill executor. A `SkillRegistry` from @skillforge/skill-engine fits directly. */
  skills: SkillRunner;
  /** Chat surface for `kind: "chat"` steps. The Brain Router fits directly. */
  chat?: ChatClient;
  /** Checkpoint store. State is saved after every step transition. */
  store: JobStore;
  /** Clock, injectable for tests. Defaults to the real clock. */
  now?: () => Date;
  /** Job id generator when a definition carries no id. Defaults to randomUUID. */
  createId?: () => string;
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * The Agent Composer: chains skills (and chat calls) into jobs and runs
 * them with checkpoint + resume. Every step transition is persisted
 * through the JobStore, so a job interrupted by a crash, a pause or a
 * failing step keeps its completed outputs and can be resumed exactly
 * where it stopped. Completed steps are never re-run.
 *
 * Step failures do not throw out of run()/resume(): the returned
 * JobState carries status "failed" plus the recorded error. Definition
 * errors and unknown job ids do throw (JobDefinitionError /
 * JobNotFoundError) because no meaningful job state exists for them.
 *
 * One Composer executes one job at a time per job id; coordinating
 * concurrent executors over the same store is a later concern.
 */
export class Composer {
  private readonly skills: SkillRunner;
  private readonly chat?: ChatClient;
  private readonly store: JobStore;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: ComposerOptions) {
    this.skills = options.skills;
    this.chat = options.chat;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => randomUUID());
  }

  /** Validate a definition, assign step ids and persist it as "pending". */
  async createJob(definition: JobDefinition): Promise<JobState> {
    const steps = normalizeSteps(definition.steps);
    const id = definition.id ?? this.createId();
    if (!ID_PATTERN.test(id)) {
      throw new JobDefinitionError(
        `job id "${id}" must match ${ID_PATTERN} (letters, digits, "-" and "_")`,
      );
    }
    const timestamp = this.now().toISOString();
    const state: JobState = {
      id,
      title: definition.title,
      status: "pending",
      definition: { title: definition.title, steps },
      steps: steps.map((step) => ({
        id: step.id,
        kind: step.kind,
        status: "pending" as const,
      })),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.save(state);
    return state;
  }

  /** Create a job from a definition and run it to completion or failure. */
  async run(definition: JobDefinition): Promise<JobState> {
    const job = await this.createJob(definition);
    return this.execute(job.id, { unpause: false });
  }

  /**
   * Continue a stored job from its first incomplete step. Completed
   * steps are skipped; a previously failed step is retried. Works on
   * pending, failed and paused jobs alike (a paused job is unpaused).
   */
  async resume(jobId: string): Promise<JobState> {
    return this.execute(jobId, { unpause: true });
  }

  /**
   * Ask a job to stop after its current step. The running executor
   * notices between steps (or right after the in-flight step) and
   * returns with status "paused"; resume() continues it later.
   */
  async pause(jobId: string): Promise<JobState> {
    const state = await this.mustGet(jobId);
    if (state.status === "pending" || state.status === "running") {
      state.status = "paused";
      state.updatedAt = this.now().toISOString();
      await this.store.save(state);
    }
    return state;
  }

  async getJob(jobId: string): Promise<JobState | undefined> {
    return this.store.get(jobId);
  }

  async listJobs(): Promise<JobState[]> {
    return this.store.list();
  }

  private async mustGet(jobId: string): Promise<JobState> {
    const state = await this.store.get(jobId);
    if (!state) throw new JobNotFoundError(jobId);
    return state;
  }

  private async execute(
    jobId: string,
    { unpause }: { unpause: boolean },
  ): Promise<JobState> {
    let state = await this.mustGet(jobId);
    if (unpause && state.status === "paused") {
      state.status = "running";
      state.updatedAt = this.now().toISOString();
      await this.store.save(state);
    }

    for (;;) {
      // Reload every iteration: pause() writes through the same store,
      // and a fresh copy is the checkpoint we build on.
      state = await this.mustGet(jobId);
      if (state.status === "paused") return state;

      const stepState = state.steps.find(
        (s) => s.status === "pending" || s.status === "failed",
      );
      if (!stepState) {
        if (state.status !== "completed") {
          state.status = "completed";
          state.error = undefined;
          state.updatedAt = this.now().toISOString();
          await this.store.save(state);
        }
        return state;
      }

      const stepDef = state.definition.steps.find((s) => s.id === stepState.id);
      if (!stepDef) {
        throw new JobDefinitionError(
          `stored job "${jobId}" has state for unknown step "${stepState.id}"`,
        );
      }

      stepState.status = "running";
      stepState.error = undefined;
      stepState.startedAt = this.now().toISOString();
      state.status = "running";
      state.error = undefined;
      state.updatedAt = this.now().toISOString();
      await this.store.save(state);

      try {
        stepState.output = await this.runStep(state, stepDef);
      } catch (err) {
        stepState.status = "failed";
        stepState.error = err instanceof Error ? err.message : String(err);
        stepState.finishedAt = this.now().toISOString();
        state.status = "failed";
        state.error = stepState.error;
        state.updatedAt = this.now().toISOString();
        await this.store.save(state);
        return state;
      }

      stepState.status = "completed";
      stepState.finishedAt = this.now().toISOString();
      state.updatedAt = this.now().toISOString();

      // A pause requested while this step ran takes effect now, with
      // the step's completion safely recorded first.
      const fresh = await this.store.get(jobId);
      if (fresh?.status === "paused") {
        state.status = "paused";
        await this.store.save(state);
        return state;
      }
      await this.store.save(state);
    }
  }

  private async runStep(
    state: JobState,
    stepDef: ResolvedStepDef,
  ): Promise<unknown> {
    const outputs = new Map<string, unknown>();
    for (const step of state.steps) {
      if (step.status === "completed") outputs.set(step.id, step.output);
    }

    if (stepDef.kind === "skill") {
      const input = resolveTemplates(stepDef.input, outputs);
      return this.skills.runSkill(stepDef.skillId, input, {
        jobId: state.id,
        stepId: stepDef.id,
      });
    }

    // kind === "chat"
    if (!this.chat) {
      throw new Error(
        `step "${stepDef.id}" is a chat step but this Composer has no chat client configured`,
      );
    }
    const messages = resolveTemplates(stepDef.messages, outputs);
    return this.chat.chat(messages, stepDef.options);
  }
}

function normalizeSteps(steps: JobStepDef[]): ResolvedStepDef[] {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new JobDefinitionError("a job needs at least one step");
  }
  const seen = new Set<string>();
  return steps.map((step, index) => {
    const id = step.id ?? `step-${index + 1}`;
    if (!ID_PATTERN.test(id)) {
      throw new JobDefinitionError(
        `step id "${id}" must match ${ID_PATTERN} (letters, digits, "-" and "_") so later steps can reference it`,
      );
    }
    if (seen.has(id)) {
      throw new JobDefinitionError(`duplicate step id "${id}"`);
    }
    seen.add(id);
    if (step.kind === "skill" && !step.skillId) {
      throw new JobDefinitionError(`skill step "${id}" needs a skillId`);
    }
    if (
      step.kind === "chat" &&
      (!Array.isArray(step.messages) || step.messages.length === 0)
    ) {
      throw new JobDefinitionError(
        `chat step "${id}" needs at least one message`,
      );
    }
    return { ...step, id };
  });
}
