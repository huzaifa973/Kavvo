import { join } from "node:path";

// Relative-path imports, like server.ts: the web build (tsc with
// rootDir at the repo root) emits a self-contained dist/ tree that
// plain Node resolves directly — no bundler, no aliases at run time.
import {
  Composer,
  FileJobStore,
  type JobDefinition,
} from "../../../packages/composer/src/index.js";
import {
  createDefaultRegistry,
  type SkillRegistry,
} from "../../../packages/skill-engine/src/index.js";
import {
  FileForgeStore,
  loadForged,
  type ForgeStore,
  type LoadForgedReport,
} from "../../../packages/skill-forge/src/index.js";
import {
  FileMemoryStore,
  MemoryCore,
  type MemoryStore,
} from "../../../packages/memory-core/src/index.js";
import {
  AutomationEngine,
  FileScheduleStore,
  type Schedule,
} from "../../../packages/automations/src/index.js";

/**
 * The assembled Skillforge core: one shared instance set the whole
 * shell runs on, so the HTTP surface, the automation runner and any
 * future surface (Electron, mobile) all see the same skills, jobs,
 * memories, forged skills and schedules.
 *
 * Everything persists under one data dir:
 *   <dataDir>/jobs/         Composer checkpoints (FileJobStore)
 *   <dataDir>/memory/       Memory Core items (FileMemoryStore)
 *   <dataDir>/forge/        forged-skill provenance (FileForgeStore)
 *   <dataDir>/automations/  schedules (FileScheduleStore)
 *
 * Boot order matters: the registry is created first, stored forged
 * skills are re-registered into it (loadForged — a bad record is
 * skipped with a reason, never a crashed boot), and only then are the
 * Composer and the AutomationEngine built over the shared registry,
 * so a job or a schedule can call a forged skill from the first tick.
 */
export interface CoreOptions {
  /** Root data dir. The caller resolves SKILLFORGE_DATA_DIR / defaults. */
  dataDir: string;
  /** Registry to assemble over. Defaults to `createDefaultRegistry()`. */
  registry?: SkillRegistry;
}

export interface SkillforgeCore {
  dataDir: string;
  registry: SkillRegistry;
  composer: Composer;
  memory: MemoryCore;
  memoryStore: MemoryStore;
  forgeStore: ForgeStore;
  /** What boot-time reload of forged skills did (loaded + skipped). */
  forgeLoadReport: LoadForgedReport;
  automations: AutomationEngine;
  /**
   * One automation pass with an overlap guard: a slow pass (a long
   * job) never stacks a second pass on top of itself — the call is
   * skipped and reported as such. Returns whether a pass ran.
   */
  tickAutomations(): Promise<boolean>;
}

/** Assemble the core over `options.dataDir`. Async: boot reloads forged skills. */
export async function createCore(
  options: CoreOptions,
): Promise<SkillforgeCore> {
  const { dataDir } = options;
  const registry = options.registry ?? createDefaultRegistry();

  const forgeStore = new FileForgeStore(join(dataDir, "forge"));
  const forgeLoadReport = await loadForged(registry, forgeStore);

  const memoryStore = new FileMemoryStore(join(dataDir, "memory"));
  const memory = new MemoryCore(memoryStore);

  const composer = new Composer({
    skills: registry,
    store: new FileJobStore(join(dataDir, "jobs")),
  });

  // The automation runner is the seam the Automations package was
  // built around: schedule.job IS a Composer JobDefinition, executed
  // through the shared Composer. The result string is short and
  // carries the final job status (plus the recorded error, if any).
  // A definition error throws out of composer.run and the engine
  // records it as the schedule's error — a broken schedule never
  // breaks the engine or the shell.
  const automations = new AutomationEngine({
    store: new FileScheduleStore(join(dataDir, "automations")),
    runner: async (job: unknown, _schedule: Schedule): Promise<string> => {
      const state = await composer.run(job as JobDefinition);
      return state.error
        ? `job ${state.id} ${state.status}: ${state.error}`
        : `job ${state.id} ${state.status}`;
    },
  });

  let tickInFlight = false;
  const tickAutomations = async (): Promise<boolean> => {
    if (tickInFlight) return false;
    tickInFlight = true;
    try {
      await automations.tick();
      return true;
    } finally {
      tickInFlight = false;
    }
  };

  return {
    dataDir,
    registry,
    composer,
    memory,
    memoryStore,
    forgeStore,
    forgeLoadReport,
    automations,
    tickAutomations,
  };
}
