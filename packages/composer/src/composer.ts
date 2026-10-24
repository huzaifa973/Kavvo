import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@skillforge/router";
import type { JobStore } from "./store.js";
import { resolveTemplates } from "./template.js";
import {
  JobDefinitionError,
  JobNotFoundError,
  type ChatClient,
  type JobDefinition,
  type JobState,
  type JobStepDef,
  type MemoryContextSource,
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
  /**
   * Optional memory source for chat steps. When set, each chat step
   * first asks it for a budgeted context relevant to the job (the
   * query is derived from the job title and the step's resolved
   * messages) and the result is prepended to the step's messages as
   * one system message, delimited by MEMORY_CONTEXT_OPEN / _CLOSE.
   * When the source is absent, returns nothing relevant, or fails,
   * chat steps run with exactly the messages they were defined with.
   */
  memory?: MemoryContextSource;
  /**
   * Estimated-token budget handed to the memory source for each chat
   * step's context. Defaults to DEFAULT_MEMORY_TOKEN_BUDGET (800,
   * matching the Memory Core's own default budget).
   */
  memoryTokenBudget?: number;
  /** Clock, injectable for tests. Defaults to the real clock. */
  now?: () => Date;
  /** Job id generator when a definition carries no id. Defaults to randomUUID. */
  createId?: () => string;
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Default estimated-token budget for injected memory context. */
export const DEFAULT_MEMORY_TOKEN_BUDGET = 800;

/**
 * Delimiters of the memory section prepended to a chat step's
 * messages. They bracket the Memory Core's own `## kind` grouped
 * rendering so the model — and any surface displaying the exchange —
 * can tell retrieved long-term memory from the job's own messages.
 */
export const MEMORY_CONTEXT_OPEN =
  "[Relevant memory — retrieved from long-term memory for this task]";
export const MEMORY_CONTEXT_CLOSE = "[End of relevant memory]";

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
 * When a memory source is configured (ComposerOptions.memory), chat
 * steps additionally receive a budgeted long-term-memory context,
 * retrieved per step and prepended as a delimited system message;
 * see withMemoryContext.
 *
 * One Composer executes one job at a time per job id; coordinating
 * concurrent executors over the same store is a later concern.
 */
export class Composer {
  private readonly skills: SkillRunner;
  private readonly chat?: ChatClient;
  private readonly store: JobStore;
  private readonly memory?: MemoryContextSource;
  private readonly memoryTokenBudget: number;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: ComposerOptions) {
    this.skills = options.skills;
    this.chat = options.chat;
    this.store = options.store;
    this.memory = options.memory;
    this.memoryTokenBudget =
      options.memoryTokenBudget ?? DEFAULT_MEMORY_TOKEN_BUDGET;
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
    const withMemory = await this.withMemoryContext(state, messages);
    return this.chat.chat(withMemory, stepDef.options);
  }

  /**
   * Prepends the budgeted memory context for one chat step, when a
   * memory source is configured and it returns anything. The query
   * is derived from the job's title and the step's resolved message
   * contents — the same text the model is about to read, template
   * references already substituted, so a step that talks about an
   * earlier step's output retrieves memory about that output.
   *
   * The injection is runtime-only: the persisted job definition
   * keeps the author's messages untouched, and a resumed step
   * re-derives its context from memory as it then stands.
   *
   * Memory is enrichment, never a dependency: no source configured,
   * an empty result (nothing relevant, or nothing fits the budget),
   * or a failing lookup all return the messages exactly as resolved.
   * A broken memory store must never fail a job's chat step.
   */
  private async withMemoryContext(
    state: JobState,
    messages: ChatMessage[],
  ): Promise<ChatMessage[]> {
    if (!this.memory) return messages;

    const parts: string[] = [];
    if (state.title) parts.push(state.title);
    for (const message of messages) {
      parts.push(
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content),
      );
    }
    const query = parts.join("\n").trim();
    if (!query) return messages;

    let context: { text: string };
    try {
      context = await this.memory.buildContext(query, {
        tokenBudget: this.memoryTokenBudget,
      });
    } catch {
      return messages;
    }
    if (!context.text.trim()) return messages;

    const memoryMessage: ChatMessage = {
      role: "system",
      content: `${MEMORY_CONTEXT_OPEN}\n${context.text}\n${MEMORY_CONTEXT_CLOSE}`,
    };
    return [memoryMessage, ...messages];
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
