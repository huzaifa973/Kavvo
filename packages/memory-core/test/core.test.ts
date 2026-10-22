import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileMemoryStore,
  InMemoryMemoryStore,
  MemoryCore,
  estimateTokens,
  scoreMemoryItem,
  tokenize,
  type MemoryItem,
} from "../src/index.js";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

let seq = 0;
function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  seq++;
  return {
    id: `item-${seq}`,
    kind: "fact",
    text: "placeholder text",
    tags: [],
    importance: 3,
    createdAt: iso(NOW - 10 * DAY),
    updatedAt: iso(NOW - 10 * DAY),
    lastAccessedAt: iso(NOW - 10 * DAY),
    accessCount: 0,
    ...overrides,
  };
}

async function seededCore(items: MemoryItem[]) {
  const store = new InMemoryMemoryStore({ now: () => NOW });
  for (const item of items) await store.save(item);
  return { store, core: new MemoryCore(store, { now: () => NOW }) };
}

describe("scoreMemoryItem", () => {
  it("implements the documented formula: 3*overlap + 2*(importance/5) + recency", () => {
    const item = makeItem({
      text: "Deployment server region is Frankfurt",
      importance: 5,
      updatedAt: iso(NOW - 90 * DAY),
    });
    const { score, overlap } = scoreMemoryItem(
      item,
      tokenize("deployment server region"),
      NOW,
    );
    expect(overlap).toBe(1);
    // recency at 90 days with a 30-day half-life is 2^-3 = 0.125
    expect(score).toBeCloseTo(3 + 2 + 0.125, 10);
  });

  it("counts tag tokens toward overlap", () => {
    const item = makeItem({ text: "His brother", tags: ["family"] });
    const { overlap } = scoreMemoryItem(item, tokenize("family"), NOW);
    expect(overlap).toBe(1);
  });
});

