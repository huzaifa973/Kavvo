import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startWebShell,
  type RunningWebShell,
} from "../src/server.js";
import { SkillRegistry } from "../../../packages/skill-engine/src/index.js";
import {
  FileForgeStore,
  forgeSkill,
  type ForgedSkillRecord,
  type SkillSpec,
} from "../../../packages/skill-forge/src/index.js";
import type { MemoryItem, MemoryStats } from "../../../packages/memory-core/src/index.js";
import type { Schedule } from "../../../packages/automations/src/index.js";

const SHOUT_SPEC: SkillSpec = {
  id: "text.shout",
  name: "Shout",
  description: "Uppercases the input text and adds a trailing exclamation mark.",
  input: { required: ["text"], properties: { text: "string" } },
  source: [
    'const text = typeof input.text === "string" ? input.text : "";',
    'return { text: text.toUpperCase() + "!" };',
  ].join("\n"),
};

const SHOUT_SAMPLES = [
  { input: { text: "hello" }, expect: { text: "HELLO!" } },
  { input: { text: "bye" } },
];

let shell: RunningWebShell;
let dataDir: string;
let base: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kavvo-integration-test-"));
  // Pre-seed a forged skill into the data dir's forge store, so the
  // boot test proves loadForged re-registers it into the shell's
  // registry before the first request is served.
  const scratchRegistry = new SkillRegistry();
  await forgeSkill(SHOUT_SPEC, scratchRegistry, {
    store: new FileForgeStore(join(dataDir, "forge")),
    samples: SHOUT_SAMPLES,
  });
  shell = await startWebShell({
    port: 0,
    dataDir,
    publicDir: new URL("../public", import.meta.url).pathname,
    // Deterministic: the ticking interval is off; automation firing is
    // exercised through core.tickAutomations() directly instead.
    automationIntervalMs: 0,
  });
  base = shell.url;
});

afterAll(async () => {
  await shell.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined };
}

const getJson = (path: string) => request("GET", path);
const postJson = (path: string, body: unknown) => request("POST", path, body);
const deleteJson = (path: string) => request("DELETE", path);

type ScheduleView = Schedule & { nextDueAt: string | null };

