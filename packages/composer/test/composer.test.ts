import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockProvider, Router } from "@skillforge/router";
import {
  SkillRegistry,
  createDefaultRegistry,
  slugifySkill,
  wordCountSkill,
  type Skill,
  type SkillContext,
  type WordCountResult,
} from "@skillforge/skill-engine";
import {
  Composer,
  FileJobStore,
  InMemoryJobStore,
  JobDefinitionError,
  JobNotFoundError,
  type JobState,
  type SkillRunner,
} from "../src/index.js";

/** Wraps a registry and counts every runSkill call, per skill id. */
class CountingRunner implements SkillRunner {
  constructor(
    private readonly inner: SkillRegistry,
    readonly counts: Map<string, number>,
  ) {}

  async runSkill(
    id: string,
    input: Record<string, unknown>,
    ctx?: SkillContext,
  ): Promise<unknown> {
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
    return this.inner.runSkill(id, input, ctx);
  }
}

const echoSkill: Skill = {
  id: "test.echo",
  name: "Echo",
  description: "Returns its input unchanged.",
  inputSchema: { type: "object" },
  run: (input) => input,
};

const boomSkill: Skill = {
  id: "test.boom",
  name: "Boom",
  description: "Always throws.",
  inputSchema: { type: "object" },
  run: () => {
    throw new Error("boom went the step");
  },
};

const fixedBoomSkill: Skill = {
  id: "test.boom",
  name: "Boom (fixed)",
  description: "The repaired version of test.boom.",
  inputSchema: { type: "object" },
  run: () => ({ ok: true }),
};

let pauseHook: (() => Promise<void>) | undefined;
const pauseSkill: Skill = {
  id: "test.pause",
  name: "Pause",
  description: "Invokes a test hook mid-run, then returns.",
  inputSchema: { type: "object" },
  run: async () => {
    await pauseHook?.();
    return { paused: true };
  },
};

function registryWith(...skills: Skill<any, any>[]): SkillRegistry {
  const registry = new SkillRegistry();
  for (const skill of skills) registry.register(skill);
  return registry;
}

