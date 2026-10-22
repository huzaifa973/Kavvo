import { describe, expect, it } from "vitest";
import {
  SkillInputError,
  createDefaultRegistry,
  runSkill,
  type Base64Result,
  type CaseConvertResult,
  type CsvToJsonResult,
  type DedupeLinesResult,
  type HashResult,
  type JsonFormatResult,
  type JsonToCsvResult,
  type PasswordGenerateResult,
  type UnitConvertResult,
  type UrlCodecResult,
  type UuidResult,
} from "../src/index.js";

describe("default registry skill pack", () => {
  it("ships all 13 built-in skills", () => {
    const ids = createDefaultRegistry()
      .list()
      .map((skill) => skill.id)
      .sort();
    expect(ids).toEqual(
      [
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
      ].sort(),
    );
  });
});

describe("text.case-convert", () => {
  it("converts upper, lower and title case", async () => {
    const upper = (await runSkill("text.case-convert", {
      text: "Hello World",
      mode: "upper",
    })) as CaseConvertResult;
    expect(upper.text).toBe("HELLO WORLD");
    const lower = (await runSkill("text.case-convert", {
      text: "Hello World",
      mode: "lower",
    })) as CaseConvertResult;
    expect(lower.text).toBe("hello world");
    const title = (await runSkill("text.case-convert", {
      text: "hello wide world",
      mode: "title",
    })) as CaseConvertResult;
    expect(title.text).toBe("Hello Wide World");
  });

  it("converts camel, pascal, snake and kebab case", async () => {
    const camel = (await runSkill("text.case-convert", {
      text: "hello world example",
      mode: "camel",
    })) as CaseConvertResult;
    expect(camel.text).toBe("helloWorldExample");
    const pascal = (await runSkill("text.case-convert", {
      text: "hello world example",
      mode: "pascal",
    })) as CaseConvertResult;
    expect(pascal.text).toBe("HelloWorldExample");
    const snake = (await runSkill("text.case-convert", {
      text: "Hello World Example",
      mode: "snake",
    })) as CaseConvertResult;
    expect(snake.text).toBe("hello_world_example");
    const kebab = (await runSkill("text.case-convert", {
      text: "Hello World",
      mode: "kebab",
    })) as CaseConvertResult;
    expect(kebab.text).toBe("hello-world");
  });

  it("treats mixed separators as word boundaries for identifier cases", async () => {
    const result = (await runSkill("text.case-convert", {
      text: "hello-world_example now",
      mode: "camel",
    })) as CaseConvertResult;
    expect(result.text).toBe("helloWorldExampleNow");
  });

  it("rejects an unknown mode", async () => {
    await expect(
      runSkill("text.case-convert", { text: "hi", mode: "shout" }),
    ).rejects.toBeInstanceOf(SkillInputError);
  });
});

describe("text.dedupe-lines", () => {
  it("removes duplicate lines keeping first-occurrence order", async () => {
    const result = (await runSkill("text.dedupe-lines", {
      text: "b\na\nb\na",
    })) as DedupeLinesResult;
    expect(result.text).toBe("b\na");
    expect(result.removed).toBe(2);
  });

  it("sorts the unique lines when sort is true", async () => {
    const result = (await runSkill("text.dedupe-lines", {
      text: "banana\napple\nbanana",
      sort: true,
    })) as DedupeLinesResult;
    expect(result.text).toBe("apple\nbanana");
    expect(result.removed).toBe(1);
  });

  it("preserves a trailing newline and reports zero removals when unique", async () => {
    const result = (await runSkill("text.dedupe-lines", {
      text: "x\nx\n",
    })) as DedupeLinesResult;
    expect(result.text).toBe("x\n");
    expect(result.removed).toBe(1);
    const clean = (await runSkill("text.dedupe-lines", {
      text: "one\ntwo",
    })) as DedupeLinesResult;
    expect(clean.text).toBe("one\ntwo");
    expect(clean.removed).toBe(0);
  });
});