describe("boot with a pre-seeded forged skill", () => {
  it("serves the forged skill in the shared registry and runs it", async () => {
    const { status, data } = await getJson("/api/skills");
    expect(status).toBe(200);
    const skills = data as { id: string }[];
    expect(skills).toHaveLength(14); // 13 built-ins + text.shout
    expect(skills.map((s) => s.id)).toContain("text.shout");

    const run = await postJson("/api/skills/text.shout/run", {
      text: "hello",
    });
    expect(run.status).toBe(200);
    expect(run.data).toEqual({ result: { text: "HELLO!" } });

    const forge = await getJson("/api/forge");
    expect(forge.status).toBe(200);
    const records = forge.data as ForgedSkillRecord[];
    expect(records.map((r) => r.id)).toEqual(["text.shout"]);
    expect(records[0].specHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("memory over HTTP", () => {
  it("adds a memory and dedupes a restatement onto the same item", async () => {
    const first = await postJson("/api/memory", {
      kind: "preference",
      text: "User likes tea",
      tags: ["drink"],
      importance: 4,
    });
    expect(first.status).toBe(201);
    const created = first.data as MemoryItem;
    expect(created.kind).toBe("preference");
    expect(created.importance).toBe(4);

    // Same memory, restated with different case/punctuation, a higher
    // importance and an extra tag: the store's add() updates in place.
    const second = await postJson("/api/memory", {
      kind: "preference",
      text: "user likes tea.",
      tags: ["hot"],
      importance: 5,
    });
    expect(second.status).toBe(201);
    const updated = second.data as MemoryItem;
    expect(updated.id).toBe(created.id);
    expect(updated.importance).toBe(5);
    expect(updated.tags).toEqual(expect.arrayContaining(["drink", "hot"]));

    const list = await getJson("/api/memory?kind=preference");
    expect(list.status).toBe(200);
    expect((list.data as MemoryItem[]).map((m) => m.id)).toEqual([created.id]);

    const stats = await getJson("/api/memory/stats");
    expect(stats.status).toBe(200);
    expect((stats.data as MemoryStats).byKind.preference).toBe(1);
  });

  it("rejects an invalid memory kind with a 400", async () => {
    const { status, data } = await postJson("/api/memory", {
      kind: "bogus",
      text: "whatever",
    });
    expect(status).toBe(400);
    expect((data as { error: string }).error).toContain("kind");
  });

  it("keeps context inside the requested token budget", async () => {
    for (const text of [
      "Zebra stripes are unique",
      "Zebra foals recognize their mothers",
      "Zebra herds migrate across savannas",
    ]) {
      const added = await postJson("/api/memory", { kind: "fact", text });
      expect(added.status).toBe(201);
    }

    const full = await getJson("/api/memory/context?q=zebra");
    expect(full.status).toBe(200);
    const fullData = full.data as { context: string; estimatedTokens: number };
    expect(fullData.context).toContain("Zebra stripes are unique");
    expect(fullData.context).toContain("Zebra foals recognize their mothers");
    expect(fullData.context).toContain("Zebra herds migrate across savannas");
    expect(fullData.estimatedTokens).toBeGreaterThan(0);

    // A 12-token budget fits the header plus exactly one of the three
    // lines; whatever wins the ranking, the budget holds.
    const small = await getJson("/api/memory/context?q=zebra&budget=12");
    expect(small.status).toBe(200);
    const smallData = small.data as { context: string; estimatedTokens: number };
    expect(smallData.estimatedTokens).toBeLessThanOrEqual(12);
    expect(smallData.context).toContain("Zebra");
    expect(
      smallData.context.split("\n").filter((line) => line.startsWith("- ")),
    ).toHaveLength(1);

    const badBudget = await getJson("/api/memory/context?q=zebra&budget=abc");
    expect(badBudget.status).toBe(400);
  });

  it("forgets a memory by id and 404s a second forget", async () => {
    const added = await postJson("/api/memory", {
      kind: "note",
      text: "Temporary scratch note about quokka habitats",
    });
    expect(added.status).toBe(201);
    const id = (added.data as MemoryItem).id;

    const forgotten = await deleteJson(`/api/memory/${id}`);
    expect(forgotten.status).toBe(200);
    expect(forgotten.data).toEqual({ forgotten: true, id });

    const again = await deleteJson(`/api/memory/${id}`);
    expect(again.status).toBe(404);
  });
});

describe("automations over HTTP", () => {
  it("creates, lists, disables and deletes a daily schedule", async () => {
    const created = await postJson("/api/automations", {
      name: "Daily slug",
      trigger: { type: "daily", at: "09:30" },
      job: {
        title: "Daily slug",
        steps: [
          {
            kind: "skill",
            skillId: "text.slugify",
            input: { title: "Daily Report" },
          },
        ],
      },
    });
    expect(created.status).toBe(201);
    const schedule = created.data as ScheduleView;
    expect(schedule.name).toBe("Daily slug");
    expect(schedule.enabled).toBe(true);
    expect(typeof schedule.nextDueAt).toBe("string");

    const list = await getJson("/api/automations");
    expect(list.status).toBe(200);
    const listed = (list.data as ScheduleView[]).find(
      (s) => s.id === schedule.id,
    );
    expect(listed).toBeDefined();
    expect(listed?.nextDueAt).toBe(schedule.nextDueAt);

    const disabled = await request(
      "POST",
      `/api/automations/${schedule.id}/disable`,
    );
    expect(disabled.status).toBe(200);
    expect((disabled.data as ScheduleView).enabled).toBe(false);

    const missing = await request(
      "POST",
      "/api/automations/no-such-schedule/disable",
    );
    expect(missing.status).toBe(404);

    const removed = await deleteJson(`/api/automations/${schedule.id}`);
    expect(removed.status).toBe(200);
    expect(removed.data).toEqual({ removed: true, id: schedule.id });

    const after = await getJson("/api/automations");
    expect(
      (after.data as ScheduleView[]).some((s) => s.id === schedule.id),
    ).toBe(false);
  });

  it("rejects an invalid trigger with a 400", async () => {
    const { status, data } = await postJson("/api/automations", {
      name: "Broken",
      trigger: { type: "daily", at: "25:00" },
      job: {
        steps: [
          { kind: "skill", skillId: "text.slugify", input: { title: "X" } },
        ],
      },
    });
    expect(status).toBe(400);
    expect((data as { error: string }).error).toContain("HH:MM");
  });

  it("runs a due schedule's job through the shared Composer", async () => {
    // The interval is disabled in this shell, so fire the pass
    // directly: the engine's first tick is its catch-up pass, and a
    // catchUp schedule whose slot has passed fires exactly once.
    const schedule = await shell.automations.addSchedule({
      name: "Runner probe",
      trigger: { type: "interval", everyMinutes: 0.0001 },
      catchUp: true,
      job: {
        title: "Runner probe",
        steps: [
          {
            kind: "skill",
            skillId: "text.slugify",
            input: { title: "Tick Tock" },
          },
        ],
      },
    });
    // The interval slot is createdAt + 6 ms; give it a wide margin to
    // actually pass, then fire the pass directly (no timer involved).
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await shell.core.tickAutomations()).toBe(true);
    const after = await shell.automations.getSchedule(schedule.id);
    expect(after?.lastStatus).toBe("ok");
    expect(after?.lastResult).toContain("completed");
  });
});

describe("forge over HTTP", () => {
  const YELL_SPEC: SkillSpec = {
    id: "text.yell",
    name: "Yell",
    description: "Uppercases the input text and adds a trailing exclamation mark.",
    input: { required: ["text"], properties: { text: "string" } },
    source: [
      'const text = typeof input.text === "string" ? input.text : "";',
      'return { text: text.toUpperCase() + "!" };',
    ].join("\n"),
  };

  it("forges a skill, runs it through the skills API, then unforges it", async () => {
    const forged = await postJson("/api/forge", {
      spec: YELL_SPEC,
      samples: [{ input: { text: "hey" }, expect: { text: "HEY!" } }],
    });
    expect(forged.status).toBe(201);
    const payload = forged.data as {
      skill: { id: string };
      record: ForgedSkillRecord;
    };
    expect(payload.skill.id).toBe("text.yell");
    expect(payload.record.id).toBe("text.yell");

    const skills = await getJson("/api/skills");
    expect((skills.data as { id: string }[]).map((s) => s.id)).toContain(
      "text.yell",
    );

    const run = await postJson("/api/skills/text.yell/run", {
      text: "forge works",
    });
    expect(run.status).toBe(200);
    expect(run.data).toEqual({ result: { text: "FORGE WORKS!" } });

    const unforged = await deleteJson("/api/forge/text.yell");
    expect(unforged.status).toBe(200);
    expect(unforged.data).toEqual({ unforged: true, id: "text.yell" });

    const after = await getJson("/api/skills");
    expect((after.data as { id: string }[]).map((s) => s.id)).not.toContain(
      "text.yell",
    );
    const rerun = await postJson("/api/skills/text.yell/run", { text: "x" });
    expect(rerun.status).toBe(404);
    const unforgeAgain = await deleteJson("/api/forge/text.yell");
    expect(unforgeAgain.status).toBe(404);
  });

  it("reports forge failures as a clean 400 carrying the stage", async () => {
    const broken = await postJson("/api/forge", {
      spec: { ...YELL_SPEC, id: "text.broken", source: "const x = ;" },
    });
    expect(broken.status).toBe(400);
    const brokenData = broken.data as { error: string; stage: string };
    expect(brokenData.stage).toBe("compile");
    expect(brokenData.error).toContain("text.broken");

    // text.shout was seeded before boot and is already registered.
    const duplicate = await postJson("/api/forge", { spec: SHOUT_SPEC });
    expect(duplicate.status).toBe(400);
    expect((duplicate.data as { stage: string }).stage).toBe("validate");

    // Both failures left the registry untouched.
    const skills = await getJson("/api/skills");
    const ids = (skills.data as { id: string }[]).map((s) => s.id);
    expect(ids).not.toContain("text.broken");
    expect(ids.filter((id) => id === "text.shout")).toHaveLength(1);
  });
});
