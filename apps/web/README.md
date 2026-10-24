# @kavvo/web — the app shell

A local HTTP server (Node's built-in `http`, no runtime dependencies)
plus a single-page UI that runs the assembled Kavvo core end to
end. One shared instance set (see `src/core.ts`) serves everything:
the Skill Engine's skills (built-ins plus forged skills, which are
reloaded from disk at boot), the Agent Composer's checkpointed jobs,
the Memory Core, Automations, and the Skill Forge — all persisted
under one data dir, so state survives restarts.

## Run it

```bash
npm install          # once, at the repo root (links the workspaces)
cd apps/web
npm run build        # tsc -> dist/, plus a copy of public/ into dist/
npm start            # node dist/apps/web/src/server.js
```

Then open http://127.0.0.1:4317.

Environment:

- `PORT` — listen port (default 4317). Host is 127.0.0.1: this is a
  local shell, not a hosted service.
- `KAVVO_DATA_DIR` — the data dir. Layout: `<dir>/jobs/` (job
  checkpoints), `<dir>/memory/`, `<dir>/forge/` (forged-skill
  records), `<dir>/automations/` (schedules). Default: `.data/`
  under the directory the server was started from.
- `KAVVO_AUTOMATION_INTERVAL_MS` — how often the automation
  engine ticks while the shell runs, so schedules fire (default
  30000). Zero or negative disables ticking.

For development without a build, the vitest suite at the repo root
(`npm test`) exercises this package straight from source.

## API

| Route | What it does |
| --- | --- |
| `GET /api/health` | `{ ok: true }` |
| `GET /api/skills` | All registered skills — built-ins and forged (id, name, description, inputSchema) |
| `POST /api/skills/:id/run` | JSON body is the skill input → `{ result }`; unknown skill 404, invalid input 400 with the skill's error message |
| `GET /api/jobs` | All persisted jobs |
| `POST /api/jobs` | Body is a Composer job definition → creates, runs, returns the job state (201) |
| `GET /api/jobs/:id` | The persisted job state, or 404 |
| `POST /api/jobs/:id/resume` | Resumes from the first incomplete step, returns the state |
| `GET /api/memory?kind=&tag=` | Memory items, optionally filtered (unknown kind 400) |
| `GET /api/memory/stats` | Memory totals, overall and by kind |
| `POST /api/memory` | `{ kind, text, tags?, importance? }` → the item (201). Dedupes: a near-identical restatement updates the existing item |
| `DELETE /api/memory/:id` | Forgets the item; 404 when unknown |
| `GET /api/memory/context?q=&budget=` | `{ context, estimatedTokens }` — the budgeted context string for a query |
| `GET /api/automations` | Schedules, each with its computed `nextDueAt` |
| `POST /api/automations` | `{ name, trigger, job, catchUp? }` → the created schedule (201); `job` is a Composer job definition the schedule runs when it fires |
| `POST /api/automations/:id/enable` · `/disable` | Toggles a schedule; 404 when unknown |
| `DELETE /api/automations/:id` | Removes a schedule; 404 when unknown |
| `GET /api/forge` | Forged-skill provenance records |
| `POST /api/forge` | `{ spec, samples? }` → `{ skill, record }` (201). A failed forge is a 400 carrying `{ error, stage }` |
| `DELETE /api/forge/:id` | Unforges the skill (removes it from the registry); 404 when the forge never made it |

Request bodies are capped at 1 MB (413 past that) and malformed JSON
is a clean 400. Anything else under `/` is served from `public/`.

## Layout notes

- `src/core.ts` assembles the one core (registry, Composer, Memory
  Core, forge store + boot reload, AutomationEngine whose runner
  executes `schedule.job` through the Composer). `src/server.ts`
  is the HTTP surface over it. Both import the core packages by
  relative path, not the `@kavvo/*` aliases, so the tsc output
  in `dist/` is a self-contained tree plain Node can run — no
  bundler, no type-stripping at run time.
- The UI (`public/`) is vanilla JS with no build step. Its colors are
  CSS custom properties scoped to `[data-theme="dark"]` in
  `style.css`, so later themes are new variable blocks.
- Chat steps in job definitions are accepted, but this shell wires no
  chat client yet, so a chat step fails cleanly with that recorded as
  the step error (the Brain Router plugs into `createCore` when BYOK
  keys land).

Deferred on purpose (see BUILD-LOG.md): the Electron desktop wrapper,
the mobile app, and any form of auth — the shell is local-only.