describe("text.base64", () => {
  it("encodes and decodes plain text", async () => {
    const encoded = (await runSkill("text.base64", {
      text: "hello",
      action: "encode",
    })) as Base64Result;
    expect(encoded.text).toBe("aGVsbG8=");
    const decoded = (await runSkill("text.base64", {
      text: "aGVsbG8=",
      action: "decode",
    })) as Base64Result;
    expect(decoded.text).toBe("hello");
  });

  it("is UTF-8 safe in both directions", async () => {
    const encoded = (await runSkill("text.base64", {
      text: "héllo",
      action: "encode",
    })) as Base64Result;
    expect(encoded.text).toBe("aMOpbGxv");
    const decoded = (await runSkill("text.base64", {
      text: encoded.text,
      action: "decode",
    })) as Base64Result;
    expect(decoded.text).toBe("héllo");
  });

  it("rejects malformed base64 on decode instead of returning garbage", async () => {
    await expect(
      runSkill("text.base64", { text: "not base64!", action: "decode" }),
    ).rejects.toBeInstanceOf(SkillInputError);
    await expect(
      runSkill("text.base64", { text: "aGVsbG8", action: "decode" }),
    ).rejects.toBeInstanceOf(SkillInputError);
  });

  it("rejects an unknown action", async () => {
    await expect(
      runSkill("text.base64", { text: "hi", action: "scramble" }),
    ).rejects.toBeInstanceOf(SkillInputError);
  });
});

describe("text.hash", () => {
  it("computes known digests", async () => {
    const sha256 = (await runSkill("text.hash", {
      text: "abc",
      algorithm: "sha256",
    })) as HashResult;
    expect(sha256.hash).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const sha1 = (await runSkill("text.hash", {
      text: "abc",
      algorithm: "sha1",
    })) as HashResult;
    expect(sha1.hash).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    const md5 = (await runSkill("text.hash", {
      text: "abc",
      algorithm: "md5",
    })) as HashResult;
    expect(md5.hash).toBe("900150983cd24fb0d6963f7d28e17f72");
  });

  it("rejects an unsupported algorithm", async () => {
    await expect(
      runSkill("text.hash", { text: "abc", algorithm: "sha512" }),
    ).rejects.toBeInstanceOf(SkillInputError);
  });
});

describe("text.url-codec", () => {
  it("encodes a component and decodes it back", async () => {
    const encoded = (await runSkill("text.url-codec", {
      text: "a b&c=d",
      action: "encode",
    })) as UrlCodecResult;
    expect(encoded.text).toBe("a%20b%26c%3Dd");
    const decoded = (await runSkill("text.url-codec", {
      text: encoded.text,
      action: "decode",
    })) as UrlCodecResult;
    expect(decoded.text).toBe("a b&c=d");
  });

  it("rejects malformed percent sequences on decode", async () => {
    await expect(
      runSkill("text.url-codec", { text: "%zz", action: "decode" }),
    ).rejects.toBeInstanceOf(SkillInputError);
  });
});

describe("data.json-format", () => {
  it("pretty-prints with 2-space indentation", async () => {
    const result = (await runSkill("data.json-format", {
      text: '{"a":1,"b":[1,2]}',
      mode: "pretty",
    })) as JsonFormatResult;
    expect(result.text).toBe(JSON.stringify({ a: 1, b: [1, 2] }, null, 2));
  });

  it("minifies pretty-printed JSON", async () => {
    const result = (await runSkill("data.json-format", {
      text: '{\n  "a": 1,\n  "b": [1, 2]\n}',
      mode: "minify",
    })) as JsonFormatResult;
    expect(result.text).toBe('{"a":1,"b":[1,2]}');
  });

  it("rejects invalid JSON with the parser's message", async () => {
    await expect(
      runSkill("data.json-format", { text: "{oops", mode: "pretty" }),
    ).rejects.toBeInstanceOf(SkillInputError);
    await expect(
      runSkill("data.json-format", { text: "{oops", mode: "pretty" }),
    ).rejects.toThrow(/invalid JSON: /);
  });
});

