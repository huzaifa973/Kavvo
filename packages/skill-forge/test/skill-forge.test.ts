import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SkillNotFoundError,
  SkillRegistry,
  createDefaultRegistry,
} from "@skillforge/skill-engine";
import {
  FileForgeStore,
  ForgeError,
  InMemoryForgeStore,
  forgeSkill,
  loadForged,
  specHash,
  unforge,
  type ForgeStore,
  type SkillSpec,
} from "../src/index.js";

function shoutSpec(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: "text.shout",
    name: "Shout",
    description: "Uppercases the input text and adds a trailing exclamation mark.",
    input: { required: ["text"], properties: { text: "string" } },
    source: [
      'const text = typeof input.text === "string" ? input.text : "";',
      'return { text: text.toUpperCase() + "!" };',
    ].join("\n"),
    ...overrides,
  };
}

const SHOUT_SAMPLES = [
  { input: { text: "hello" }, expect: { text: "HELLO!" } },
  { input: { text: "bye" } },
];

describe("forgeSkill — happy path", () => {
  it("forges a working skill from a hand-written spec and runs it through the registry", async () => {
    const registry = new SkillRegistry();
    const store = new InMemoryForgeStore();
    const now = () => new Date("2026-10-22T12:00:00.000Z");

    const { skill, record } = await forgeSkill(shoutSpec(), registry, {
      store,
      samples: SHOUT_SAMPLES,
      now,
    });

    expect(skill.id).toBe("text.shout");
    expect(registry.has("text.shout")).toBe(true);
    await expect(registry.runSkill("text.shout", { text: "hey" })).resolves.toEqual({
      text: "HEY!",
    });
    // The built inputSchema carries the spec's contract, so the
    // registry's own required-field validation applies to forged skills.
    await expect(registry.runSkill("text.shout", {})).rejects.toThrow(
      'missing required field "text"',
    );

    // Provenance: recorded with the full spec, its hash, and the forge time.
    expect(record.id).toBe("text.shout");
    expect(record.forgedAt).toBe("2026-10-22T12:00:00.000Z");
    expect(record.specHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.specHash).toBe(specHash(shoutSpec()));
    const stored = await store.get("text.shout");
    expect(stored?.spec.source).toContain("toUpperCase");
    expect((await store.list()).map((r) => r.id)).toEqual(["text.shout"]);
  });

  it("specHash is stable across field order and changes with content", () => {
    const a = shoutSpec();
    const reordered = {
      source: a.source,
      input: a.input,
      description: a.description,
      name: a.name,
      id: a.id,
    } as SkillSpec;
    expect(specHash(reordered)).toBe(specHash(a));
    expect(specHash(shoutSpec({ source: "return { text: 'x' };" }))).not.toBe(
      specHash(a),
    );
  });
});

