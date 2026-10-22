import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileScheduleStore,
  InMemoryScheduleStore,
  ScheduleValidationError,
  type Schedule,
} from "../src/index.js";

function sample(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "sched-1",
    name: "Daily post",
    enabled: true,
    trigger: { type: "daily", at: "09:00" },
    job: { steps: [] },
    catchUp: false,
    createdAt: "2026-01-15T08:00:00.000Z",
    ...overrides,
  };
}

async function tempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "automations-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("InMemoryScheduleStore", () => {
  it("round-trips a schedule", async () => {
    const store = new InMemoryScheduleStore();
    const schedule = sample();
    await store.save(schedule);
    expect(await store.get("sched-1")).toEqual(schedule);
    expect(await store.list()).toEqual([schedule]);
    expect(await store.get("missing")).toBeUndefined();
  });

  it("isolates stored state from caller mutation both ways", async () => {
    const store = new InMemoryScheduleStore();
    const schedule = sample();
    await store.save(schedule);
    schedule.name = "mutated after save";
    const read = await store.get("sched-1");
    expect(read?.name).toBe("Daily post");
    read!.name = "mutated after read";
    (read!.job as { steps: unknown[] }).steps.push({ kind: "skill" });
    const reread = await store.get("sched-1");
    expect(reread?.name).toBe("Daily post");
    expect(reread?.job).toEqual({ steps: [] });
  });

  it("remove reports whether a schedule existed", async () => {
    const store = new InMemoryScheduleStore();
    await store.save(sample());
    expect(await store.remove("sched-1")).toBe(true);
    expect(await store.remove("sched-1")).toBe(false);
    expect(await store.list()).toEqual([]);
  });
});

describe("FileScheduleStore", () => {
  it("persists across store instances over the same directory", async () => {
    await tempDir(async (dir) => {
      const first = new FileScheduleStore(dir);
      const schedule = sample({ lastRunAt: "2026-01-15T09:00:00.000Z", lastStatus: "ok" });
      await first.save(schedule);

      const second = new FileScheduleStore(dir);
      expect(await second.get("sched-1")).toEqual(schedule);
      expect(await second.list()).toEqual([schedule]);

      expect(await second.remove("sched-1")).toBe(true);
      expect(await first.get("sched-1")).toBeUndefined();
      expect(await second.remove("sched-1")).toBe(false);
    });
  });

  it("reads a missing directory as empty", async () => {
    await tempDir(async (dir) => {
      const store = new FileScheduleStore(join(dir, "never-written"));
      expect(await store.list()).toEqual([]);
      expect(await store.get("sched-1")).toBeUndefined();
      expect(await store.remove("sched-1")).toBe(false);
    });
  });
});

describe("store validation", () => {
  it("rejects invalid schedules on save in both stores", async () => {
    const badTrigger = sample({
      trigger: { type: "interval", everyMinutes: 0 },
    });
    const badId = sample({ id: "a/b" });
    const badName = sample({ name: "  " });
    for (const store of [
      new InMemoryScheduleStore(),
      new FileScheduleStore(join(tmpdir(), "automations-unused")),
    ]) {
      await expect(store.save(badTrigger)).rejects.toThrow(ScheduleValidationError);
      await expect(store.save(badId)).rejects.toThrow(ScheduleValidationError);
      await expect(store.save(badName)).rejects.toThrow(ScheduleValidationError);
    }
  });
});
