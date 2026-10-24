import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The shell imports the core packages by relative path (not the
// @kavvo/* aliases) on purpose: tsc then emits a self-contained
// dist/ tree whose imports Node can resolve directly, with no bundler
// and no type-stripping involved at run time.
import {
  Composer,
  JobDefinitionError,
  JobNotFoundError,
  type JobDefinition,
  type JobState,
} from "../../../packages/composer/src/index.js";
import {
  SkillInputError,
  SkillNotFoundError,
  type SkillRegistry,
} from "../../../packages/skill-engine/src/index.js";
import {
  MEMORY_KINDS,
  MemoryValidationError,
  type MemoryCore,
  type MemoryKind,
  type MemoryStore,
} from "../../../packages/memory-core/src/index.js";
import {
  ScheduleNotFoundError,
  ScheduleValidationError,
  type AutomationEngine,
  type Schedule,
  type Trigger,
} from "../../../packages/automations/src/index.js";
import {
  ForgeError,
  forgeSkill,
  unforge,
  type ForgeStore,
  type SkillSampleCase,
  type SkillSpec,
} from "../../../packages/skill-forge/src/index.js";
import { createCore, type KavvoCore } from "./core.js";

/** Bodies larger than this are rejected with 413 before any parsing. */
export const MAX_BODY_BYTES = 1_000_000;

/** Default cadence for the automation tick while the shell runs. */
export const DEFAULT_AUTOMATION_INTERVAL_MS = 30_000;

export interface WebShellOptions {
  /** Skill registry to serve. Defaults to `createDefaultRegistry()`. */
  registry?: SkillRegistry;
  /**
   * Data dir the core persists under (`<dataDir>/jobs`, `/memory`,
   * `/forge`, `/automations`). Defaults to `KAVVO_DATA_DIR` or
   * `<cwd>/.data`.
   */
  dataDir?: string;
  /** Static UI directory. Defaults to the package's `public/` folder. */
  publicDir?: string;
  /**
   * Milliseconds between automation ticks (`engine.tick()`) while the
   * shell runs. Defaults to `KAVVO_AUTOMATION_INTERVAL_MS` or
   * 30_000. Zero or negative disables ticking — tests use that to stay
   * deterministic.
   */
  automationIntervalMs?: number;
}

export interface WebShell {
  server: Server;
  /** The one assembled core every handler (and surface) shares. */
  core: KavvoCore;
  composer: Composer;
  registry: SkillRegistry;
  memory: MemoryCore;
  memoryStore: MemoryStore;
  forgeStore: ForgeStore;
  automations: AutomationEngine;
  dataDir: string;
  publicDir: string;
  automationIntervalMs: number;
}

/** The parts of the shell the request handlers need. */
export type ShellContext = Omit<WebShell, "server">;

export interface RunningWebShell extends WebShell {
  port: number;
  url: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

function defaultPublicDir(): string {
  // Source layout: apps/web/src -> apps/web/public.
  // Compiled layout: apps/web/dist/apps/web/src -> apps/web/dist/apps/web/public
  // (the build copies public/ there, see scripts/copy-public.mjs).
  const beside = join(moduleDir, "..", "public");
  if (existsSync(beside)) return beside;
  return join(process.cwd(), "apps", "web", "public");
}

function defaultDataDir(): string {
  return process.env.KAVVO_DATA_DIR ?? join(process.cwd(), ".data");
}

function resolveAutomationIntervalMs(option?: number): number {
  if (option !== undefined) return option;
  const raw = process.env.KAVVO_AUTOMATION_INTERVAL_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return DEFAULT_AUTOMATION_INTERVAL_MS;
}

/**
 * Build the shell: an http.Server (not yet listening) wired to the one
 * assembled core from core.ts — shared registry (built-ins plus any
 * forged skills reloaded at boot), Composer, Memory Core, Skill Forge
 * and AutomationEngine, all persisted under the data dir so state
 * survives process restarts.
 */
export async function createWebShell(
  options: WebShellOptions = {},
): Promise<WebShell> {
  const dataDir = options.dataDir ?? defaultDataDir();
  const publicDir = options.publicDir ?? defaultPublicDir();
  const core = await createCore({ dataDir, registry: options.registry });
  const automationIntervalMs = resolveAutomationIntervalMs(
    options.automationIntervalMs,
  );

  const context: ShellContext = {
    core,
    composer: core.composer,
    registry: core.registry,
    memory: core.memory,
    memoryStore: core.memoryStore,
    forgeStore: core.forgeStore,
    automations: core.automations,
    dataDir,
    publicDir,
    automationIntervalMs,
  };
  const server = createHttpServer((req, res) => {
    handleRequest(context, req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        console.error("kavvo web shell: unexpected error", err);
        sendJson(res, 500, {
          error: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  });
  return { server, ...context };
}

/** Create the shell and start listening. Port 0 picks an ephemeral port. */
export async function startWebShell(
  options: WebShellOptions & { port?: number; host?: string } = {},
): Promise<RunningWebShell> {
  const shell = await createWebShell(options);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.PORT ?? 4317);
  await new Promise<void>((resolveListen, rejectListen) => {
    shell.server.once("error", rejectListen);
    shell.server.listen(port, host, () => resolveListen());
  });
  const address = shell.server.address();
  const boundPort =
    typeof address === "object" && address !== null ? address.port : port;

  // Schedules actually fire while the shell runs: tick the engine on
  // an interval. The timer is unref'd (it never keeps the process
  // alive on its own) and cleared on close(), so tests and shutdown
  // stay clean; a non-positive interval disables ticking entirely.
  let timer: NodeJS.Timeout | undefined;
  if (shell.automationIntervalMs > 0) {
    timer = setInterval(() => {
      void shell.core.tickAutomations().catch((err: unknown) => {
        console.error("kavvo web shell: automation tick failed", err);
      });
    }, shell.automationIntervalMs);
    timer.unref();
  }

  return {
    ...shell,
    port: boundPort,
    url: `http://${host}:${boundPort}`,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        if (timer !== undefined) clearInterval(timer);
        shell.server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

async function handleRequest(
  shell: ShellContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path =
    url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const method = req.method ?? "GET";

  if (path === "/api/health" && method === "GET") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === "/api/skills" && method === "GET") {
    sendJson(
      res,
      200,
      shell.registry.list().map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        inputSchema: skill.inputSchema,
      })),
    );
    return;
  }

  const skillRun = /^\/api\/skills\/(.+)\/run$/.exec(path);
  if (skillRun && method === "POST") {
    await runSkillRoute(shell, req, res, decodeSegment(skillRun[1]));
    return;
  }

  if (path === "/api/jobs" && method === "GET") {
    sendJson(res, 200, await shell.composer.listJobs());
    return;
  }

  if (path === "/api/jobs" && method === "POST") {
    const body = await readJsonBody(req);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "Job definition must be a JSON object");
    }
    let state: JobState;
    try {
      state = await shell.composer.run(body as JobDefinition);
    } catch (err) {
      if (err instanceof JobDefinitionError) {
        throw new HttpError(400, err.message);
      }
      throw err;
    }
    sendJson(res, 201, state);
    return;
  }

  const jobRoute = /^\/api\/jobs\/([^/]+)$/.exec(path);
  if (jobRoute && method === "GET") {
    const job = await shell.composer.getJob(decodeSegment(jobRoute[1]));
    if (!job) {
      throw new HttpError(404, `Job "${decodeSegment(jobRoute[1])}" not found`);
    }
    sendJson(res, 200, job);
    return;
  }

  const jobResume = /^\/api\/jobs\/([^/]+)\/resume$/.exec(path);
  if (jobResume && method === "POST") {
    const jobId = decodeSegment(jobResume[1]);
    try {
      sendJson(res, 200, await shell.composer.resume(jobId));
    } catch (err) {
      if (err instanceof JobNotFoundError) {
        throw new HttpError(404, err.message);
      }
      throw err;
    }
    return;
  }

  /* ---------------- memory ---------------- */

  if (path === "/api/memory/stats" && method === "GET") {
    sendJson(res, 200, await shell.memoryStore.stats());
    return;
  }

  if (path === "/api/memory/context" && method === "GET") {
    const query = url.searchParams.get("q") ?? "";
    const budgetRaw = url.searchParams.get("budget");
    let tokenBudget: number | undefined;
    if (budgetRaw !== null) {
      const parsed = Number(budgetRaw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new HttpError(
          400,
          `budget must be a positive integer, got "${budgetRaw}"`,
        );
      }
      tokenBudget = parsed;
    }
    const context = await shell.memory.buildContext(
      query,
      tokenBudget === undefined ? {} : { tokenBudget },
    );
    sendJson(res, 200, {
      context: context.text,
      estimatedTokens: context.estimatedTokens,
    });
    return;
  }

  if (path === "/api/memory" && method === "GET") {
    const kindRaw = url.searchParams.get("kind");
    let kind: MemoryKind | undefined;
    if (kindRaw !== null) {
      if (!(MEMORY_KINDS as readonly string[]).includes(kindRaw)) {
        throw new HttpError(
          400,
          `kind must be one of ${MEMORY_KINDS.join(", ")}`,
        );
      }
      kind = kindRaw as MemoryKind;
    }
    const tag = url.searchParams.get("tag") ?? undefined;
    sendJson(res, 200, await shell.memoryStore.list({ kind, tag }));
    return;
  }

  if (path === "/api/memory" && method === "POST") {
    const body = await readJsonBody(req);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "Memory must be a JSON object");
    }
    const input = body as {
      kind?: unknown;
      text?: unknown;
      tags?: unknown;
      importance?: unknown;
      source?: unknown;
    };
    if (
      input.tags !== undefined &&
      (!Array.isArray(input.tags) ||
        input.tags.some((tag) => typeof tag !== "string"))
    ) {
      throw new HttpError(400, "tags must be an array of strings");
    }
    try {
      // store.add IS the dedupe front door: a near-identical memory
      // updates the existing item (same id) instead of duplicating it.
      const item = await shell.memoryStore.add({
        kind: input.kind as MemoryKind,
        text: input.text as string,
        tags: input.tags as string[] | undefined,
        importance: input.importance as number | undefined,
        source: typeof input.source === "string" ? input.source : undefined,
      });
      sendJson(res, 201, item);
    } catch (err) {
      if (err instanceof MemoryValidationError) {
        throw new HttpError(400, err.message);
      }
      throw err;
    }
    return;
  }

  const memoryRoute = /^\/api\/memory\/([^/]+)$/.exec(path);
  if (memoryRoute && method === "DELETE") {
    const id = decodeSegment(memoryRoute[1]);
    const forgotten = await shell.memoryStore.forget(id);
    if (!forgotten) {
      throw new HttpError(404, `Memory "${id}" not found`);
    }
    sendJson(res, 200, { forgotten: true, id });
    return;
  }

  /* ---------------- automations ---------------- */

  if (path === "/api/automations" && method === "GET") {
    const schedules = await shell.automations.listSchedules();
    sendJson(res, 200, schedules.map((s) => scheduleView(shell, s)));
    return;
  }

  if (path === "/api/automations" && method === "POST") {
    const body = await readJsonBody(req);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "Schedule must be a JSON object");
    }
    const input = body as {
      id?: unknown;
      name?: unknown;
      trigger?: unknown;
      job?: unknown;
      catchUp?: unknown;
      enabled?: unknown;
    };
    if (
      input.job === null ||
      typeof input.job !== "object" ||
      Array.isArray(input.job)
    ) {
      throw new HttpError(
        400,
        "job must be a Composer job definition object",
      );
    }
    try {
      const schedule = await shell.automations.addSchedule({
        id: input.id as string | undefined,
        name: input.name as string,
        trigger: input.trigger as Trigger,
        job: input.job,
        catchUp: input.catchUp as boolean | undefined,
        enabled: input.enabled as boolean | undefined,
      });
      sendJson(res, 201, scheduleView(shell, schedule));
    } catch (err) {
      if (err instanceof ScheduleValidationError) {
        throw new HttpError(400, err.message);
      }
      throw err;
    }
    return;
  }

  const automationToggle =
    /^\/api\/automations\/([^/]+)\/(enable|disable)$/.exec(path);
  if (automationToggle && method === "POST") {
    const scheduleId = decodeSegment(automationToggle[1]);
    try {
      const schedule = await shell.automations.setEnabled(
        scheduleId,
        automationToggle[2] === "enable",
      );
      sendJson(res, 200, scheduleView(shell, schedule));
    } catch (err) {
      if (err instanceof ScheduleNotFoundError) {
        throw new HttpError(404, err.message);
      }
      throw err;
    }
    return;
  }

  const automationRoute = /^\/api\/automations\/([^/]+)$/.exec(path);
  if (automationRoute && method === "DELETE") {
    const scheduleId = decodeSegment(automationRoute[1]);
    const removed = await shell.automations.removeSchedule(scheduleId);
    if (!removed) {
      throw new HttpError(404, `Schedule "${scheduleId}" not found`);
    }
    sendJson(res, 200, { removed: true, id: scheduleId });
    return;
  }

  /* ---------------- forge ---------------- */

  if (path === "/api/forge" && method === "GET") {
    sendJson(res, 200, await shell.forgeStore.list());
    return;
  }

  if (path === "/api/forge" && method === "POST") {
    const body = await readJsonBody(req);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "Forge request must be a JSON object");
    }
    const input = body as { spec?: unknown; samples?: unknown };
    if (input.samples !== undefined && !Array.isArray(input.samples)) {
      throw new HttpError(400, "samples must be an array of smoke cases");
    }
    try {
      const { skill, record } = await forgeSkill(
        input.spec as SkillSpec,
        shell.registry,
        {
          store: shell.forgeStore,
          samples: input.samples as SkillSampleCase[] | undefined,
        },
      );
      sendJson(res, 201, {
        skill: {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          inputSchema: skill.inputSchema,
        },
        record,
      });
    } catch (err) {
      if (err instanceof ForgeError) {
        // A failed forge is a clean client error carrying the stage
        // that rejected it (validate / compile / smoke / register);
        // the forge guarantees registry + store were left untouched.
        sendJson(res, 400, {
          error: err.message,
          stage: err.stage,
          ...(err.skillId !== undefined ? { skillId: err.skillId } : {}),
        });
        return;
      }
      throw err;
    }
    return;
  }

  const forgeRoute = /^\/api\/forge\/([^/]+)$/.exec(path);
  if (forgeRoute && method === "DELETE") {
    const skillId = decodeSegment(forgeRoute[1]);
    const unforged = await unforge(shell.registry, shell.forgeStore, skillId);
    if (!unforged) {
      throw new HttpError(404, `Forged skill "${skillId}" not found`);
    }
    sendJson(res, 200, { unforged: true, id: skillId });
    return;
  }

  if (path.startsWith("/api/")) {
    throw new HttpError(404, `No such API route: ${method} ${path}`);
  }

  if (method === "GET" || method === "HEAD") {
    await serveStatic(shell, res, path, method === "HEAD");
    return;
  }

  throw new HttpError(404, `Not found: ${method} ${path}`);
}