describe("Composer end-to-end", () => {
  it("runs a multi-step job, chaining slugify into word-count", async () => {
    const composer = new Composer({
      skills: createDefaultRegistry(),
      store: new InMemoryJobStore(),
    });
    const result = await composer.run({
      title: "slug then count",
      steps: [
        {
          id: "make-slug",
          kind: "skill",
          skillId: "text.slugify",
          input: { title: "Hello Brave New World" },
        },
        {
          id: "count",
          kind: "skill",
          skillId: "text.word-count",
          input: { text: "{{make-slug.slug}}" },
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.steps.map((s) => s.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(result.steps[0].output).toEqual({ slug: "hello-brave-new-world" });
    const count = result.steps[1].output as WordCountResult;
    expect(count.words).toBe(1);
    expect(count.characters).toBe(21);
  });

  it("keeps whole-placeholder values typed and interpolates embedded ones", async () => {
    const composer = new Composer({
      skills: registryWith(slugifySkill, echoSkill),
      store: new InMemoryJobStore(),
    });
    const result = await composer.run({
      steps: [
        {
          id: "s1",
          kind: "skill",
          skillId: "text.slugify",
          input: { title: "Hello Brave New World" },
        },
        {
          id: "s2",
          kind: "skill",
          skillId: "test.echo",
          input: {
            whole: "{{s1}}",
            label: "slug is {{s1.slug}}!",
            deep: { again: "{{s1.slug}}" },
            list: ["{{s1.slug}}", "static"],
          },
        },
      ],
    });

    expect(result.status).toBe("completed");
    const echoed = result.steps[1].output as Record<string, unknown>;
    expect(echoed.whole).toEqual({ slug: "hello-brave-new-world" });
    expect(echoed.label).toBe("slug is hello-brave-new-world!");
    expect(echoed.deep).toEqual({ again: "hello-brave-new-world" });
    expect(echoed.list).toEqual(["hello-brave-new-world", "static"]);
  });

  it("runs a chat step through the Router and feeds its content to a skill step", async () => {
    const router = new Router({
      providers: [
        new MockProvider("mock", { content: "one two three four" }),
      ],
    });
    const composer = new Composer({
      skills: createDefaultRegistry(),
      chat: router,
      store: new InMemoryJobStore(),
    });
    const result = await composer.run({
      steps: [
        {
          id: "draft",
          kind: "chat",
          messages: [{ role: "user", content: "Say four words" }],
        },
        {
          id: "count",
          kind: "skill",
          skillId: "text.word-count",
          input: { text: "{{draft.content}}" },
        },
      ],
    });

    expect(result.status).toBe("completed");
    const draft = result.steps[0].output as { content: string; provider: string };
    expect(draft.content).toBe("one two three four");
    expect(draft.provider).toBe("mock");
    expect((result.steps[1].output as WordCountResult).words).toBe(4);
  });

  it("fails a chat step cleanly when no chat client is configured", async () => {
    const composer = new Composer({
      skills: createDefaultRegistry(),
      store: new InMemoryJobStore(),
    });
    const result = await composer.run({
      steps: [
        {
          id: "draft",
          kind: "chat",
          messages: [{ role: "user", content: "hello" }],
        },
      ],
    });
    expect(result.status).toBe("failed");
    expect(result.steps[0].error).toContain("no chat client");
  });
});

describe("Composer failure and resume", () => {
  it("stops on a failing middle step, keeps earlier outputs, and resume finishes without re-running completed steps", async () => {
    const store = new InMemoryJobStore();
    const counts = new Map<string, number>();

    const broken = new Composer({
      skills: new CountingRunner(
        registryWith(slugifySkill, boomSkill, wordCountSkill),
        counts,
      ),
      store,
    });
    const failed = await broken.run({
      steps: [
        {
          id: "first",
          kind: "skill",
          skillId: "text.slugify",
          input: { title: "Resume Me Please" },
        },
        { id: "middle", kind: "skill", skillId: "test.boom", input: {} },
        {
          id: "last",
          kind: "skill",
          skillId: "text.word-count",
          input: { text: "Count {{first.slug}} now" },
        },
      ],
    });

    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("boom went the step");
    expect(failed.steps[0].status).toBe("completed");
    expect(failed.steps[0].output).toEqual({ slug: "resume-me-please" });
    expect(failed.steps[1].status).toBe("failed");
    expect(failed.steps[1].error).toContain("boom went the step");
    expect(failed.steps[2].status).toBe("pending");
    expect(counts.get("text.slugify")).toBe(1);
    expect(counts.get("test.boom")).toBe(1);

    // "Fix the cause": a second Composer whose registry carries the
    // repaired skill, over the SAME store.
    const fixed = new Composer({
      skills: new CountingRunner(
        registryWith(slugifySkill, fixedBoomSkill, wordCountSkill),
        counts,
      ),
      store,
    });
    const done = await fixed.resume(failed.id);

    expect(done.status).toBe("completed");
    expect(done.error).toBeUndefined();
    expect(done.steps.map((s) => s.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(done.steps[1].output).toEqual({ ok: true });
    expect((done.steps[2].output as WordCountResult).words).toBe(3);
    // The finished first step was NOT re-run; the failed step was retried once.
    expect(counts.get("text.slugify")).toBe(1);
    expect(counts.get("test.boom")).toBe(2);
  });

  it("fails a job cleanly when a step names an unknown skill", async () => {
    const composer = new Composer({
      skills: createDefaultRegistry(),
      store: new InMemoryJobStore(),
    });
    const result = await composer.run({
      steps: [
        {
          id: "ghost",
          kind: "skill",
          skillId: "nope.missing",
          input: {},
        },
        {
          id: "never",
          kind: "skill",
          skillId: "text.slugify",
          input: { title: "never runs" },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.steps[0].status).toBe("failed");
    expect(result.steps[0].error).toContain(
      'Skill "nope.missing" is not registered',
    );
    expect(result.error).toContain("nope.missing");
    expect(result.steps[1].status).toBe("pending");
  });

  it("fails a step cleanly when it references a step that has not completed", async () => {
    const composer = new Composer({
      skills: createDefaultRegistry(),
      store: new InMemoryJobStore(),
    });
    const result = await composer.run({
      steps: [
        {
          id: "count",
          kind: "skill",
          skillId: "text.word-count",
          input: { text: "{{ghost.slug}}" },
        },
      ],
    });
    expect(result.status).toBe("failed");
    expect(result.steps[0].error).toContain("ghost");
    expect(result.steps[0].error).toContain("has not completed");
  });

  it("pauses between steps and resume finishes the job", async () => {
    const store = new InMemoryJobStore();
    const composer = new Composer({
      skills: registryWith(pauseSkill, slugifySkill),
      store,
    });
    const created = await composer.createJob({
      steps: [
        { id: "hold", kind: "skill", skillId: "test.pause", input: {} },
        {
          id: "slug",
          kind: "skill",
          skillId: "text.slugify",
          input: { title: "Paused Then Resumed" },
        },
      ],
    });
    pauseHook = async () => {
      await composer.pause(created.id);
    };
    try {
      const paused = await composer.resume(created.id);
      expect(paused.status).toBe("paused");
      expect(paused.steps[0].status).toBe("completed");
      expect(paused.steps[1].status).toBe("pending");

      const done = await composer.resume(created.id);
      expect(done.status).toBe("completed");
      expect(done.steps[1].output).toEqual({ slug: "paused-then-resumed" });
    } finally {
      pauseHook = undefined;
    }
  });
});

describe("FileJobStore restart survival", () => {
  it("a second Composer over the same directory resumes a failed job after a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skillforge-composer-"));
    try {
      const definition = {
        steps: [
          {
            id: "first",
            kind: "skill" as const,
            skillId: "text.slugify",
            input: { title: "Survives A Restart" },
          },
          { id: "middle", kind: "skill" as const, skillId: "test.boom", input: {} },
          {
            id: "last",
            kind: "skill" as const,
            skillId: "text.word-count",
            input: { text: "{{first.slug}}" },
          },
        ],
      };

      const first = new Composer({
        skills: registryWith(slugifySkill, boomSkill, wordCountSkill),
        store: new FileJobStore(dir),
      });
      const failed = await first.run(definition);
      expect(failed.status).toBe("failed");

      // The checkpoint on disk already holds step 1's output.
      const onDisk = JSON.parse(
        await readFile(join(dir, `${failed.id}.json`), "utf8"),
      ) as JobState;
      expect(onDisk.status).toBe("failed");
      expect(onDisk.steps[0].status).toBe("completed");
      expect(onDisk.steps[0].output).toEqual({ slug: "survives-a-restart" });
      expect(onDisk.steps[1].status).toBe("failed");

      // Simulated restart: new store instance, new Composer, same directory.
      const restarted = new Composer({
        skills: registryWith(slugifySkill, fixedBoomSkill, wordCountSkill),
        store: new FileJobStore(dir),
      });
      const done = await restarted.resume(failed.id);
      expect(done.status).toBe("completed");
      expect(done.steps.map((s) => s.status)).toEqual([
        "completed",
        "completed",
        "completed",
      ]);
      expect((done.steps[2].output as WordCountResult).words).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Job stores", () => {
  it("InMemoryJobStore round-trips and isolates callers from stored state", async () => {
    const store = new InMemoryJobStore();
    const composer = new Composer({
      skills: createDefaultRegistry(),
      store,
    });
    const created = await composer.createJob({
      steps: [
        {
          id: "only",
          kind: "skill",
          skillId: "text.slugify",
          input: { title: "Store Me" },
        },
      ],
    });

    const fetched = await store.get(created.id);
    expect(fetched?.status).toBe("pending");
    fetched!.status = "completed"; // mutate the copy...
    const again = await store.get(created.id);
    expect(again?.status).toBe("pending"); // ...stored state is untouched
    expect(await store.get("missing")).toBeUndefined();
    expect((await store.list()).map((j) => j.id)).toEqual([created.id]);
  });

  it("FileJobStore returns undefined for unknown jobs and lists saved ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skillforge-store-"));
    try {
      const store = new FileJobStore(dir);
      expect(await store.get("nope")).toBeUndefined();
      expect(await store.list()).toEqual([]);

      const composer = new Composer({
        skills: createDefaultRegistry(),
        store,
      });
      const created = await composer.createJob({
        steps: [
          {
            id: "only",
            kind: "skill",
            skillId: "text.slugify",
            input: { title: "On Disk" },
          },
        ],
      });
      expect((await store.get(created.id))?.id).toBe(created.id);
      expect((await store.list()).map((j) => j.id)).toEqual([created.id]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Job definition validation", () => {
  it("rejects empty step lists and duplicate step ids", async () => {
    const composer = new Composer({
      skills: createDefaultRegistry(),
      store: new InMemoryJobStore(),
    });
    await expect(composer.createJob({ steps: [] })).rejects.toBeInstanceOf(
      JobDefinitionError,
    );
    await expect(
      composer.createJob({
        steps: [
          { id: "dup", kind: "skill", skillId: "text.slugify", input: { title: "a" } },
          { id: "dup", kind: "skill", skillId: "text.slugify", input: { title: "b" } },
        ],
      }),
    ).rejects.toBeInstanceOf(JobDefinitionError);
  });

  it("resume of an unknown job throws JobNotFoundError", async () => {
    const composer = new Composer({
      skills: createDefaultRegistry(),
      store: new InMemoryJobStore(),
    });
    await expect(composer.resume("missing-job")).rejects.toBeInstanceOf(
      JobNotFoundError,
    );
  });
});
