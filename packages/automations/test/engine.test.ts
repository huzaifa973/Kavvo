import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AutomationEngine,
  FileScheduleStore,
  InMemoryScheduleStore,
  ScheduleNotFoundError,
  ScheduleValidationError,
  type AddScheduleInput,
  type Schedule,
} from "../src/index.js";

const MIN = 60_000;
const T0 = new Date("2026-01-15T08:00:00.000Z");

function fakeClock(start: Date) {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    set: (d: Date) => {
      t = d.getTime();
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function recorder(behavior?: (job: unknown, schedule: Schedule) => string) {
  const calls: Array<{ job: unknown; schedule: Schedule }> = [];
  const runner = {
    async run(job: unknown, schedule: Schedule): Promise<string> {
      calls.push({ job, schedule });
      return behavior ? behavior(job, schedule) : "ok";
    },
  };
  return { runner, calls };
}

const intervalJob = { steps: [{ kind: "skill", skillId: "text.slugify" }] };

describe("AutomationEngine — interval firing", () => {
  it("fires when the interval elapses, records the run, and re-anchors", async () => {
    const clock = fakeClock(T0);
    const { runner, calls } = recorder();
    const engine = new AutomationEngine({ runner, now: clock.now });
    const schedule = await engine.addSchedule({
      name: "every 30",
      trigger: { type: "interval", everyMinutes: 30 },
      job: intervalJob,
    });
    expect(schedule.createdAt).toBe(T0.toISOString());
    expect(schedule.enabled).toBe(true);
    expect(schedule.catchUp).toBe(false);

    // First tick is the start pass; nothing is due yet.
    expect((await engine.tick()).runs).toEqual([]);
    clock.advance(29 * MIN);
    expect((await engine.tick()).runs).toEqual([]);
    expect(calls).toHaveLength(0);

    clock.advance(1 * MIN);
    const report = await engine.tick();
    expect(report.runs).toEqual([
      { scheduleId: schedule.id, status: "ok", result: "ok" },
    ]);
    expect(calls).toHaveLength(1);
    // The runner received the opaque payload and the schedule itself.
    expect(calls[0].job).toEqual(intervalJob);
    expect(calls[0].schedule.id).toBe(schedule.id);

    const stored = await engine.getSchedule(schedule.id);
    expect(stored?.lastRunAt).toBe(new Date(T0.getTime() + 30 * MIN).toISOString());
    expect(stored?.lastResult).toBe("ok");
    expect(stored?.lastStatus).toBe("ok");

    // Re-anchored on the run: an immediate second tick fires nothing.
    expect((await engine.tick()).runs).toEqual([]);
    clock.advance(30 * MIN);
    await engine.tick();
    expect(calls).toHaveLength(2);
  });

  it("hands a bare function runner the same payload and schedule", async () => {
    const clock = fakeClock(T0);
    const seen: unknown[] = [];
    const engine = new AutomationEngine({
      now: clock.now,
      runner: async (job) => {
        seen.push(job);
        return "fn-result";
      },
    });
    const schedule = await engine.addSchedule({
      name: "fn",
      trigger: { type: "interval", everyMinutes: 5 },
      job: { n: 1 },
    });
    await engine.tick(); // start pass at creation time; nothing due yet
    clock.advance(5 * MIN);
    const report = await engine.tick();
    expect(report.runs).toEqual([
      { scheduleId: schedule.id, status: "ok", result: "fn-result" },
    ]);
    expect(seen).toEqual([{ n: 1 }]);
  });
});

describe("AutomationEngine — daily firing", () => {
  it("fires when the clock crosses HH:MM (host-local)", async () => {
    const clock = fakeClock(new Date(2026, 0, 15, 8, 59));
    const { runner, calls } = recorder();
    const engine = new AutomationEngine({ runner, now: clock.now });
    await engine.addSchedule({
      name: "morning post",
      trigger: { type: "daily", at: "09:00" },
      job: intervalJob,
    });
    await engine.tick();
    expect(calls).toHaveLength(0);
    clock.set(new Date(2026, 0, 15, 9, 0));
    const report = await engine.tick();
    expect(report.runs).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

describe("AutomationEngine — failure isolation", () => {
  it("records a throwing runner's error and still runs the other schedule", async () => {
    const clock = fakeClock(T0);
    const { runner, calls } = recorder((job) => {
      if ((job as { boom?: boolean }).boom) throw new Error("composer exploded");
      return "fine";
    });
    const engine = new AutomationEngine({ runner, now: clock.now });
    const bad = await engine.addSchedule({
      id: "a-bad",
      name: "bad",
      trigger: { type: "interval", everyMinutes: 10 },
      job: { boom: true },
    });
    const good = await engine.addSchedule({
      id: "b-good",
      name: "good",
      trigger: { type: "interval", everyMinutes: 10 },
      job: { boom: false },
    });
    await engine.tick(); // start pass, nothing due
    clock.advance(10 * MIN);
    const report = await engine.tick();
    expect(report.runs).toEqual([
      { scheduleId: bad.id, status: "error", error: "composer exploded" },
      { scheduleId: good.id, status: "ok", result: "fine" },
    ]);
    expect(calls).toHaveLength(2);

    const badStored = await engine.getSchedule(bad.id);
    expect(badStored?.lastStatus).toBe("error");
    expect(badStored?.lastResult).toBe("composer exploded");
    expect(badStored?.lastRunAt).toBeTruthy();

    // The engine is unharmed: the next interval processes both again.
    clock.advance(10 * MIN);
    const second = await engine.tick();
    expect(second.runs).toHaveLength(2);
  });
});

describe("AutomationEngine — enabled / disabled", () => {
  it("never fires a disabled schedule, before or after toggling", async () => {
    const clock = fakeClock(T0);
    const { runner, calls } = recorder();
    const engine = new AutomationEngine({ runner, now: clock.now });
    const off = await engine.addSchedule({
      name: "off from birth",
      enabled: false,
      trigger: { type: "interval", everyMinutes: 5 },
      job: intervalJob,
    });
    const toggled = await engine.addSchedule({
      name: "toggled off",
      trigger: { type: "interval", everyMinutes: 5 },
      job: intervalJob,
    });
    await engine.setEnabled(toggled.id, false);
    clock.advance(60 * MIN);
    await engine.start();
    await engine.tick();
    expect(calls).toHaveLength(0);
    expect((await engine.getSchedule(off.id))?.lastRunAt).toBeUndefined();

    await engine.setEnabled(toggled.id, true);
    await engine.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].schedule.id).toBe(toggled.id);
  });

  it("throws ScheduleNotFoundError for unknown ids", async () => {
    const engine = new AutomationEngine({ runner: async () => "ok" });
    await expect(engine.setEnabled("nope", true)).rejects.toThrow(
      ScheduleNotFoundError,
    );
    expect(await engine.removeSchedule("nope")).toBe(false);
    expect(await engine.getSchedule("nope")).toBeUndefined();
  });
});

describe("AutomationEngine — catch-up at start", () => {
  const day1at8 = new Date(2026, 0, 15, 8, 0);
  const day2at7 = new Date(2026, 0, 16, 7, 0);
  const day2at9 = new Date(2026, 0, 16, 9, 0);

  async function missedDaily(catchUp: boolean) {
    const store = new InMemoryScheduleStore();
    const clock = fakeClock(day1at8);
    const { runner, calls } = recorder();
    const first = new AutomationEngine({ store, runner, now: clock.now });
    const schedule = await first.addSchedule({
      name: "daily post",
      trigger: { type: "daily", at: "09:00" },
      job: intervalJob,
      catchUp,
    });
    // The app is off from day 1 08:00 until day 2 07:00: the day-1
    // 09:00 slot passes with nobody home.
    clock.set(day2at7);
    const restarted = new AutomationEngine({ store, runner, now: clock.now });
    return { clock, calls, restarted, schedule };
  }

  it("catchUp: true fires the missed daily once on start", async () => {
    const { clock, calls, restarted, schedule } = await missedDaily(true);
    const report = await restarted.start();
    expect(calls).toHaveLength(1);
    expect(report.runs).toEqual([
      { scheduleId: schedule.id, status: "ok", result: "ok" },
    ]);
    // Advanced, not stuck: today's own 09:00 slot still fires later.
    clock.set(day2at9);
    await restarted.tick();
    expect(calls).toHaveLength(2);
  });

  it("catchUp: false skips the missed daily but advances it", async () => {
    const { clock, calls, restarted, schedule } = await missedDaily(false);
    const report = await restarted.start();
    expect(calls).toHaveLength(0);
    expect(report.runs).toEqual([{ scheduleId: schedule.id, status: "skipped" }]);
    const stored = await restarted.getSchedule(schedule.id);
    expect(stored?.lastStatus).toBe("skipped");
    expect(stored?.lastResult).toBe("skipped");
    // It is advanced, not dead: today's 09:00 slot fires normally.
    clock.set(day2at9);
    await restarted.tick();
    expect(calls).toHaveLength(1);
  });

  it("applies catch-up on the first tick when start() was never called", async () => {
    const { calls, restarted } = await missedDaily(false);
    await restarted.tick();
    expect(calls).toHaveLength(0);
  });
});

describe("AutomationEngine — once across a restart", () => {
  it("fires at its time and stays fired after a full restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "automations-"));
    try {
      const clock = fakeClock(T0);
      const { runner, calls } = recorder();
      const engine = new AutomationEngine({
        store: new FileScheduleStore(dir),
        runner,
        now: clock.now,
      });
      const schedule = await engine.addSchedule({
        name: "one-off",
        trigger: { type: "once", at: new Date(T0.getTime() + 10 * MIN).toISOString() },
        job: intervalJob,
      });
      await engine.tick();
      expect(calls).toHaveLength(0);
      clock.advance(11 * MIN);
      await engine.tick();
      expect(calls).toHaveLength(1);

      // A brand-new engine over a brand-new store on the same directory.
      clock.advance(60 * MIN);
      const restarted = new AutomationEngine({
        store: new FileScheduleStore(dir),
        runner,
        now: clock.now,
      });
      await restarted.start();
      await restarted.tick();
      expect(calls).toHaveLength(1);
      const stored = await restarted.getSchedule(schedule.id);
      expect(stored?.lastStatus).toBe("ok");
      expect(restarted.nextDueAt(stored!)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("AutomationEngine — addSchedule validation", () => {
  it("rejects bad triggers, empty names and missing payloads", async () => {
    const engine = new AutomationEngine({ runner: async () => "ok" });
    await expect(
      engine.addSchedule({
        name: "x",
        trigger: { type: "interval", everyMinutes: 0 },
        job: {},
      }),
    ).rejects.toThrow(ScheduleValidationError);
    await expect(
      engine.addSchedule({
        name: "   ",
        trigger: { type: "daily", at: "09:00" },
        job: {},
      }),
    ).rejects.toThrow(ScheduleValidationError);
    await expect(
      engine.addSchedule({
        name: "x",
        trigger: { type: "daily", at: "9am" },
        job: {},
      }),
    ).rejects.toThrow(ScheduleValidationError);
    await expect(
      engine.addSchedule({
        name: "x",
        trigger: { type: "daily", at: "09:00" },
      } as unknown as AddScheduleInput),
    ).rejects.toThrow(ScheduleValidationError);
  });

  it("removeSchedule deletes and reports honestly", async () => {
    const engine = new AutomationEngine({ runner: async () => "ok" });
    const schedule = await engine.addSchedule({
      name: "temp",
      trigger: { type: "interval", everyMinutes: 5 },
      job: {},
    });
    expect(await engine.removeSchedule(schedule.id)).toBe(true);
    expect(await engine.listSchedules()).toEqual([]);
  });
});