describe("data.csv-to-json", () => {
  it("parses rows under the header row", async () => {
    const result = (await runSkill("data.csv-to-json", {
      csv: "name,age\nAda,36\nGrace,85",
    })) as CsvToJsonResult;
    expect(result.rows).toEqual([
      { name: "Ada", age: "36" },
      { name: "Grace", age: "85" },
    ]);
  });

  it("handles quoted fields with commas and escaped quotes", async () => {
    const result = (await runSkill("data.csv-to-json", {
      csv: 'name,note\n"Doe, John","say ""hi"""',
    })) as CsvToJsonResult;
    expect(result.rows).toEqual([{ name: "Doe, John", note: 'say "hi"' }]);
  });

  it("handles CRLF endings, quoted newlines and short rows", async () => {
    const crlf = (await runSkill("data.csv-to-json", {
      csv: "a,b\r\n1,2\r\n",
    })) as CsvToJsonResult;
    expect(crlf.rows).toEqual([{ a: "1", b: "2" }]);
    const multiline = (await runSkill("data.csv-to-json", {
      csv: 'a,b\n"x\ny",2',
    })) as CsvToJsonResult;
    expect(multiline.rows).toEqual([{ a: "x\ny", b: "2" }]);
    const short = (await runSkill("data.csv-to-json", {
      csv: "a,b,c\n1,2",
    })) as CsvToJsonResult;
    expect(short.rows).toEqual([{ a: "1", b: "2", c: "" }]);
  });

  it("returns no rows for empty or header-only input", async () => {
    const empty = (await runSkill("data.csv-to-json", {
      csv: "",
    })) as CsvToJsonResult;
    expect(empty.rows).toEqual([]);
    const headerOnly = (await runSkill("data.csv-to-json", {
      csv: "a,b",
    })) as CsvToJsonResult;
    expect(headerOnly.rows).toEqual([]);
  });
});

describe("data.json-to-csv", () => {
  it("serializes flat objects with a header row", async () => {
    const result = (await runSkill("data.json-to-csv", {
      rows: [{ name: "Ada", age: 36 }],
    })) as JsonToCsvResult;
    expect(result.csv).toBe("name,age\nAda,36");
  });

  it("unions keys across rows in first-seen order", async () => {
    const result = (await runSkill("data.json-to-csv", {
      rows: [
        { a: 1, b: 2 },
        { b: 3, c: 4 },
      ],
    })) as JsonToCsvResult;
    expect(result.csv).toBe("a,b,c\n1,2,\n,3,4");
  });

  it("quotes values containing commas, quotes or newlines", async () => {
    const result = (await runSkill("data.json-to-csv", {
      rows: [{ note: "a,b" }, { note: 'say "hi"' }, { note: "x\ny" }],
    })) as JsonToCsvResult;
    expect(result.csv).toBe('note\n"a,b"\n"say ""hi"""\n"x\ny"');
  });

  it("renders null as empty and booleans as text", async () => {
    const result = (await runSkill("data.json-to-csv", {
      rows: [{ a: null, b: true }],
    })) as JsonToCsvResult;
    expect(result.csv).toBe("a,b\n,true");
  });

  it("returns an empty string for no rows and rejects non-array input", async () => {
    const empty = (await runSkill("data.json-to-csv", {
      rows: [],
    })) as JsonToCsvResult;
    expect(empty.csv).toBe("");
    await expect(
      runSkill("data.json-to-csv", { rows: "nope" }),
    ).rejects.toBeInstanceOf(SkillInputError);
  });
});