describe("forgeSkill — validation failures leave everything untouched", () => {
  it("rejects malformed specs at the validate stage", async () => {
    const registry = new SkillRegistry();
    const store = new InMemoryForgeStore();
    const badSpecs: SkillSpec[] = [
      shoutSpec({ id: "Text.Shout" }), // uppercase
      shoutSpec({ id: "shout" }), // no namespace dot
      shoutSpec({ id: "text..shout" }), // empty segment
      shoutSpec({ name: "  " }),
      shoutSpec({ source: "   " }), // empty source
      shoutSpec({
        input: { required: ["missing"], properties: { text: "string" } },
      }),
      shoutSpec({
        input: {
          required: ["text"],
          properties: { text: "date" as SkillSpec["input"]["properties"][string] },
        },
      }),
      shoutSpec({
        input: { required: ["text", "text"], properties: { text: "string" } },
      }),
    ];
    for (const spec of badSpecs) {
      const err = await forgeSkill(spec, registry, { store }).catch((e) => e);
      expect(err).toBeInstanceOf(ForgeError);
      expect((err as ForgeError).stage).toBe("validate");
    }
    expect(registry.list()).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it("rejects a duplicate id — forged or built-in — at the validate stage", async () => {
    const registry = createDefaultRegistry();
    const store = new InMemoryForgeStore();
    await forgeSkill(shoutSpec(), registry, { store, samples: SHOUT_SAMPLES });

    const again = await forgeSkill(shoutSpec(), registry, { store }).catch(
      (e) => e,
    );
    expect(again).toBeInstanceOf(ForgeError);
    expect((again as ForgeError).stage).toBe("validate");

    const overBuiltin = await forgeSkill(
      shoutSpec({ id: "text.slugify" }),
      registry,
      { store },
    ).catch((e) => e);
    expect(overBuiltin).toBeInstanceOf(ForgeError);
    expect((overBuiltin as ForgeError).stage).toBe("validate");
    // Only the one successful forge was recorded.
    expect((await store.list()).map((r) => r.id)).toEqual(["text.shout"]);
  });
});

describe("forgeSkill — compile and smoke failures roll back", () => {
  it("rejects a syntax-error source with the compiler's message, registry and store untouched", async () => {
    const registry = new SkillRegistry();
    const store = new InMemoryForgeStore();
    const spec = shoutSpec({ source: "const broken = ;\nreturn {};" });
    const err = await forgeSkill(spec, registry, { store }).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect((err as ForgeError).stage).toBe("compile");
    expect((err as ForgeError).message).toContain("TypeScript rejected the source");
    expect(registry.has("text.shout")).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("rejects imports in the source at the compile stage", async () => {
    const registry = new SkillRegistry();
    const store = new InMemoryForgeStore();
    const spec = shoutSpec({
      source: 'import { readFile } from "node:fs";\nreturn { text: "x" };',
    });
    const err = await forgeSkill(spec, registry, { store }).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect((err as ForgeError).stage).toBe("compile");
    expect(registry.has("text.shout")).toBe(false);
  });

  it("rejects a failing smoke case (wrong result) at the smoke stage", async () => {
    const registry = new SkillRegistry();
    const store = new InMemoryForgeStore();
    const err = await forgeSkill(shoutSpec(), registry, {
      store,
      samples: [{ input: { text: "hello" }, expect: { text: "WRONG!" } }],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect((err as ForgeError).stage).toBe("smoke");
    expect(registry.has("text.shout")).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("rejects a smoke case whose run throws, with the thrown message", async () => {
    const registry = new SkillRegistry();
    const store = new InMemoryForgeStore();
    const spec = shoutSpec({
      source: 'throw new Error("boom inside the skill");',
    });
    const err = await forgeSkill(spec, registry, {
      store,
      samples: [{ input: { text: "hello" } }],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect((err as ForgeError).stage).toBe("smoke");
    expect((err as ForgeError).message).toContain("boom inside the skill");
    expect(registry.has("text.shout")).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("rolls back the registration when the record save fails", async () => {
    const registry = new SkillRegistry();
    const failingStore: ForgeStore = {
      async save() {
        throw new Error("disk is full");
      },
      async get() {
        return undefined;
      },
      async remove() {
        return false;
      },
      async list() {
        return [];
      },
    };
    const err = await forgeSkill(shoutSpec(), registry, {
      store: failingStore,
      samples: SHOUT_SAMPLES,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect((err as ForgeError).stage).toBe("register");
    expect((err as ForgeError).message).toContain("disk is full");
    expect(registry.has("text.shout")).toBe(false);
  });
});

describe("unforge", () => {
  it("removes the skill from the registry and drops its record", async () => {
    const registry = new SkillRegistry();
    const store = new InMemoryForgeStore();
    await forgeSkill(shoutSpec(), registry, { store, samples: SHOUT_SAMPLES });

    await expect(unforge(registry, store, "text.shout")).resolves.toBe(true);
    expect(registry.has("text.shout")).toBe(false);
    await expect(registry.runSkill("text.shout", { text: "x" })).rejects.toThrow(
      SkillNotFoundError,
    );
    expect(await store.get("text.shout")).toBeUndefined();
    // A second unforge is an honest false, and the id can be forged again.
    await expect(unforge(registry, store, "text.shout")).resolves.toBe(false);
    await forgeSkill(shoutSpec(), registry, { store, samples: SHOUT_SAMPLES });
    expect(registry.has("text.shout")).toBe(true);
  });

  it("never removes a built-in it did not forge", async () => {
    const registry = createDefaultRegistry();
    const store = new InMemoryForgeStore();
    await expect(unforge(registry, store, "text.slugify")).resolves.toBe(false);
    expect(registry.has("text.slugify")).toBe(true);
  });
});

describe("persistence across restarts", () => {
  it("file store: a fresh registry re-registers the forged skill at boot and it still runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-forge-"));
    try {
      const firstRegistry = new SkillRegistry();
      await forgeSkill(shoutSpec(), firstRegistry, {
        store: new FileForgeStore(dir),
        samples: SHOUT_SAMPLES,
      });

      // Simulated restart: a brand-new registry and store over the same dir.
      const secondRegistry = new SkillRegistry();
      const report = await loadForged(
        secondRegistry,
        new FileForgeStore(dir),
      );
      expect(report).toEqual({ loaded: ["text.shout"], skipped: [] });
      await expect(
        secondRegistry.runSkill("text.shout", { text: "again" }),
      ).resolves.toEqual({ text: "AGAIN!" });

      // Loading again into the same registry skips it as already registered.
      const second = await loadForged(secondRegistry, new FileForgeStore(dir));
      expect(second.loaded).toEqual([]);
      expect(second.skipped).toHaveLength(1);
      expect(second.skipped[0].id).toBe("text.shout");
      expect(second.skipped[0].reason).toContain("already registered");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips corrupted stored records with a recorded reason and never crashes the boot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-forge-corrupt-"));
    try {
      const store = new FileForgeStore(dir);
      const registry = new SkillRegistry();
      await forgeSkill(shoutSpec(), registry, { store, samples: SHOUT_SAMPLES });

      // Corrupt flavor 1: valid JSON, but the spec's source was wiped —
      // it no longer validates.
      await writeFile(
        join(dir, "text.broken.json"),
        JSON.stringify({
          id: "text.broken",
          spec: { ...shoutSpec({ id: "text.broken" }), source: "" },
          specHash: "deadbeef",
          forgedAt: "2026-10-22T12:00:00.000Z",
        }),
        "utf8",
      );
      // Corrupt flavor 2: the spec validates, but its source no longer
      // compiles (a hand-edited record from an older format).
      await writeFile(
        join(dir, "text.uncompilable.json"),
        JSON.stringify({
          id: "text.uncompilable",
          spec: shoutSpec({
            id: "text.uncompilable",
            source: "return { text: ;",
          }),
          specHash: "deadbeef",
          forgedAt: "2026-10-22T12:00:00.000Z",
        }),
        "utf8",
      );
      // Corrupt flavor 3: not JSON at all — the file store skips it in
      // list(), so it cannot reach loadForged, let alone crash it.
      await writeFile(join(dir, "garbage.json"), "this is not json {{{", "utf8");

      const fresh = new SkillRegistry();
      const report = await loadForged(fresh, new FileForgeStore(dir));
      expect(report.loaded).toEqual(["text.shout"]);
      const skippedById = new Map(report.skipped.map((s) => [s.id, s.reason]));
      expect(skippedById.get("text.broken")).toContain("source");
      expect(skippedById.get("text.uncompilable")).toContain(
        "TypeScript rejected",
      );
      expect(fresh.has("text.broken")).toBe(false);
      expect(fresh.has("text.uncompilable")).toBe(false);
      await expect(
        fresh.runSkill("text.shout", { text: "still here" }),
      ).resolves.toEqual({ text: "STILL HERE!" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("stores", () => {
  it("in-memory store round-trips records with caller-mutation isolation", async () => {
    const store = new InMemoryForgeStore();
    const registry = new SkillRegistry();
    const { record } = await forgeSkill(shoutSpec(), registry, {
      store,
      samples: SHOUT_SAMPLES,
    });
    record.spec.source = "mutated by the caller";
    const fetched = await store.get("text.shout");
    expect(fetched?.spec.source).toContain("toUpperCase");
    fetched!.spec.source = "mutated again";
    expect((await store.get("text.shout"))?.spec.source).toContain("toUpperCase");
    await expect(store.remove("text.shout")).resolves.toBe(true);
    await expect(store.remove("text.shout")).resolves.toBe(false);
  });

  it("file store reads a missing directory as empty", async () => {
    const store = new FileForgeStore(
      join(tmpdir(), "skill-forge-definitely-missing-dir"),
    );
    expect(await store.list()).toEqual([]);
    expect(await store.get("text.shout")).toBeUndefined();
  });
});