/** A schedule plus its computed next due time (ISO, or null when spent). */
function scheduleView(
  shell: ShellContext,
  schedule: Schedule,
): Schedule & { nextDueAt: string | null } {
  const due = shell.automations.nextDueAt(schedule);
  return { ...schedule, nextDueAt: due ? due.toISOString() : null };
}

async function runSkillRoute(
  shell: ShellContext,
  req: IncomingMessage,
  res: ServerResponse,
  skillId: string,
): Promise<void> {
  if (!shell.registry.has(skillId)) {
    throw new HttpError(404, `Skill "${skillId}" is not registered`);
  }
  const body = await readJsonBody(req);
  try {
    const result = await shell.registry.runSkill(
      skillId,
      (body ?? {}) as Record<string, unknown>,
    );
    sendJson(res, 200, { result });
  } catch (err) {
    if (err instanceof SkillNotFoundError) {
      throw new HttpError(404, err.message);
    }
    if (err instanceof SkillInputError) {
      throw new HttpError(400, err.message);
    }
    throw err;
  }
}

/**
 * Read and JSON-parse a request body defensively: bodies over
 * MAX_BODY_BYTES are refused with 413 (the rest is drained and
 * discarded), unparseable bodies with 400, an empty body counts as {}.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
    } else if (!tooLarge) {
      chunks.push(buffer);
    }
  }
  if (tooLarge) {
    throw new HttpError(
      413,
      `Request body exceeds the ${MAX_BODY_BYTES}-byte limit`,
    );
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function serveStatic(
  shell: ShellContext,
  res: ServerResponse,
  path: string,
  headOnly: boolean,
): Promise<void> {
  const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  const root = resolve(shell.publicDir);
  const filePath = resolve(join(root, relative));
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    throw new HttpError(404, `Not found: ${path}`);
  }
  let content: Buffer;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new HttpError(404, `Not found: ${path}`);
    content = await readFile(filePath);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(404, `Not found: ${path}`);
  }
  res.writeHead(200, {
    "content-type":
      CONTENT_TYPES[extname(filePath).toLowerCase()] ??
      "application/octet-stream",
    "content-length": content.length,
  });
  res.end(headOnly ? undefined : content);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, `Malformed URL segment: ${segment}`);
  }
}

// Entry point when run directly (npm start): node dist/apps/web/src/server.js
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const shell = await startWebShell();
  const report = shell.core.forgeLoadReport;
  if (report.loaded.length > 0) {
    console.log(`Forged skills loaded at boot: ${report.loaded.join(", ")}`);
  }
  for (const skip of report.skipped) {
    console.warn(`Forged skill skipped at boot (${skip.id}): ${skip.reason}`);
  }
  console.log(
    `Kavvo web shell listening on ${shell.url} (data dir: ${shell.dataDir})`,
  );
}
