import { describe, expect, it } from "vitest";
import { nextRun, ScheduleValidationError } from "../src/index.js";

// Local-time construction keeps the daily tests timezone-independent:
// a daily trigger reads the host's wall clock, and so do these fixtures.
const local = (h: number, m: number, s = 0, day = 15) =>
  new Date(2026, 0, day, h, m, s);

describe("nextRun — interval", () => {
  it("adds everyMinutes to the anchor", () => {
    const from = new Date("2026-01-15T08:00:00.000Z");
    expect(nextRun({ type: "interval", everyMinutes: 45 }, from)?.getTime()).toBe(
      from.getTime() + 45 * 60_000,
    );
    expect(nextRun({ type: "interval", everyMinutes: 1 }, from)?.getTime()).toBe(
      from.getTime() + 60_000,
    );
  });
});

describe("nextRun — daily", () => {
  it("returns today at HH:MM while it is still ahead", () => {
    const next = nextRun({ type: "daily", at: "09:30" }, local(8, 15));
    expect(next?.getTime()).toBe(local(9, 30).getTime());
  });

  it("returns tomorrow at HH:MM once today's slot has passed", () => {
    const next = nextRun({ type: "daily", at: "09:30" }, local(10, 0));
    expect(next?.getTime()).toBe(local(9, 30, 0, 16).getTime());
  });

  it("treats a from exactly at HH:MM as passed (boundary)", () => {
    const next = nextRun({ type: "daily", at: "09:30" }, local(9, 30, 0));
    expect(next?.getTime()).toBe(local(9, 30, 0, 16).getTime());
  });

  it("returns today when from is one second before the slot", () => {
    const next = nextRun({ type: "daily", at: "09:30" }, local(9, 29, 59));
    expect(next?.getTime()).toBe(local(9, 30).getTime());
  });

  it("handles a midnight slot across the day boundary", () => {
    expect(nextRun({ type: "daily", at: "00:00" }, local(23, 59))?.getTime()).toBe(
      local(0, 0, 0, 16).getTime(),
    );
    expect(nextRun({ type: "daily", at: "00:00" }, local(0, 0, 0))?.getTime()).toBe(
      local(0, 0, 0, 16).getTime(),
    );
  });
});

describe("nextRun — once", () => {
  const from = new Date("2026-01-15T08:00:00.000Z");

  it("returns the timestamp while it is ahead", () => {
    const at = "2026-01-15T09:00:00.000Z";
    expect(nextRun({ type: "once", at }, from)?.toISOString()).toBe(at);
  });

  it("returns null when the timestamp is past", () => {
    expect(
      nextRun({ type: "once", at: "2026-01-15T07:59:59.000Z" }, from),
    ).toBeNull();
  });

  it("returns null when the timestamp equals from (already spent)", () => {
    expect(nextRun({ type: "once", at: from.toISOString() }, from)).toBeNull();
  });
});

describe("nextRun — validation", () => {
  const from = new Date("2026-01-15T08:00:00.000Z");

  it("rejects non-positive interval minutes", () => {
    expect(() => nextRun({ type: "interval", everyMinutes: 0 }, from)).toThrow(
      ScheduleValidationError,
    );
    expect(() => nextRun({ type: "interval", everyMinutes: -5 }, from)).toThrow(
      ScheduleValidationError,
    );
  });

  it("rejects malformed daily times", () => {
    expect(() => nextRun({ type: "daily", at: "9:00" }, from)).toThrow(
      ScheduleValidationError,
    );
    expect(() => nextRun({ type: "daily", at: "24:00" }, from)).toThrow(
      ScheduleValidationError,
    );
    expect(() => nextRun({ type: "daily", at: "12:60" }, from)).toThrow(
      ScheduleValidationError,
    );
  });

  it("rejects an unparseable once timestamp", () => {
    expect(() => nextRun({ type: "once", at: "not-a-date" }, from)).toThrow(
      ScheduleValidationError,
    );
  });
});
