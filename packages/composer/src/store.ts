import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobState } from "./types.js";

/**
 * Persistence for job state. The Composer saves after EVERY step
 * transition, so a store write is the checkpoint that makes "tasks
 * pause, never die" true: whatever happens to the process, the last
 * saved state is resumable.
 *
 * Implementations must return copies, never live references, so callers
 * cannot mutate stored state behind the store's back.
 */
export interface JobStore {
  save(job: JobState): Promise<void>;
  get(jobId: string): Promise<JobState | undefined>;
  list(): Promise<JobState[]>;
}

/** In-process store. State survives Composer instances, not restarts. */
export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobState>();

  async save(job: JobState): Promise<void> {
    this.jobs.set(job.id, structuredClone(job));
  }

  async get(jobId: string): Promise<JobState | undefined> {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : undefined;
  }

  async list(): Promise<JobState[]> {
    return [...this.jobs.values()].map((job) => structuredClone(job));
  }
}

/**
 * One JSON file per job under a caller-provided directory
 * (`<dir>/<jobId>.json`). Writes go to a temp file renamed into place,
 * so a crash mid-write never leaves a torn checkpoint. Job outputs must
 * be JSON-serializable. State survives full process restarts.
 */
export class FileJobStore implements JobStore {
  constructor(private readonly dir: string) {}

  private fileFor(jobId: string): string {
    return join(this.dir, `${jobId}.json`);
  }

  async save(job: JobState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(
      this.dir,
      `.${job.id}.json.tmp-${Math.random().toString(36).slice(2)}`,
    );
    await writeFile(tmp, JSON.stringify(job, null, 2), "utf8");
    await rename(tmp, this.fileFor(job.id));
  }

  async get(jobId: string): Promise<JobState | undefined> {
    try {
      const raw = await readFile(this.fileFor(jobId), "utf8");
      return JSON.parse(raw) as JobState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async list(): Promise<JobState[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const jobs: JobState[] = [];
    for (const file of files) {
      if (!file.endsWith(".json") || file.startsWith(".")) continue;
      const job = await this.get(file.slice(0, -".json".length));
      if (job) jobs.push(job);
    }
    return jobs;
  }
}
