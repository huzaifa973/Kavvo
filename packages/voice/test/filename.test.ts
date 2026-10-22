import { describe, expect, it } from "vitest";

import { buildWavFilename, filenameTimestamp, slugifyForFilename } from "../src/index.js";

describe("slugifyForFilename", () => {
  it("slugifies words and punctuation", () => {
    expect(slugifyForFilename("Hello, World!")).toBe("hello-world");
  });

  it("strips diacritics", () => {
    expect(slugifyForFilename("Héllo wörld")).toBe("hello-world");
  });

  it("collapses runs of separators and trims edge dashes", () => {
    expect(slugifyForFilename("  --a   b__c-- ")).toBe("a-b-c");
  });

  it("returns empty for text with no slug-able characters", () => {
    expect(slugifyForFilename("!!! ???")).toBe("");
  });

  it("caps long slugs at a word boundary", () => {
    const slug = slugifyForFilename("word ".repeat(30).trim());
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.split("-").every((part) => part === "word")).toBe(true);
  });
});

describe("filenameTimestamp", () => {
  it("formats UTC compactly", () => {
    expect(filenameTimestamp(new Date("2026-10-22T08:15:30.000Z"))).toBe("20261022T081530");
  });

  it("zero-pads every field", () => {
    expect(filenameTimestamp(new Date("2026-01-02T03:04:05.000Z"))).toBe("20260102T030405");
  });
});

describe("buildWavFilename", () => {
  const now = new Date("2026-10-22T08:15:30.000Z");

  it("combines slug and timestamp", () => {
    expect(buildWavFilename("Skillforge turns work into skills", now)).toBe(
      "tts-skillforge-turns-work-into-skills-20261022T081530.wav",
    );
  });

  it("falls back to timestamp only when nothing slug-able", () => {
    expect(buildWavFilename("!!!", now)).toBe("tts-20261022T081530.wav");
  });
});
