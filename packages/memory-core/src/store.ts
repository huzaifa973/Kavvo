import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { areNearDuplicates } from "./text.js";
import {
  MEMORY_KINDS,
  MemoryValidationError,
  type AddMemoryInput,
  type MemoryItem,
  type MemoryKind,
  type MemoryListFilter,
  type MemoryStats,
} from "./types.js";

export interface MemoryStoreOptions {
  /** Injectable clock for tests (ms epoch). Defaults to Date.now. */
  now?: () => number;
}

/**
 * Persistence for memories.
 *
 * `add` is the smart front door: it dedupes (see below) so the same
 * memory stated twice stays one memory. `save` is the raw upsert used
 * by compression and by callers that manage whole items themselves.
 * Implementations return copies, never live references, so callers
 * cannot mutate stored state behind the store's back.
 */
export interface MemoryStore {
  /**
   * Adds a memory. If an item with the same kind and near-identical
   * normalized text already exists (see areNearDuplicates in text.ts),
   * that item is updated instead: updatedAt is refreshed, the higher
   * importance wins, tags are merged, and the EXISTING item (same id)
   * is returned. Provenance: the existing source is kept unless it has
   * none and the input provides one.
   */
  add(input: AddMemoryInput): Promise<MemoryItem>;
  /** Raw upsert of a whole item, no dedupe. The item is validated. */
  save(item: MemoryItem): Promise<void>;
  get(id: string): Promise<MemoryItem | undefined>;
  list(filter?: MemoryListFilter): Promise<MemoryItem[]>;
  /** Removes the item. Returns whether anything was removed. */
  forget(id: string): Promise<boolean>;
  /**
   * Records that retrieval surfaced this item: accessCount + 1 and
   * lastAccessedAt set to now, persisted. Returns the updated item.
   */
  recordAccess(id: string): Promise<MemoryItem | undefined>;
  stats(): Promise<MemoryStats>;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function normalizeTags(tags: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags ?? []) {
    const tag = raw.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

function unionTags(a: readonly string[], b: readonly string[]): string[] {
  return normalizeTags([...a, ...b]);
}

function validateKind(kind: unknown): MemoryKind {
  if (typeof kind !== "string" || !(MEMORY_KINDS as readonly string[]).includes(kind)) {
    throw new MemoryValidationError(`kind must be one of ${MEMORY_KINDS.join(", ")}`);
  }
  return kind as MemoryKind;
}

function validateText(text: unknown): string {
  if (typeof text !== "string" || text.trim() === "") {
    throw new MemoryValidationError("text must be a non-empty string");
  }
  return text.trim();
}

function validateImportance(importance: unknown): number {
  if (
    typeof importance !== "number" ||
    !Number.isInteger(importance) ||
    importance < 1 ||
    importance > 5
  ) {
    throw new MemoryValidationError("importance must be an integer in 1..5");
  }
  return importance;
}

function validateItem(item: MemoryItem): MemoryItem {
  if (!item || typeof item.id !== "string" || item.id === "") {
    throw new MemoryValidationError("item id must be a non-empty string");
  }
  validateKind(item.kind);
  validateText(item.text);
  validateImportance(item.importance);
  if (!Array.isArray(item.tags) || item.tags.some((t) => typeof t !== "string")) {
    throw new MemoryValidationError("tags must be an array of strings");
  }
  if (!Number.isInteger(item.accessCount) || item.accessCount < 0) {
    throw new MemoryValidationError("accessCount must be a non-negative integer");
  }
  for (const field of ["createdAt", "updatedAt", "lastAccessedAt"] as const) {
    if (typeof item[field] !== "string" || Number.isNaN(Date.parse(item[field]))) {
      throw new MemoryValidationError(`${field} must be an ISO date string`);
    }
  }
  return item;
}

/** Builds a fresh item from an add-input, stamped with the given time. */
function newItem(input: AddMemoryInput, nowMs: number): MemoryItem {
  const stamp = iso(nowMs);
  const item: MemoryItem = {
    id: randomUUID(),
    kind: validateKind(input.kind),
    text: validateText(input.text),
    tags: normalizeTags(input.tags),
    importance:
      input.importance === undefined ? 3 : validateImportance(input.importance),
    createdAt: stamp,
    updatedAt: stamp,
    lastAccessedAt: stamp,
    accessCount: 0,
  };
  if (input.source !== undefined) item.source = input.source;
  return item;
}

/** The update half of add()'s dedupe rule, as a pure function. */
function mergeDuplicate(
  existing: MemoryItem,
  input: AddMemoryInput,
  nowMs: number,
): MemoryItem {
  const merged: MemoryItem = {
    ...existing,
    tags: unionTags(existing.tags, normalizeTags(input.tags)),
    importance:
      input.importance === undefined
        ? existing.importance
        : Math.max(existing.importance, validateImportance(input.importance)),
    updatedAt: iso(nowMs),
  };
  if (merged.source === undefined && input.source !== undefined) {
    merged.source = input.source;
  }
  return merged;
}

/** First item of the same kind whose text is a near-duplicate, if any. */
function findDuplicate(
  items: readonly MemoryItem[],
  kind: MemoryKind,
  text: string,
): MemoryItem | undefined {
  return items.find(
    (item) => item.kind === kind && areNearDuplicates(item.text, text),
  );
}

function applyFilter(
  items: readonly MemoryItem[],
  filter?: MemoryListFilter,
): MemoryItem[] {
  let out = [...items];
  if (filter?.kind !== undefined) {
    out = out.filter((item) => item.kind === filter.kind);
  }
  if (filter?.tag !== undefined) {
    const wanted = filter.tag.toLowerCase();
    out = out.filter((item) =>
      item.tags.some((tag) => tag.toLowerCase() === wanted),
    );
  }
  return out;
}

function computeStats(items: readonly MemoryItem[]): MemoryStats {
  const byKind = Object.fromEntries(
    MEMORY_KINDS.map((kind) => [kind, 0]),
  ) as Record<MemoryKind, number>;
  for (const item of items) byKind[item.kind]++;
  return { total: items.length, byKind };
}

/** In-process store. State survives MemoryCore instances, not restarts. */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly items = new Map<string, MemoryItem>();
  private readonly now: () => number;

  constructor(options: MemoryStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async add(input: AddMemoryInput): Promise<MemoryItem> {
    const kind = validateKind(input.kind);
    const text = validateText(input.text);
    const dup = findDuplicate([...this.items.values()], kind, text);
    if (dup) {
      const merged = mergeDuplicate(dup, input, this.now());
      this.items.set(merged.id, structuredClone(merged));
      return structuredClone(merged);
    }
    const item = newItem(input, this.now());
    this.items.set(item.id, structuredClone(item));
    return structuredClone(item);
  }

  async save(item: MemoryItem): Promise<void> {
    validateItem(item);
    this.items.set(item.id, structuredClone(item));
  }

  async get(id: string): Promise<MemoryItem | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async list(filter?: MemoryListFilter): Promise<MemoryItem[]> {
    return applyFilter([...this.items.values()], filter).map((item) =>
      structuredClone(item),
    );
  }

  async forget(id: string): Promise<boolean> {
    return this.items.delete(id);
  }

  async recordAccess(id: string): Promise<MemoryItem | undefined> {
    const item = this.items.get(id);
    if (!item) return undefined;
    const updated: MemoryItem = {
      ...item,
      accessCount: item.accessCount + 1,
      lastAccessedAt: iso(this.now()),
    };
    this.items.set(id, structuredClone(updated));
    return structuredClone(updated);
  }

  async stats(): Promise<MemoryStats> {
    return computeStats([...this.items.values()]);
  }
}

/**
 * One JSON file per memory under a caller-provided directory
 * (`<dir>/<id>.json`), the same shape as the Composer's FileJobStore.
 * The disk is the source of truth (no cache), so a new store instance
 * over the same directory sees everything a previous one wrote —
 * memories survive full process restarts. Writes go to a temp file
 * renamed into place, so a crash mid-write never leaves a torn memory.
 * Ids must be filename-safe (ids from `add` are UUIDs).
 */
export class FileMemoryStore implements MemoryStore {
  private readonly now: () => number;

  constructor(
    private readonly dir: string,
    options: MemoryStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  private fileFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async writeOne(item: MemoryItem): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(
      this.dir,
      `.${item.id}.json.tmp-${Math.random().toString(36).slice(2)}`,
    );
    await writeFile(tmp, JSON.stringify(item, null, 2), "utf8");
    await rename(tmp, this.fileFor(item.id));
  }

  private async readOne(id: string): Promise<MemoryItem | undefined> {
    try {
      const raw = await readFile(this.fileFor(id), "utf8");
      return JSON.parse(raw) as MemoryItem;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  private async readAll(): Promise<MemoryItem[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const items: MemoryItem[] = [];
    for (const file of files) {
      if (!file.endsWith(".json") || file.startsWith(".")) continue;
      const item = await this.readOne(file.slice(0, -".json".length));
      if (item) items.push(item);
    }
    return items;
  }

  async add(input: AddMemoryInput): Promise<MemoryItem> {
    const kind = validateKind(input.kind);
    const text = validateText(input.text);
    const dup = findDuplicate(await this.readAll(), kind, text);
    if (dup) {
      const merged = mergeDuplicate(dup, input, this.now());
      await this.writeOne(merged);
      return structuredClone(merged);
    }
    const item = newItem(input, this.now());
    await this.writeOne(item);
    return structuredClone(item);
  }

  async save(item: MemoryItem): Promise<void> {
    validateItem(item);
    await this.writeOne(structuredClone(item));
  }

  async get(id: string): Promise<MemoryItem | undefined> {
    return this.readOne(id);
  }

  async list(filter?: MemoryListFilter): Promise<MemoryItem[]> {
    return applyFilter(await this.readAll(), filter);
  }

  async forget(id: string): Promise<boolean> {
    if ((await this.readOne(id)) === undefined) return false;
    await unlink(this.fileFor(id));
    return true;
  }

  async recordAccess(id: string): Promise<MemoryItem | undefined> {
    const item = await this.readOne(id);
    if (!item) return undefined;
    const updated: MemoryItem = {
      ...item,
      accessCount: item.accessCount + 1,
      lastAccessedAt: iso(this.now()),
    };
    await this.writeOne(updated);
    return structuredClone(updated);
  }

  async stats(): Promise<MemoryStats> {
    return computeStats(await this.readAll());
  }
}
