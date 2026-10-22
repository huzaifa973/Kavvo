import {
  ScheduleValidationError,
  type Schedule,
  type Trigger,
} from "./types.js";

const DAILY_AT = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** Parse a daily trigger's "HH:MM" into [hours, minutes], or throw. */
export function parseDailyAt(at: string): [number, number] {
  if (typeof at !== "string" || !DAILY_AT.test(at)) {
    throw new ScheduleValidationError(
      `daily trigger "at" must be "HH:MM" (24-hour), got ${JSON.stringify(at)}`,
    );
  }
  const [h, m] = at.split(":").map(Number);
  return [h, m];
}

/** Validate a trigger's shape and values. Throws ScheduleValidationError. */
export function validateTrigger(trigger: Trigger): void {
  if (!trigger || typeof trigger !== "object") {
    throw new ScheduleValidationError("trigger must be an object");
  }
  switch (trigger.type) {
    case "interval": {
      const { everyMinutes } = trigger;
      if (
        typeof everyMinutes !== "number" ||
        !Number.isFinite(everyMinutes) ||
        everyMinutes <= 0
      ) {
        throw new ScheduleValidationError(
          `interval trigger "everyMinutes" must be a positive number, got ${JSON.stringify(everyMinutes)}`,
        );
      }
      return;
    }
    case "daily":
      parseDailyAt(trigger.at);
      return;
    case "once": {
      if (
        typeof trigger.at !== "string" ||
        Number.isNaN(Date.parse(trigger.at))
      ) {
        throw new ScheduleValidationError(
          `once trigger "at" must be an ISO 8601 timestamp, got ${JSON.stringify(trigger.at)}`,
        );
      }
      return;
    }
    default:
      throw new ScheduleValidationError(
        `unknown trigger type ${JSON.stringify((trigger as { type?: unknown }).type)}`,
      );
  }
}

const SCHEDULE_ID = /^[A-Za-z0-9_-]+$/;

/** Validate a full schedule record. Throws ScheduleValidationError. */
export function assertValidSchedule(schedule: Schedule): void {
  if (!schedule || typeof schedule !== "object") {
    throw new ScheduleValidationError("schedule must be an object");
  }
  if (typeof schedule.id !== "string" || !SCHEDULE_ID.test(schedule.id)) {
    throw new ScheduleValidationError(
      `schedule id must match [A-Za-z0-9_-]+, got ${JSON.stringify(schedule.id)}`,
    );
  }
  if (typeof schedule.name !== "string" || schedule.name.trim() === "") {
    throw new ScheduleValidationError("schedule name must be a non-empty string");
  }
  if (typeof schedule.enabled !== "boolean") {
    throw new ScheduleValidationError("schedule enabled must be a boolean");
  }
  if (typeof schedule.catchUp !== "boolean") {
    throw new ScheduleValidationError("schedule catchUp must be a boolean");
  }
  validateTrigger(schedule.trigger);
  if (
    typeof schedule.createdAt !== "string" ||
    Number.isNaN(Date.parse(schedule.createdAt))
  ) {
    throw new ScheduleValidationError(
      `schedule createdAt must be an ISO 8601 timestamp, got ${JSON.stringify(schedule.createdAt)}`,
    );
  }
  if (
    schedule.lastRunAt !== undefined &&
    (typeof schedule.lastRunAt !== "string" ||
      Number.isNaN(Date.parse(schedule.lastRunAt)))
  ) {
    throw new ScheduleValidationError(
      `schedule lastRunAt must be an ISO 8601 timestamp, got ${JSON.stringify(schedule.lastRunAt)}`,
    );
  }
}

/**
 * The next time a trigger fires strictly after `from`, or null when it
 * never fires again. Pure: same inputs, same answer, no clock reads.
 *
 * - interval: `from + everyMinutes`. The caller passes the anchor as
 *   `from` — the engine anchors on `lastRunAt ?? createdAt`, so each
 *   interval counts from the last processed run, not from a fixed grid.
 * - daily: today at HH:MM (host-local) when that is still ahead of
 *   `from`, else tomorrow at HH:MM. A `from` exactly at HH:MM counts
 *   as passed — the next slot is tomorrow's.
 * - once: the trigger's timestamp when it is still ahead of `from`,
 *   else null. A once whose time has passed relative to its anchor is
 *   spent and never fires again.
 */
export function nextRun(trigger: Trigger, from: Date): Date | null {
  validateTrigger(trigger);
  switch (trigger.type) {
    case "interval":
      return new Date(from.getTime() + trigger.everyMinutes * 60_000);
    case "daily": {
      const [h, m] = parseDailyAt(trigger.at);
      const next = new Date(from);
      next.setHours(h, m, 0, 0);
      if (next.getTime() <= from.getTime()) {
        next.setDate(next.getDate() + 1);
      }
      return next;
    }
    case "once": {
      const at = new Date(trigger.at);
      return at.getTime() > from.getTime() ? at : null;
    }
  }
}

/**
 * When a schedule is next due, computed from its anchor
 * (`lastRunAt ?? createdAt`). Null means never again (a spent once).
 */
export function nextDueAt(schedule: Schedule): Date | null {
  const anchor = new Date(schedule.lastRunAt ?? schedule.createdAt);
  return nextRun(schedule.trigger, anchor);
}