describe("MemoryCore.retrieve", () => {
  it("ranks a high-importance older fact above a low-importance recent one", async () => {
    const old = makeItem({
      id: "old-important",
      text: "Deployment server region is Frankfurt",
      importance: 5,
      updatedAt: iso(NOW - 90 * DAY),
    });
    const recent = makeItem({
      id: "recent-trivial",
      kind: "note",
      text: "Deployment server region checklist drafted",
      importance: 1,
      updatedAt: iso(NOW),
    });
    const { core } = await seededCore([recent, old]);
    const results = await core.retrieve("deployment server region");
    expect(results.map((r) => r.item.id)).toEqual([
      "old-important",
      "recent-trivial",
    ]);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("never returns zero-overlap items, however important or recent", async () => {
    const irrelevant = makeItem({
      id: "soup",
      text: "Grandma soup recipe uses cardamom and patience",
      importance: 5,
      updatedAt: iso(NOW),
    });
    const { core } = await seededCore([irrelevant]);
    expect(await core.retrieve("deployment server region")).toEqual([]);
  });

  it("returns nothing for a query with no significant tokens", async () => {
    const { core } = await seededCore([makeItem({ text: "anything at all" })]);
    expect(await core.retrieve("the a of")).toEqual([]);
    expect(await core.retrieve("")).toEqual([]);
  });

  it("enforces the token budget, skipping an oversized top hit for smaller ones", async () => {
    const huge = makeItem({
      id: "huge",
      text: `alpha ${"x".repeat(200)}`,
      importance: 5,
      updatedAt: iso(NOW),
    });
    const small = makeItem({
      id: "small",
      kind: "note",
      text: "alpha beta",
      importance: 1,
      updatedAt: iso(NOW),
    });
    const { core } = await seededCore([huge, small]);
    const results = await core.retrieve("alpha", { tokenBudget: 20 });
    expect(results.map((r) => r.item.id)).toEqual(["small"]);
    const spent = results.reduce((sum, r) => sum + r.estimatedTokens, 0);
    expect(spent).toBeLessThanOrEqual(20);
  });

  it("admits only what fits when every item costs the same", async () => {
    const items = [5, 4, 3, 2, 1].map((importance, i) =>
      makeItem({
        id: `bulk-${i}`,
        kind: "note",
        text: `alpha ${"y".repeat(74)}`,
        importance,
        updatedAt: iso(NOW),
      }),
    );
    const { core } = await seededCore(items);
    // Each rendered line costs 21 estimated tokens; 45 fits exactly two.
    const results = await core.retrieve("alpha", { tokenBudget: 45 });
    expect(results.length).toBe(2);
    expect(results.reduce((s, r) => s + r.estimatedTokens, 0)).toBe(42);
  });

  it("caps results at maxItems even with a huge budget", async () => {
    const items = [1, 2, 3, 4].map((i) =>
      makeItem({ id: `cap-${i}`, kind: "note", text: `alpha note ${i}` }),
    );
    const { core } = await seededCore(items);
    const results = await core.retrieve("alpha", {
      tokenBudget: 100_000,
      maxItems: 2,
    });
    expect(results.length).toBe(2);
  });

  it("bumps access tracking on returned items, persisted by the file store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-core-"));
    try {
      const store = new FileMemoryStore(dir, { now: () => NOW });
      const item = makeItem({ id: "tracked", text: "alpha tracked fact" });
      await store.save(item);
      const core = new MemoryCore(store, { now: () => NOW });

      const results = await core.retrieve("alpha");
      expect(results[0]?.item.accessCount).toBe(1);
      expect(results[0]?.item.lastAccessedAt).toBe(iso(NOW));

      const fresh = new FileMemoryStore(dir);
      expect((await fresh.get("tracked"))?.accessCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops returning items once they are forgotten", async () => {
    const gone = makeItem({ id: "gone", text: "alpha ephemeral fact" });
    const { store, core } = await seededCore([gone]);
    expect((await core.retrieve("alpha")).length).toBe(1);
    await store.forget("gone");
    expect(await core.retrieve("alpha")).toEqual([]);
  });
});

describe("MemoryCore.buildContext", () => {
  it("groups by kind in fixed order with terse lines, within budget", async () => {
    const fact = makeItem({ id: "f1", text: "Alpha fact here", importance: 1 });
    const pref = makeItem({
      id: "p1",
      kind: "preference",
      text: "Alpha preference here",
      importance: 5,
    });
    const { core } = await seededCore([pref, fact]);
    const context = await core.buildContext("alpha");
    expect(context.text).toBe(
      "## fact\n- Alpha fact here\n## preference\n- Alpha preference here",
    );
    expect(context.estimatedTokens).toBe(estimateTokens(context.text));
    expect(context.estimatedTokens).toBeLessThanOrEqual(800);
    expect(context.items.map((i) => i.item.id).sort()).toEqual(["f1", "p1"]);
  });

  it("never exceeds the budget with many large items", async () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      makeItem({
        id: `big-${i}`,
        kind: "note",
        text: `alpha ${"z".repeat(400)}`,
        importance: 3,
        updatedAt: iso(NOW),
      }),
    );
    const { core } = await seededCore(items);
    const context = await core.buildContext("alpha", { tokenBudget: 120 });
    expect(context.estimatedTokens).toBeLessThanOrEqual(120);
    expect(context.estimatedTokens).toBe(estimateTokens(context.text));
    expect(context.items.length).toBeGreaterThanOrEqual(1);
    expect(context.items.length).toBeLessThan(8);
  });

  it("returns an empty context when nothing can fit or match", async () => {
    const { core } = await seededCore([
      makeItem({ id: "only", text: "alpha something" }),
    ]);
    const tiny = await core.buildContext("alpha", { tokenBudget: 1 });
    expect(tiny).toEqual({ text: "", items: [], estimatedTokens: 0 });
    const noMatch = await core.buildContext("unrelated words here");
    expect(noMatch.text).toBe("");
    expect(noMatch.items).toEqual([]);
  });

  it("tracks access only for the items it actually includes", async () => {
    const included = makeItem({
      id: "included",
      kind: "note",
      text: "alpha one",
      importance: 5,
      updatedAt: iso(NOW),
    });
    const excluded = makeItem({
      id: "excluded",
      kind: "note",
      text: `alpha ${"x".repeat(300)}`,
      importance: 1,
      updatedAt: iso(NOW),
    });
    const { store, core } = await seededCore([included, excluded]);
    const budget = estimateTokens("## note\n- alpha one");
    const context = await core.buildContext("alpha", { tokenBudget: budget });
    expect(context.items.map((i) => i.item.id)).toEqual(["included"]);
    expect((await store.get("included"))?.accessCount).toBe(1);
    expect((await store.get("excluded"))?.accessCount).toBe(0);
  });
});

