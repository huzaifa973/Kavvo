import type { Skill } from "@kavvo/skill-engine";
import ts from "typescript";
import { ForgeError, type SkillSpec } from "./types.js";
import { buildInputSchema } from "./validate.js";

/** The compiled run logic of a forged skill. */
export type ForgedRunFn = (
  input: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<unknown>;

/**
 * The documented module template. A spec's `source` is placed verbatim
 * inside this async function, so the source runs with `input` and
 * `ctx` in scope and must `return` its result. It declares no imports
 * or exports — inside a function body both are syntax errors, which
 * the compile step rejects. Line numbers in compiler messages are
 * reported relative to the source: the scaffold head above the source
 * is SCAFFOLD_HEAD_LINES lines tall.
 */
const SCAFFOLD_HEAD = [
  "export async function __forgeRun(",
  "  input: Record<string, unknown>,",
  "  ctx: Record<string, unknown>,",
  "): Promise<unknown> {",
  "",
].join("\n");
const SCAFFOLD_HEAD_LINES = 4;
const SCAFFOLD_TAIL = "\n}\n";

/** The full module text a spec compiles from (exported for inspection/tests). */
export function scaffoldSource(spec: SkillSpec): string {
  return SCAFFOLD_HEAD + spec.source + SCAFFOLD_TAIL;
}

/**
 * Transpile the scaffolded module with the repo's TypeScript and load
 * the result. A syntax error fails with the compiler's own message
 * (ForgeError, stage "compile"); type checking is deliberately NOT
 * done — `transpileModule` only, per the forge's design. Loading runs
 * the module in-process: forged skills are first-party code (see the
 * trust model in types.ts), so this is the same trust as importing a
 * hand-written skill module.
 */
export async function compileSpec(spec: SkillSpec): Promise<ForgedRunFn> {
  const { outputText, diagnostics } = ts.transpileModule(scaffoldSource(spec), {
    fileName: `${spec.id}.ts`,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const errors = (diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    const first = errors[0];
    const message = ts.flattenDiagnosticMessageText(first.messageText, " ");
    let where = "";
    if (first.file && typeof first.start === "number") {
      const pos = first.file.getLineAndCharacterOfPosition(first.start);
      const sourceLine = pos.line + 1 - SCAFFOLD_HEAD_LINES;
      if (sourceLine >= 1) {
        where = ` (source line ${sourceLine}, column ${pos.character + 1})`;
      }
    }
    throw new ForgeError(
      "compile",
      `TypeScript rejected the source for "${spec.id}": ${message}${where}`,
      spec.id,
    );
  }
  const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
  try {
    const evaluate = new Function("exports", "module", outputText);
    evaluate(moduleObj.exports, moduleObj);
  } catch (err) {
    throw new ForgeError(
      "compile",
      `Compiled module for "${spec.id}" failed to load: ${(err as Error).message}`,
      spec.id,
    );
  }
  const run = moduleObj.exports.__forgeRun;
  if (typeof run !== "function") {
    throw new ForgeError(
      "compile",
      `Compiled module for "${spec.id}" did not produce a run function`,
      spec.id,
    );
  }
  return run as ForgedRunFn;
}

/** Assemble the Skill Engine `Skill` for a spec from its compiled run function. */
export function buildSkill(spec: SkillSpec, runFn: ForgedRunFn): Skill {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    inputSchema: buildInputSchema(spec),
    run: (input, ctx) =>
      runFn(input, ctx as Record<string, unknown>),
  };
}
