import { SkillRegistry } from "./registry.js";
import { base64Skill } from "./skills/base64.js";
import { caseConvertSkill } from "./skills/case-convert.js";
import { csvToJsonSkill } from "./skills/csv-to-json.js";
import { dedupeLinesSkill } from "./skills/dedupe-lines.js";
import { hashSkill } from "./skills/hash.js";
import { jsonFormatSkill } from "./skills/json-format.js";
import { jsonToCsvSkill } from "./skills/json-to-csv.js";
import { passwordGenerateSkill } from "./skills/password-generate.js";
import { slugifySkill } from "./skills/slugify.js";
import { unitConvertSkill } from "./skills/unit-convert.js";
import { urlCodecSkill } from "./skills/url-codec.js";
import { uuidSkill } from "./skills/uuid.js";
import { wordCountSkill } from "./skills/word-count.js";
import type { SkillContext } from "./types.js";

export { SkillRegistry } from "./registry.js";
export {
  DuplicateSkillError,
  SkillInputError,
  SkillNotFoundError,
  type Skill,
  type SkillContext,
} from "./types.js";
export { wordCountSkill, type WordCountInput, type WordCountResult } from "./skills/word-count.js";
export { slugifySkill, type SlugifyInput, type SlugifyResult } from "./skills/slugify.js";
export {
  caseConvertSkill,
  type CaseConvertInput,
  type CaseConvertResult,
  type CaseConvertMode,
} from "./skills/case-convert.js";
export {
  dedupeLinesSkill,
  type DedupeLinesInput,
  type DedupeLinesResult,
} from "./skills/dedupe-lines.js";
export {
  base64Skill,
  type Base64Input,
  type Base64Result,
  type Base64Action,
} from "./skills/base64.js";
export {
  hashSkill,
  type HashInput,
  type HashResult,
  type HashAlgorithm,
} from "./skills/hash.js";
export {
  urlCodecSkill,
  type UrlCodecInput,
  type UrlCodecResult,
  type UrlCodecAction,
} from "./skills/url-codec.js";
export {
  jsonFormatSkill,
  type JsonFormatInput,
  type JsonFormatResult,
  type JsonFormatMode,
} from "./skills/json-format.js";
export {
  csvToJsonSkill,
  type CsvToJsonInput,
  type CsvToJsonResult,
} from "./skills/csv-to-json.js";
export {
  jsonToCsvSkill,
  type JsonToCsvInput,
  type JsonToCsvResult,
} from "./skills/json-to-csv.js";
export { uuidSkill, type UuidInput, type UuidResult } from "./skills/uuid.js";
export {
  unitConvertSkill,
  type UnitConvertInput,
  type UnitConvertResult,
} from "./skills/unit-convert.js";
export {
  passwordGenerateSkill,
  type PasswordGenerateInput,
  type PasswordGenerateResult,
} from "./skills/password-generate.js";

/** Registry preloaded with the built-in skills shipped in v0.1. */
export function createDefaultRegistry(): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register(wordCountSkill);
  registry.register(slugifySkill);
  registry.register(caseConvertSkill);
  registry.register(dedupeLinesSkill);
  registry.register(base64Skill);
  registry.register(hashSkill);
  registry.register(urlCodecSkill);
  registry.register(jsonFormatSkill);
  registry.register(csvToJsonSkill);
  registry.register(jsonToCsvSkill);
  registry.register(uuidSkill);
  registry.register(unitConvertSkill);
  registry.register(passwordGenerateSkill);
  return registry;
}

/** Shared default registry behind the module-level runSkill() helper. */
export const defaultRegistry = createDefaultRegistry();

/** Run a built-in skill by id against the default registry. */
export async function runSkill(
  id: string,
  input: Record<string, unknown>,
  ctx: SkillContext = {},
): Promise<unknown> {
  return defaultRegistry.runSkill(id, input, ctx);
}
