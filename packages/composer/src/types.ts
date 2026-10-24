import type { ChatMessage, ChatOptions } from "@skillforge/router";
import type { SkillContext } from "@skillforge/skill-engine";

/**
 * Job model for the Agent Composer.
 *
 * A Job is an ordered list of steps. Each step is either a skill step (run
 * natively through the Skill Engine) or a chat step (run through the Brain
 * Router). A step may carry an `id`; when omitted the Composer assigns
 * `step-1`, `step-2`, ... in order. Step ids must match
 * `[A-Za-z0-9_-]+` because later steps reference earlier outputs by id
 * (see template.ts).
 */

export interface SkillStepDef {
  id?: string;
  kind: "skill";
  skillId: string;
  input: Record<string, unknown>;
}

export interface ChatStepDef {
  id?: string;
  kind: "chat";
  messages: ChatMessage[];
  options?: ChatOptions;
}

export type JobStepDef = SkillStepDef | ChatStepDef;

/** A step definition after the Composer has assigned its id. */
export type ResolvedStepDef = JobStepDef & { id: string };

export interface JobDefinition {
  /** Caller-chosen job id. Defaults to a random UUID. Same charset rule as step ids. */
  id?: string;
  title?: string;
  steps: JobStepDef[];
}

export type JobStatus =
  | "pending"
  | "running"
  | "paused"
  | "failed"
  | "completed";

export type StepStatus = "pending" | "running" | "completed" | "failed";

/** Runtime state of one step. Persisted after every transition. */
export interface StepState {
  id: string;
  kind: JobStepDef["kind"];
  status: StepStatus;
  /** The step's return value, kept forever once completed. JSON-safe for FileJobStore. */
  output?: unknown;
  /** Error message when status is "failed". */
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** The full persisted record of a job: definition plus runtime state. */
export interface JobState {
  id: string;
  title?: string;
  status: JobStatus;
  /** Normalized definition (ids assigned), so resume needs nothing else. */
  definition: { title?: string; steps: ResolvedStepDef[] };
  steps: StepState[];
  /** Message of the most recent step failure, cleared when the job runs again. */
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** Minimal skill executor the Composer needs. `SkillRegistry` satisfies this. */
export interface SkillRunner {
  runSkill(
    id: string,
    input: Record<string, unknown>,
    ctx?: SkillContext,
  ): Promise<unknown>;
}

/**
 * Minimal chat surface the Composer needs. The Brain `Router` satisfies
 * this structurally; tests can pass a Router over a MockProvider, or any
 * stub with the same shape.
 */
export interface ChatClient {
  chat(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): Promise<{ content: string }>;
}

/**
 * Minimal memory surface the Composer needs for chat-step context.
 * `MemoryCore` from @skillforge/memory-core satisfies this
 * structurally: `buildContext(query, { tokenBudget })` returns the
 * budgeted, relevance-ranked context string for a query, with ""
 * text when nothing relevant fits the budget. The Composer depends
 * only on this shape, never on the memory package itself.
 */
export interface MemoryContextSource {
  buildContext(
    query: string,
    options?: { tokenBudget?: number },
  ): Promise<{ text: string }>;
}

/** Thrown when a job definition is invalid (bad ids, no steps, ...). */
export class JobDefinitionError extends Error {
  constructor(detail: string) {
    super(`Invalid job definition: ${detail}`);
    this.name = "JobDefinitionError";
  }
}

/** Thrown when resume/pause/get names a job the store does not hold. */
export class JobNotFoundError extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super(`Job "${jobId}" not found`);
    this.name = "JobNotFoundError";
    this.jobId = jobId;
  }
}

/** Thrown when a {{stepId.field}} reference cannot be resolved. */
export class StepReferenceError extends Error {
  constructor(detail: string) {
    super(`Unresolvable step reference: ${detail}`);
    this.name = "StepReferenceError";
  }
}
