import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ForgedSkillRecord } from "./types.js";
import { assertValidRecord } from "./validate.js";

/**
 * Persistence for forged-skill provenance records. A record carries
 * the full spec, so whatever the store holds is everything needed to
 * rebuild the skill at boot.
 *
 * Implementations must return copies, never live references, so callers
 * cannot mutate stored state behind the store's back.
 */
export interface ForgeStore {
  save(record: ForgedSkillRecord): Promise<void>;
  get(skillId: string): Promise<ForgedSkillRecord | undefined>;
  remove(skillId: string): Promise<boolean>;
  list(): Promise<ForgedSkillRecord[]>;
}

/** In-process store. Records survive forge calls, not restarts. */
export class InMemoryForgeStore implements ForgeStore {
  private readonly records = new Map<string, ForgedSkillRecord>();

  async save(record: ForgedSkillRecord): Promise<void> {
    assertValidRecord(record);
    this.records.set(record.id, structuredClone(record));
  }

  async get(skillId: string): Promise<ForgedSkillRecord | undefined> {
    const record = this.records.get(skillId);
    return record ? structuredClone(record) : undefined;
  }

  async remove(skillId: string): Promise<boolean> {
    return this.records.delete(skillId);
  }

  async list(): Promise<ForgedSkillRecord[]> {
    return [...this.records.values()].map((r) => structuredClone(r));
  }
}

/**
 * One JSON file per forged skill under a caller-provided directory
 * (`<dir>/<skillId>.json`). Writes go to a temp file renamed into
 * place, so a crash mid-write never leaves a torn record. Records
 * survive full process restarts.
 *
 * `list()` is deliberately tolerant: a file that does not parse as
 * JSON is skipped, never thrown on — the forge directory may hold
 * records from older formats or a hand-edited file, and boot must
 * survive them. Records that DO parse but no longer validate are
 * returned as-is; `loadForged` is where they are skipped with a
 * recorded reason.
 */
export class FileForgeStore implements ForgeStore {
  constructor(private readonly dir: string) {}

  private fileFor(skillId: string): string {
    return join(this.dir, `${skillId}.json`);
  }

  async save(record: ForgedSkillRecord): Promise<void> {
    assertValidRecord(record);
    await mkdir(this.dir, { recursive: true });
    const tmp = join(
      this.dir,
      `.${record.id}.json.tmp-${Math.random().toString(36).slice(2)}`,
    );
    await writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
    await rename(tmp, this.fileFor(record.id));
  }

  async get(skillId: string): Promise<ForgedSkillRecord | undefined> {
    try {
      const raw = await readFile(this.fileFor(skillId), "utf8");
      return JSON.parse(raw) as ForgedSkillRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async remove(skillId: string): Promise<boolean> {
    try {
      await unlink(this.fileFor(skillId));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async list(): Promise<ForgedSkillRecord[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const records: ForgedSkillRecord[] = [];
    for (const file of files) {
      if (!file.endsWith(".json") || file.startsWith(".")) continue;
      try {
        const record = await this.get(file.slice(0, -".json".length));
        if (record) records.push(record);
      } catch {
        // Unparseable file: skipped by design (see the class comment).
        continue;
      }
    }
    return records;
  }
}
