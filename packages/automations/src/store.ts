import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertValidSchedule } from "./schedule.js";
import type { Schedule } from "./types.js";

/**
 * Persistence for schedules. The engine saves after EVERY processed
 * slot, so whatever the store holds is exactly what ran — a restart
 * resumes from disk, never from a guess.
 *
 * Implementations must return copies, never live references, so callers
 * cannot mutate stored state behind the store's back.
 */
export interface AutomationStore {
  save(schedule: Schedule): Promise<void>;
  get(scheduleId: string): Promise<Schedule | undefined>;
  remove(scheduleId: string): Promise<boolean>;
  list(): Promise<Schedule[]>;
}

/** In-process store. State survives engine instances, not restarts. */
export class InMemoryScheduleStore implements AutomationStore {
  private readonly schedules = new Map<string, Schedule>();

  async save(schedule: Schedule): Promise<void> {
    assertValidSchedule(schedule);
    this.schedules.set(schedule.id, structuredClone(schedule));
  }

  async get(scheduleId: string): Promise<Schedule | undefined> {
    const schedule = this.schedules.get(scheduleId);
    return schedule ? structuredClone(schedule) : undefined;
  }

  async remove(scheduleId: string): Promise<boolean> {
    return this.schedules.delete(scheduleId);
  }

  async list(): Promise<Schedule[]> {
    return [...this.schedules.values()].map((s) => structuredClone(s));
  }
}

/**
 * One JSON file per schedule under a caller-provided directory
 * (`<dir>/<scheduleId>.json`). Writes go to a temp file renamed into
 * place, so a crash mid-write never leaves a torn record. Job payloads
 * must be JSON-serializable. State survives full process restarts.
 */
export class FileScheduleStore implements AutomationStore {
  constructor(private readonly dir: string) {}

  private fileFor(scheduleId: string): string {
    return join(this.dir, `${scheduleId}.json`);
  }

  async save(schedule: Schedule): Promise<void> {
    assertValidSchedule(schedule);
    await mkdir(this.dir, { recursive: true });
    const tmp = join(
      this.dir,
      `.${schedule.id}.json.tmp-${Math.random().toString(36).slice(2)}`,
    );
    await writeFile(tmp, JSON.stringify(schedule, null, 2), "utf8");
    await rename(tmp, this.fileFor(schedule.id));
  }

  async get(scheduleId: string): Promise<Schedule | undefined> {
    try {
      const raw = await readFile(this.fileFor(scheduleId), "utf8");
      return JSON.parse(raw) as Schedule;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async remove(scheduleId: string): Promise<boolean> {
    try {
      await unlink(this.fileFor(scheduleId));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async list(): Promise<Schedule[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const schedules: Schedule[] = [];
    for (const file of files) {
      if (!file.endsWith(".json") || file.startsWith(".")) continue;
      const schedule = await this.get(file.slice(0, -".json".length));
      if (schedule) schedules.push(schedule);
    }
    return schedules;
  }
}
