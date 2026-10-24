import { describe, expect, it } from "vitest";
import {
  DuplicateSkillError,
  SkillInputError,
  SkillNotFoundError,
  SkillRegistry,
  createDefaultRegistry,
  runSkill,
  slugifySkill,
  wordCountSkill,
  type WordCountResult,
  type SlugifyResult,
} from "../src/index.js";

describe("SkillRegistry", () => {
  it("registers, gets and lists skills", () => {
    const registry = new SkillRegistry();
    registry.register(wordCountSkill);
    expect(registry.get("text.word-count")).toBe(wordCountSkill);
    expect(registry.has("text.slugify")).toBe(false);
    expect(registry.list()).toEqual([wordCountSkill]);
  });

  it("rejects a duplicate skill id", () => {
    const registry = new SkillRegistry();
    registry.register(wordCountSkill);
    expect(() => registry.register(wordCountSkill)).toThrow(DuplicateSkillError);
  });

  it("runSkill throws SkillNotFoundError for an unknown skill", async () => {
    const registry = new SkillRegistry();
    await expect(registry.runSkill("nope.missing", {})).rejects.toBeInstanceOf(
      SkillNotFoundError,
    );
  });

  it("runSkill rejects input missing a required field", async () => {
    const registry = createDefaultRegistry();
    await expect(registry.runSkill("text.word-count", {})).rejects.toBeInstanceOf(
      SkillInputError,
    );
  });
});

describe("text.word-count", () => {
  it("counts words, characters, sentences and paragraphs", async () => {
    const result = (await runSkill("text.word-count", {
      text: "Hello world. This is Kavvo!\n\nIt counts things well?",
    })) as WordCountResult;
    expect(result.words).toBe(9);
    expect(result.sentences).toBe(3);
    expect(result.paragraphs).toBe(2);
    expect(result.characters).toBe(51);
    expect(result.charactersNoSpaces).toBe(42);
  });

  it("estimates reading time at 200 wpm", async () => {
    const text = Array.from({ length: 400 }, () => "word").join(" ");
    const result = (await runSkill("text.word-count", { text })) as WordCountResult;
    expect(result.words).toBe(400);
    expect(result.readingTimeMinutes).toBe(2);
    expect(result.readingTimeSeconds).toBe(120);
  });

  it("handles empty text", async () => {
    const result = (await runSkill("text.word-count", { text: "" })) as WordCountResult;
    expect(result.words).toBe(0);
    expect(result.sentences).toBe(0);
    expect(result.readingTimeMinutes).toBe(0);
  });
});

describe("text.slugify", () => {
  it("turns a title into a URL slug", async () => {
    const result = (await runSkill("text.slugify", {
      title: "Hello, World! This is Kavvo",
    })) as SlugifyResult;
    expect(result.slug).toBe("hello-world-this-is-kavvo");
  });

  it("strips accents and collapses separators", async () => {
    const result = (await runSkill("text.slugify", {
      title: "  Café — déjà vu... 100%  ",
    })) as SlugifyResult;
    expect(result.slug).toBe("cafe-deja-vu-100");
  });

  it("returns an empty slug for punctuation-only input", async () => {
    const result = await slugifySkill.run({ title: "!!!" }, {});
    expect(result.slug).toBe("");
  });
});
