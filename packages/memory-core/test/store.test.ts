import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileMemoryStore,
  InMemoryMemoryStore,
  MemoryValidationError,
  type AddMemoryInput,
  type MemoryItem,
} from "../src/index.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const DAY = 86_400_000;

function clockedInMemory() {
  let t = T0;
  return {
    store: new InMemoryMemoryStore({ now: () => t }),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

async function tempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "memory-core-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("InMemoryMemoryStore.add", () => {
  it("fills defaults and stamps times from the clock", async () => {
    const { store } = clockedInMemory();
    const item = await store.add({ kind: "fact", text: "User lives in Multan" });
    expect(item.id).toBeTruthy();
    expect(item.importance).toBe(3);
    expect(item.tags).toEqual([]);
    expect(item.accessCount).toBe(0);
    expect(item.createdAt).toBe(new Date(T0).toISOString());
    expect(item.updatedAt).toBe(item.createdAt);
    expect(item.lastAccessedAt).toBe(item.createdAt);
    expect(item.source).toBeUndefined();
  });

  it("rejects empty text, bad importance and bad kind", async () => {
    const { store } = clockedInMemory();
    await expect(store.add({ kind: "fact", text: "   " })).rejects.toThrow(
      MemoryValidationError,
    );
    await expect(
      store.add({ kind: "fact", text: "x", importance: 0 }),
    ).rejects.toThrow(MemoryValidationError);
    await expect(
      store.add({ kind: "fact", text: "x", importance: 6 }),
    ).rejects.toThrow(MemoryValidationError);
    await expect(
      store.add({ kind: "fact", text: "x", importance: 2.5 }),
    ).rejects.toThrow(MemoryValidationError);
    await expect(
      store.add({ kind: "bogus", text: "x" } as unknown as AddMemoryInput),
    ).rejects.toThrow(MemoryValidationError);
    expect((await store.stats()).total).toBe(0);
  });

  it("near-duplicate add updates the existing item instead of creating one", async () => {
    const { store, advance } = clockedInMemory();
    const first = await store.add({
      kind: "fact",
      text: "User lives in Multan.",
      tags: ["home"],
      importance: 2,
    });
    advance(DAY);
    const second = await store.add({
      kind: "fact",
      text: "  user lives in multan  ",
      tags: ["City"],
      importance: 5,
    });
    expect(second.id).toBe(first.id);
    expect(second.text).toBe("User lives in Multan.");
    expect(second.importance).toBe(5);
    expect(second.tags).toEqual(["home", "City"]);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe(new Date(T0 + DAY).toISOString());
    expect((await store.list()).length).toBe(1);
  });

  it("keeps the higher importance when the duplicate restates it lower", async () => {
    const { store } = clockedInMemory();
    await store.add({ kind: "note", text: "Call the dentist", importance: 5 });
    const again = await store.add({
      kind: "note",
      text: "call the dentist",
      importance: 1,
    });
    expect(again.importance).toBe(5);
  });

  it("treats a word-order variant as a duplicate (token-set match)", async () => {
    const { store } = clockedInMemory();
    const first = await store.add({
      kind: "preference",
      text: "prefers tea in the morning",
    });
    const second = await store.add({
      kind: "preference",
      text: "in the morning prefers tea",
    });
    expect(second.id).toBe(first.id);
    expect((await store.list()).length).toBe(1);
  });

  it("does not merge genuinely different texts or different kinds", async () => {
    const { store } = clockedInMemory();
    await store.add({ kind: "preference", text: "user likes tea" });
    await store.add({ kind: "preference", text: "user likes coffee" });
    await store.add({ kind: "fact", text: "user likes tea" });
    expect((await store.list()).length).toBe(3);
  });
});