describe("util.uuid", () => {
  const V4_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it("generates one UUID v4 by default", async () => {
    const result = (await runSkill("util.uuid", {})) as UuidResult;
    expect(result.uuids).toHaveLength(1);
    expect(result.uuids[0]).toMatch(V4_PATTERN);
  });

  it("generates the requested count, all unique", async () => {
    const result = (await runSkill("util.uuid", { count: 5 })) as UuidResult;
    expect(result.uuids).toHaveLength(5);
    expect(new Set(result.uuids).size).toBe(5);
    for (const uuid of result.uuids) expect(uuid).toMatch(V4_PATTERN);
  });

  it("caps the count at 100", async () => {
    const result = (await runSkill("util.uuid", {
      count: 500,
    })) as UuidResult;
    expect(result.uuids).toHaveLength(100);
  });
});

describe("util.unit-convert", () => {
  it("converts length and weight within a family", async () => {
    const km = (await runSkill("util.unit-convert", {
      value: 1,
      from: "mi",
      to: "km",
    })) as UnitConvertResult;
    expect(km).toEqual({ value: 1.609344, unit: "km" });
    const mm = (await runSkill("util.unit-convert", {
      value: 1,
      from: "in",
      to: "mm",
    })) as UnitConvertResult;
    expect(mm.value).toBe(25.4);
    const oz = (await runSkill("util.unit-convert", {
      value: 1,
      from: "lb",
      to: "oz",
    })) as UnitConvertResult;
    expect(oz.value).toBe(16);
  });

  it("converts temperature across c, f and k", async () => {
    const fahrenheit = (await runSkill("util.unit-convert", {
      value: 100,
      from: "c",
      to: "f",
    })) as UnitConvertResult;
    expect(fahrenheit.value).toBe(212);
    const celsius = (await runSkill("util.unit-convert", {
      value: 32,
      from: "f",
      to: "c",
    })) as UnitConvertResult;
    expect(celsius.value).toBe(0);
    const kelvin = (await runSkill("util.unit-convert", {
      value: 0,
      from: "c",
      to: "k",
    })) as UnitConvertResult;
    expect(kelvin.value).toBe(273.15);
  });

  it("rejects cross-family conversions", async () => {
    await expect(
      runSkill("util.unit-convert", { value: 1, from: "m", to: "kg" }),
    ).rejects.toBeInstanceOf(SkillInputError);
    await expect(
      runSkill("util.unit-convert", { value: 1, from: "m", to: "kg" }),
    ).rejects.toThrow(/cannot convert/);
  });

  it("rejects unknown units and non-numeric values", async () => {
    await expect(
      runSkill("util.unit-convert", { value: 1, from: "m", to: "parsec" }),
    ).rejects.toBeInstanceOf(SkillInputError);
    await expect(
      runSkill("util.unit-convert", { value: "ten", from: "m", to: "km" }),
    ).rejects.toBeInstanceOf(SkillInputError);
  });
});

describe("util.password-generate", () => {
  it("generates a 16-character alphanumeric password by default", async () => {
    const result = (await runSkill(
      "util.password-generate",
      {},
    )) as PasswordGenerateResult;
    expect(result.password).toHaveLength(16);
    expect(result.password).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("honors length and includes symbols on request", async () => {
    const result = (await runSkill("util.password-generate", {
      length: 40,
      symbols: true,
    })) as PasswordGenerateResult;
    expect(result.password).toHaveLength(40);
    expect(result.password).toMatch(/^[A-Za-z0-9!@#$%^&*()\-_=+[\]{}<>?]+$/);
  });

  it("produces different passwords on successive calls", async () => {
    const first = (await runSkill(
      "util.password-generate",
      {},
    )) as PasswordGenerateResult;
    const second = (await runSkill(
      "util.password-generate",
      {},
    )) as PasswordGenerateResult;
    expect(first.password).not.toBe(second.password);
  });

  it("rejects lengths outside 8 to 128", async () => {
    await expect(
      runSkill("util.password-generate", { length: 7 }),
    ).rejects.toBeInstanceOf(SkillInputError);
    await expect(
      runSkill("util.password-generate", { length: 129 }),
    ).rejects.toBeInstanceOf(SkillInputError);
    await expect(
      runSkill("util.password-generate", { length: 12.5 }),
    ).rejects.toBeInstanceOf(SkillInputError);
  });
});
