/**
 * Schedule model for the Automations engine.
 *
 * A schedule pairs a trigger (when) with an opaque job payload (what).
 * The payload is handed to the injected runner untouched: in production
 * it is an Agent Composer `JobDefinition`, but this package never
 * imports the Composer — the runner is the only seam between the two.
 */

/** Every `everyMinutes` minutes, counted from the schedule's anchor. */
export interface IntervalTrigger {
  type: "interval";
  everyMinutes: number;
}

/**
 * Once a day at `at`, format "HH:MM" (24-hour). The time is the LOCAL
 * wall-clock time of the host process running the engine — the same
 * convention cron users expect from a desktop app. Hosts that move
 * timezones move their daily schedules with them.
 */
export interface DailyTrigger {
  type: "daily";
  at: string;
}

/** Exactly once, at the ISO 8601 timestamp `at`. */
export interface OnceTrigger {
  type: "once";
  at: string;
}

export type Trigger = IntervalTrigger | DailyTrigger | OnceTrigger;

export type ScheduleRunStatus = "ok" | "error" | "skipped";

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  /** Opaque payload for the runner. Must be JSON-serializable for FileScheduleStore. */
  job: unknown;
  /**
   * What to do at engine start when this schedule's slot passed while
   * the app was off: true fires the missed run once; false skips the
   * slot (the schedule is advanced, never burst-fired). Consulted only
   * by the start / first-tick catch-up pass, never by later ticks.
   */
  catchUp: boolean;
  /** ISO timestamp, stamped by the engine's clock at creation. */
  createdAt: string;
  /**
   * ISO timestamp of the last time the engine processed a due slot for
   * this schedule — ran it, failed it, or skipped it at catch-up. Also
   * the anchor the next interval/daily slot is computed from.
   */
  lastRunAt?: string;
  /**
   * The runner's returned string after a successful run, the thrown
   * error's message after a failed one, or "skipped" after a catch-up
   * skip.
   */
  lastResult?: string;
  lastStatus?: ScheduleRunStatus;
}

/** Caller input for `AutomationEngine.addSchedule`. */
export interface AddScheduleInput {
  /** Caller-chosen id, `[A-Za-z0-9_-]+`. Defaults to a random UUID. */
  id?: string;
  name: string;
  trigger: Trigger;
  job: unknown;
  /** Defaults to true. */
  enabled?: boolean;
  /** Defaults to false: a missed slot is skipped at start, not fired late. */
  catchUp?: boolean;
}

/**
 * The runner the host injects. In production the shell/cloud builds
 * one over the Agent Composer: `run(job, schedule)` executes
 * `job` (a Composer `JobDefinition`) and returns a short result
 * string, or throws — the engine records either outcome and moves on.
 */
export interface ScheduleRunner {
  run(job: unknown, schedule: Schedule): Promise<string>;
}

/** A bare function with the same shape is accepted wherever a runner is. */
export type RunnerLike =
  | ScheduleRunner
  | ((job: unknown, schedule: Schedule) => Promise<string>);

/** One schedule processed by a start/tick pass. */
export interface RunRecord {
  scheduleId: string;
  status: ScheduleRunStatus;
  /** The runner's returned string, when status is "ok". */
  result?: string;
  /** The thrown error's message, when status is "error". */
  error?: string;
}

/** What one `start()` / `tick()` pass did, in processing order. */
export interface TickReport {
  /** ISO timestamp of the pass, from the engine's clock. */
  at: string;
  runs: RunRecord[];
}

/** Thrown when a schedule or trigger fails validation. */
export class ScheduleValidationError extends Error {
  constructor(detail: string) {
    super(`Invalid schedule: ${detail}`);
    this.name = "ScheduleValidationError";
  }
}

/** Thrown when an operation names a schedule the store does not hold. */
export class ScheduleNotFoundError extends Error {
  readonly scheduleId: string;
  constructor(scheduleId: string) {
    super(`Schedule "${scheduleId}" not found`);
    this.name = "ScheduleNotFoundError";
    this.scheduleId = scheduleId;
  }
}
