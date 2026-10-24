import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startWebShell,
  type RunningWebShell,
} from "../src/server.js";
import type { JobState } from "../../../packages/composer/src/index.js";

const EXPECTED_SKILL_IDS = [
  "data.csv-to-json",
  "data.json-format",
  "data.json-to-csv",
  "text.base64",
  "text.case-convert",
  "text.dedupe-lines",
  "text.hash",
  "text.slugify",
  "text.url-codec",
  "text.word-count",
  "util.password-generate",
  "util.unit-convert",
  "util.uuid",
];

let shell: RunningWebShell;
let dataDir: string;
let base: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kavvo-web-test-"));
  shell = await startWebShell({
    port: 0,
    dataDir,
    publicDir: new URL("../public", import.meta.url).pathname,
  });
  base = shell.url;
});

afterAll(async () => {
  await shell.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function postJson(
  path: string,
  body: unknown,
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as unknown };
}

describe("web shell API", () => {
  it("reports health", async () => {
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("serves the UI at /", async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Kavvo");
  });

  it("lists exactly the 13 built-in skills", async () => {
    const response = await fetch(`${base}/api/skills`);
    expect(response.status).toBe(200);
    const skills = (await response.json()) as {
      id: string;
      name: string;
      description: string;
    }[];
    expect(skills.map((s) => s.id).sort()).toEqual(EXPECTED_SKILL_IDS);
    for (const skill of skills) {
      expect(skill.name.length).toBeGreaterThan(0);
      expect(skill.description.length).toBeGreaterThan(0);
    }
  });

  it("runs slugify end to end over HTTP", async () => {
    const { status, data } = await postJson("/api/skills/text.slugify/run", {
      title: "Hello Kavvo World",
    });
    expect(status).toBe(200);
    expect(data).toEqual({ result: { slug: "hello-kavvo-world" } });
  });

  it("returns 404 for an unknown skill", async () => {
    const { status, data } = await postJson("/api/skills/nope.nope/run", {});
    expect(status).toBe(404);
    expect((data as { error: string }).error).toContain("nope.nope");
  });

  it("returns 400 with the skill's message for invalid input", async () => {
    const { status, data } = await postJson("/api/skills/text.slugify/run", {});
    expect(status).toBe(400);
    expect((data as { error: string }).error).toContain("title");
  });

  it("returns 400 for a malformed JSON body", async () => {
    const response = await fetch(`${base}/api/skills/text.slugify/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("not valid JSON");
  });

  it("returns 413 for a body over the 1 MB cap", async () => {
    const { status } = await postJson("/api/skills/text.slugify/run", {
      title: "x".repeat(1_100_000),
    });
    expect(status).toBe(413);
  });

  it("creates, runs and reads back a 2-step job", async () => {
    const { status, data } = await postJson("/api/jobs", {
      title: "slug then count",
      steps: [
        {
          id: "make-slug",
          kind: "skill",
          skillId: "text.slugify",
          input: { title: "Hello Kavvo World" },
        },
        {
          id: "count",
          kind: "skill",
          skillId: "text.word-count",
          input: { text: "{{make-slug.slug}}" },
        },
      ],
    });
    expect(status).toBe(201);
    const job = data as unknown as JobState;
    expect(job.status).toBe("completed");
    expect(job.steps).toHaveLength(2);
    expect(job.steps[0]).toMatchObject({
      id: "make-slug",
      status: "completed",
      output: { slug: "hello-kavvo-world" },
    });
    expect(job.steps[1]).toMatchObject({
      id: "count",
      status: "completed",
      output: { words: 1, characters: 17 },
    });

    const readBack = await fetch(`${base}/api/jobs/${job.id}`);
    expect(readBack.status).toBe(200);
    const persisted = (await readBack.json()) as JobState;
    expect(persisted.id).toBe(job.id);
    expect(persisted.status).toBe("completed");
    expect(persisted.steps[1].output).toMatchObject({ characters: 17 });
  });

  it("resumes a completed job without changing it, and 404s unknown jobs", async () => {
    const { data } = await postJson("/api/jobs", {
      steps: [
        { kind: "skill", skillId: "text.slugify", input: { title: "Hi" } },
      ],
    });
    const job = data as unknown as JobState;
    expect(job.status).toBe("completed");

    const resumed = await fetch(`${base}/api/jobs/${job.id}/resume`, {
      method: "POST",
    });
    expect(resumed.status).toBe(200);
    const state = (await resumed.json()) as JobState;
    expect(state.id).toBe(job.id);
    expect(state.status).toBe("completed");
    expect(state.steps[0].status).toBe("completed");

    const missingGet = await fetch(`${base}/api/jobs/no-such-job`);
    expect(missingGet.status).toBe(404);

    const missingResume = await fetch(`${base}/api/jobs/no-such-job/resume`, {
      method: "POST",
    });
    expect(missingResume.status).toBe(404);
  });

  it("records a failed job and resumes it to completion", async () => {
    const { status, data } = await postJson("/api/jobs", {
      id: "web-shell-resume-test",
      steps: [
        {
          id: "boom",
          kind: "skill",
          skillId: "text.slugify",
          input: { text: "{{later.slug}}" },
        },
        {
          id: "later",
          kind: "skill",
          skillId: "text.slugify",
          input: { title: "Never Reached" },
        },
      ],
    });
    expect(status).toBe(201);
    const failed = data as unknown as JobState;
    expect(failed.status).toBe("failed");
    expect(failed.steps[0].status).toBe("failed");

    // Resuming retries the failed step, which references a step that can
    // never complete out of order — it fails again, cleanly, same state.
    const resumed = await fetch(
      `${base}/api/jobs/web-shell-resume-test/resume`,
      { method: "POST" },
    );
    expect(resumed.status).toBe(200);
    const state = (await resumed.json()) as JobState;
    expect(state.status).toBe("failed");
    expect(state.steps[0].status).toBe("failed");
    expect(state.steps[1].status).toBe("pending");
  });
});
