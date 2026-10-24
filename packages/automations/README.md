# @kavvo/automations — Automations

Schedules + triggers that run jobs: "daily 9am: post + report". The
engine owns **when**; an injected runner owns **what**. This package
never imports the Agent Composer — the seam is the runner.

## The seam

```ts
const engine = new AutomationEngine({
  store: new FileScheduleStore(dataDir),
  now: () => new Date(),            // injectable clock (tests fake it)
  runner: {
    async run(job, schedule) {      // or pass a bare function
      const state = await composer.run(job as JobDefinition);
      return state.status;          // any short result string
    },
  },
});
```

- `schedule.job` is an **opaque payload**, handed to the runner
  untouched. In production it is a Composer `JobDefinition`; here it
  can be anything (JSON-serializable if the store is file-backed).
- The runner returns a result string or throws. Either way the engine
  records it on the schedule (`lastRunAt`, `lastResult`, `lastStatus`
  of `"ok" | "error" | "skipped"`) and moves on — a failing job never
  breaks the pass or the engine.
- The `TickReport` a pass returns (and the records persisted on each
  schedule) is where completion notifications hook in later: the
  mobile push / UI layer reads run outcomes from there. No
  notifications are built in this package.

## Schedules and triggers

A `Schedule` is `{ id, name, enabled, trigger, job, catchUp,
createdAt, lastRunAt?, lastResult?, lastStatus? }`. Schedules are
added, removed, enabled/disabled and listed through the engine;
`addSchedule` fills defaults (`enabled: true`, `catchUp: false`,
random-UUID id, `createdAt` from the engine's clock) and validates —
bad triggers, empty names and unsafe ids raise
`ScheduleValidationError`, unknown ids raise
`ScheduleNotFoundError`.

Three triggers, computed by the pure `nextRun(trigger, from)`:

| Trigger | Next run |
| --- | --- |
| `{ type: "interval", everyMinutes }` | `from + everyMinutes` |
| `{ type: "daily", at: "HH:MM" }` | today at HH:MM if still ahead of `from`, else tomorrow |
| `{ type: "once", at: ISO }` | the timestamp if ahead of `from`, else `null` (spent) |

- **Anchor choice:** the engine computes due times as
  `nextRun(trigger, lastRunAt ?? createdAt)` — each slot counts from
  the last *processed* run. A schedule that falls behind (app off,
  late tick) fires **once** per pass and re-anchors, never in a
  burst. The cost is drift: a 30-minute interval that ran 5 minutes
  late next runs 30 minutes after the late run, not on a fixed grid.
- **Daily times are host-local wall clock** ("09:00" means 9am where
  the process runs), matching cron-on-a-desktop expectations. A
  `from` exactly at HH:MM counts as passed; the next slot is
  tomorrow's.
- **A fired once never refires**, including across restarts: firing
  stamps `lastRunAt`, after which `nextRun` returns `null` for it
  forever.

## Catch-up

The engine distinguishes its first pass from later ones:

- `start()` runs one **catch-up pass**; the first `tick()` on a
  fresh engine implies `start()`. `start()` is idempotent.
- In the catch-up pass, a past-due schedule fires **once** when its
  `catchUp` is true. When false, the missed slot is **skipped but
  advanced**: the engine persists a `"skipped"` record (with
  `lastRunAt` stamped, which re-anchors the schedule), so the
  schedule resumes at its next real slot instead of firing late or
  getting stuck.
- Later `tick()` passes ignore `catchUp` entirely — it governs only
  the moment the app comes back to life. A schedule *added* to an
  already-started engine is therefore never catch-up-skipped.

`tick()` runs due schedules sequentially in creation order and
persists each schedule's record right after it is processed, so a
crash mid-pass keeps what already ran.

## Stores

`AutomationStore` mirrors the Composer's `JobStore` split:

- `InMemoryScheduleStore` — a `Map` with copy-in/copy-out isolation.
  Survives engine instances, not restarts.
- `FileScheduleStore(dir)` — one JSON file per schedule
  (`<dir>/<id>.json`), temp-file + rename writes, disk as source of
  truth. Job payloads must be JSON-serializable. State survives full
  process restarts.

## Not yet (by design)

- No timer loop of its own: the host decides how often to call
  `tick()` (the desktop shell will run a 30–60s interval; the cloud
  tier can call it from its own scheduler). The engine is a pure
  function of clock + store, which is what makes it testable.
- No notifications on completion yet — the `TickReport` and the
  per-schedule records are the documented hook point.
- No cron expressions, weekdays-only rules or timezone-pinned daily
  times; the three trigger types cover the launch automations, and
  new trigger types slot into `nextRun` without touching the engine.