describe("MemoryCore.compress", () => {
  it("merges a near-duplicate cluster and reports counts", async () => {
    const d1 = makeItem({
      id: "d1",
      text: "User lives in Multan",
      tags: ["home"],
      importance: 2,
      accessCount: 1,
      createdAt: iso(NOW - 3 * DAY),
    });
    const d2 = makeItem({
      id: "d2",
      text: "user lives in multan.",
      tags: ["city"],
      importance: 5,
      accessCount: 2,
      createdAt: iso(NOW - 5 * DAY),
    });
    const d3 = makeItem({
      id: "d3",
      text: "User  lives in Multan",
      tags: ["Home", "pakistan"],
      importance: 3,
      accessCount: 3,
      createdAt: iso(NOW - 4 * DAY),
    });
    const u1 = makeItem({ id: "u1", kind: "note", text: "Buy milk tomorrow" });
    const u2 = makeItem({
      id: "u2",
      kind: "project",
      text: "Skillforge launch plan",
      importance: 4,
    });
    const { store, core } = await seededCore([d1, d2, d3, u1, u2]);

    const report = await core.compress();
    expect(report).toEqual({ merged: 2, before: 5, after: 3 });
    expect((await store.list()).length).toBe(3);

    const survivor = await store.get("d2");
    expect(survivor).toBeDefined();
    expect(survivor?.importance).toBe(5);
    expect(new Set(survivor?.tags)).toEqual(new Set(["city", "Home", "pakistan"]));
    expect(survivor?.accessCount).toBe(6);
    expect(survivor?.createdAt).toBe(iso(NOW - 5 * DAY));
    expect(await store.get("d1")).toBeUndefined();
    expect(await store.get("d3")).toBeUndefined();
  });

  it("is a no-op on a store with no duplicates", async () => {
    const { core } = await seededCore([
      makeItem({ id: "a", text: "alpha fact one" }),
      makeItem({ id: "b", kind: "note", text: "beta note two" }),
    ]);
    expect(await core.compress()).toEqual({ merged: 0, before: 2, after: 2 });
  });

  it("merges duplicates seeded as raw files (legacy data on disk)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-core-"));
    try {
      const legacy = (id: string, text: string, importance: number) =>
        writeFile(
          join(dir, `${id}.json`),
          JSON.stringify(makeItem({ id, text, importance })),
          "utf8",
        );
      await legacy("l1", "User lives in Multan", 2);
      await legacy("l2", "user lives in multan", 4);
      await legacy("l3", "USER LIVES IN MULTAN!", 3);
      await legacy("l4", "Completely different memory", 3);

      const store = new FileMemoryStore(dir);
      const core = new MemoryCore(store, { now: () => NOW });
      expect(await core.compress()).toEqual({ merged: 2, before: 4, after: 2 });

      const fresh = new FileMemoryStore(dir);
      const items = await fresh.list();
      expect(items.length).toBe(2);
      const survivor = items.find((i) => i.text !== "Completely different memory");
      expect(survivor?.importance).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