describe("InMemoryMemoryStore queries", () => {
  it("gets, lists with kind and tag filters, and forgets", async () => {
    const { store } = clockedInMemory();
    const a = await store.add({
      kind: "fact",
      text: "User lives in Multan",
      tags: ["Home"],
    });
    const b = await store.add({
      kind: "preference",
      text: "Prefers tea",
      tags: ["drinks"],
    });
    await store.add({ kind: "fact", text: "User works remotely", tags: ["work"] });

    expect((await store.get(a.id))?.text).toBe("User lives in Multan");
    expect(await store.get("nope")).toBeUndefined();
    expect((await store.list({ kind: "fact" })).length).toBe(2);
    expect((await store.list({ tag: "home" })).map((i) => i.id)).toEqual([a.id]);
    expect((await store.list({ tag: "HOME" })).map((i) => i.id)).toEqual([a.id]);

    expect(await store.forget(b.id)).toBe(true);
    expect(await store.get(b.id)).toBeUndefined();
    expect(await store.forget(b.id)).toBe(false);
    expect((await store.list()).length).toBe(2);
  });

  it("stats counts by kind, with zeros for empty kinds", async () => {
    const { store } = clockedInMemory();
    await store.add({ kind: "fact", text: "one" });
    await store.add({ kind: "fact", text: "two" });
    await store.add({ kind: "person", text: "three" });
    const stats = await store.stats();
    expect(stats.total).toBe(3);
    expect(stats.byKind).toEqual({
      fact: 2,
      preference: 0,
      person: 1,
      project: 0,
      note: 0,
    });
  });

  it("returns copies: caller mutation does not leak into the store", async () => {
    const { store } = clockedInMemory();
    const item = await store.add({ kind: "fact", text: "original", tags: ["x"] });
    item.text = "mutated";
    item.tags.push("y");
    const stored = await store.get(item.id);
    expect(stored?.text).toBe("original");
    expect(stored?.tags).toEqual(["x"]);
  });

  it("recordAccess returns undefined for an unknown id", async () => {
    const { store } = clockedInMemory();
    expect(await store.recordAccess("nope")).toBeUndefined();
  });
});

describe("save (raw upsert)", () => {
  const raw: MemoryItem = {
    id: "hand-1",
    kind: "project",
    text: "Skillforge launch plan",
    tags: ["work"],
    importance: 4,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    lastAccessedAt: new Date(T0).toISOString(),
    accessCount: 7,
  };

  it("stores a whole item verbatim and validates it", async () => {
    const { store } = clockedInMemory();
    await store.save(raw);
    expect(await store.get("hand-1")).toEqual(raw);
    await expect(
      store.save({ ...raw, id: "hand-2", importance: 9 }),
    ).rejects.toThrow(MemoryValidationError);
  });
});

describe("FileMemoryStore", () => {
  it("survives restart: a second instance reads what the first wrote", async () => {
    await tempDir(async (dir) => {
      const first = new FileMemoryStore(dir, { now: () => T0 });
      const a = await first.add({
        kind: "fact",
        text: "User lives in Multan",
        tags: ["home"],
        source: "user",
      });
      await first.add({ kind: "note", text: "Buy milk" });

      const second = new FileMemoryStore(dir);
      const items = await second.list();
      expect(items.length).toBe(2);
      expect(await second.get(a.id)).toEqual(a);
      expect((await second.stats()).byKind.note).toBe(1);
    });
  });

  it("dedupes and forgets across instances", async () => {
    await tempDir(async (dir) => {
      const a = new FileMemoryStore(dir, { now: () => T0 });
      const item = await a.add({ kind: "fact", text: "User lives in Multan." });

      const b = new FileMemoryStore(dir, { now: () => T0 + DAY });
      const again = await b.add({ kind: "fact", text: "user lives in multan" });
      expect(again.id).toBe(item.id);
      expect((await b.list()).length).toBe(1);
      expect(await b.forget(item.id)).toBe(true);

      const c = new FileMemoryStore(dir);
      expect(await c.list()).toEqual([]);
      expect(await c.forget(item.id)).toBe(false);
    });
  });

  it("persists access tracking across instances", async () => {
    await tempDir(async (dir) => {
      const a = new FileMemoryStore(dir, { now: () => T0 });
      const item = await a.add({ kind: "fact", text: "User lives in Multan" });

      const b = new FileMemoryStore(dir, { now: () => T0 + DAY });
      const bumped = await b.recordAccess(item.id);
      expect(bumped?.accessCount).toBe(1);
      expect(bumped?.lastAccessedAt).toBe(new Date(T0 + DAY).toISOString());

      const c = new FileMemoryStore(dir);
      expect((await c.get(item.id))?.accessCount).toBe(1);
    });
  });

  it("reads a missing directory as empty", async () => {
    await tempDir(async (dir) => {
      const store = new FileMemoryStore(join(dir, "not-created-yet"));
      expect(await store.list()).toEqual([]);
      expect((await store.stats()).total).toBe(0);
    });
  });
});
