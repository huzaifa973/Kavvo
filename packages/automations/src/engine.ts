import { randomUUID } from "node:crypto";
import { nextDueAt as computeNextDueAt } from "./schedule.js";
import {
  InMemoryScheduleStore,
  type AutomationStore,
} from "./store.js";
import {
  ScheduleNotFoundError,
  ScheduleValidationError,
  type AddScheduleInput,
  type RunRecord,
  type RunnerLike,
  type Schedule,
  type ScheduleRunner,
  type TickReport,
} from "./types.js";

export interface AutomationEngineOptions {
  /** Defaults to a new InMemoryScheduleStore. */
  store?: AutomationStore;
  runner: RunnerLike;
  /** Injectable clock. Defaults to the real clock. */
  now?: () => Date;
}

function normalizeRunner(runner: RunnerLike): ScheduleRunner {
  return typeof runner === "function" ? { run: runner } : runner;
}

function byCreatedThenId(a: Schedule, b: Schedule): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The Automations engine: schedules + triggers that run jobs through
 * an injected runner.
 *
 * The engine owns WHEN; the runner owns WHAT. It never imports the
 * Agent Composer — the shell/cloud injects a runner that executes
 * `schedule.job` (a Composer job definition) and returns a result
 * string. Tests inject anything.
 *
 * Timing model:
 * - Each schedule's next slot is `nextRun(trigger, anchor)` with
 *   anchor = `lastRunAt ?? createdAt`. An interval therefore counts
 *   from its last processed run, and a schedule that falls behind
 *   fires ONCE per pass, never in a burst.
 * - `tick()` runs every enabled schedule whose slot is due, in
 *   creation order, strictly sequentially. A runner that throws is
 *   recorded on that schedule and never breaks the pass or the
 *   engine.
 * - Catch-up: `start()` runs one pass in catch-up mode; the first
 *   `tick()` on a fresh engine implies `start()`. In catch-up mode a
 *   past-due schedule fires once when its `catchUp` is true, and is
 *   skipped-but-advanced (a "skipped" record is persisted) when
 *   false. Later ticks ignore `catchUp` entirely — it governs only
 *   the moment the app comes back to life.
 */
export class AutomationEngine {
  private readonly store: AutomationStore;
  private readonly runner: ScheduleRunner;
  private readonly now: () => Date;
  private started = false;

  constructor(options: AutomationEngineOptions) {
    if (!options || typeof options !== "object" || !options.runner) {
      throw new ScheduleValidationError("an injected runner is required");
    }
    this.store = options.store ?? new InMemoryScheduleStore();
    this.runner = normalizeRunner(options.runner);
    this.now = options.now ?? (() => new Date());
  }

  /** Validate, stamp and persist a schedule. Returns the stored record. */
  async addSchedule(input: AddScheduleInput): Promise<Schedule> {
    if (!input || typeof input !== "object") {
      throw new ScheduleValidationError("schedule input must be an object");
    }
    if (!("job" in input)) {
      throw new ScheduleValidationError("schedule input must carry a job payload");
    }
    const schedule: Schedule = {
      id: input.id ?? randomUUID(),
      name: input.name,
      enabled: input.enabled ?? true,
      trigger: input.trigger,
      job: input.job,
      catchUp: input.catchUp ?? false,
      createdAt: this.now().toISOString(),
    };
    // save() validates the full record, trigger included.
    await this.store.save(schedule);
    const stored = await this.store.get(schedule.id);
    return stored ?? schedule;
  }

  async getSchedule(scheduleId: string): Promise<Schedule | undefined> {
    return this.store.get(scheduleId);
  }

  async listSchedules(): Promise<Schedule[]> {
    const schedules = await this.store.list();
    return schedules.sort(byCreatedThenId);
  }

  /** Remove a schedule. True when one existed. */
  async removeSchedule(scheduleId: string): Promise<boolean> {
    return this.store.remove(scheduleId);
  }

  /** Enable or disable a schedule. Disabled schedules never fire. */
  async setEnabled(scheduleId: string, enabled: boolean): Promise<Schedule> {
    const schedule = await this.store.get(scheduleId);
    if (!schedule) throw new ScheduleNotFoundError(scheduleId);
    schedule.enabled = enabled;
    await this.store.save(schedule);
    return schedule;
  }

  /** When this schedule is next due, or null when it never fires again. */
  nextDueAt(schedule: Schedule): Date | null {
    return computeNextDueAt(schedule);
  }

  /**
   * The catch-up pass. Runs once per engine instance; calling it again
   * (or after the first tick) is a no-op that reports nothing.
   */
  async start(): Promise<TickReport> {
    if (this.started) {
      return { at: this.now().toISOString(), runs: [] };
    }
    this.started = true;
    return this.processDue(true);
  }

  /**
   * One scheduling pass against the clock. The first tick on a fresh
   * engine performs the start() catch-up pass instead; later ticks run
   * whatever is due. Never throws for a failing job — failures are in
   * the report and on the schedule's record.
   */
  async tick(): Promise<TickReport> {
    if (!this.started) return this.start();
    return this.processDue(false);
  }

  private async processDue(catchUpMode: boolean): Promise<TickReport> {
    const at = this.now();
    const report: TickReport = { at: at.toISOString(), runs: [] };
    const schedules = (await this.store.list()).sort(byCreatedThenId);
    for (const schedule of schedules) {
      if (!schedule.enabled) continue;
      const due = computeNextDueAt(schedule);
      if (due === null || due.getTime() > at.getTime()) continue;
      if (catchUpMode && !schedule.catchUp) {
        schedule.lastRunAt = this.now().toISOString();
        schedule.lastResult = "skipped";
        schedule.lastStatus = "skipped";
        await this.store.save(schedule);
        report.runs.push({ scheduleId: schedule.id, status: "skipped" });
        continue;
      }
      const record: RunRecord = await this.runOne(schedule);
      report.runs.push(record);
    }
    return report;
  }

  private async runOne(schedule: Schedule): Promise<RunRecord> {
    try {
      const result = await this.runner.run(schedule.job, schedule);
      schedule.lastRunAt = this.now().toISOString();
      schedule.lastResult = result;
      schedule.lastStatus = "ok";
      await this.store.save(schedule);
      return { scheduleId: schedule.id, status: "ok", result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      schedule.lastRunAt = this.now().toISOString();
      schedule.lastResult = message;
      schedule.lastStatus = "error";
      await this.store.save(schedule);
      return { scheduleId: schedule.id, status: "error", error: message };
    }
  }
}
