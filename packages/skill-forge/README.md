# @skillforge/skill-forge — Skill Forge

AI builds a NEW skill when a user asks for something missing; the
skill is saved forever and is instant for everyone. This package is
the mechanics around that act: the spec format, scaffolding,
validation, registration and rollback. The one piece that does not
exist yet is the spec AUTHOR — later a model behind the Brain Router
writes specs; today specs are hand-written, and everything downstream
of the spec is real and tested.

## The SkillSpec

A spec is a JSON-friendly object (it is stored verbatim in the
provenance record, so it must survive JSON untouched):

```ts
{
  id: "text.shout",                    // namespace.name, lowercase
  name: "Shout",
  description: "Uppercases the input text and adds a trailing '!'.",
  input: {
    required: ["text"],                // every entry must exist in properties
    properties: { text: "string" },    // "string" | "number" | "boolean" | "object" | "array"
  },
  source: "return { text: String(input.text).toUpperCase() + '!' };",
}
```

- `id` must match `namespace.name`: lowercase, letter-led segments of
  `[a-z0-9-]` joined by dots, at least one dot (`text.shout`,
  `data.csv-to-json`). This is the same id space the built-ins use.
- The spec becomes a Skill Engine `inputSchema` of
  `{ type: "object", properties: { field: { type } }, required }`, so
  the registry's required-field validation applies to forged skills
  exactly as it does to built-ins.

## The source contract

`source` is the TypeScript **body** of the skill's run logic. The
scaffolder wraps it in exactly this module template:

```ts
export async function __forgeRun(
  input: Record<string, unknown>,
  ctx: Record<string, unknown>,
): Promise<unknown> {
// <-- source goes here, verbatim
}
```

- `input` is in scope: the skill's input object. `ctx` is in scope:
  the `SkillContext` handed through at run time (may be empty).
- The source **must `return` the result** (an object by convention).
  It may `await` — it lives inside an async function.
- The source **exports nothing and imports nothing**. Inside a
  function body both are syntax errors, and the compile step rejects
  them. This is deliberate: a v1 forged skill is pure computation
  over its input using the standard JS/TS library (`JSON`, `Math`,
  string/array methods, …). It gets **no Node builtins and no
  network**. Skills that need files, network or models stay
  hand-written built-ins until a later forge version defines that
  surface.
- Type annotations are welcome (the body is TypeScript), but the
  forge transpiles without type-checking — a type error is not a
  forge error; a syntax error is.

## The pipeline — `forgeSkill(spec, registry, { store, samples?, now? })`

Four stages, each failing with a `ForgeError` tagged by `stage`:

1. **validate** — `assertValidSpec`: id format, non-empty
   name/description/source, input sanity (required ⊆ properties, no
   duplicates, property types from the allowed set) — plus uniqueness
   against the target registry (a duplicate id, forged or built-in,
   is rejected here).
2. **compile** — the scaffolded module is transpiled with the repo's
   TypeScript (`transpileModule`, diagnostics on). A syntax error
   fails the forge with the compiler's own message and the source
   line. The emitted module is then loaded in-process.
3. **smoke** — every caller-provided sample case
   `{ input, expect? }` runs against the compiled (still
   unregistered) skill. A throwing case fails the forge; when
   `expect` is present the result must deep-equal it.
4. **register** — only on full success: the skill enters the
   registry, and a provenance record
   `{ id, spec, specHash, forgedAt }` enters the store. `specHash`
   is a SHA-256 over the spec's canonical JSON (key-order
   independent), so a stored record can later be checked against
   the spec it claims to hold.

**Rollback:** nothing mutates before stage 4, and if the record
save fails after registration, the registration is undone. Any
failure leaves the registry and the store exactly as they were —
this is proven in the tests, not just promised.

## Provenance, stores, removal

- `ForgeStore` mirrors the house store pattern, with
  `InMemoryForgeStore` and `FileForgeStore` (one JSON per skill
  under a caller directory, temp-file + rename writes). Records
  carry the full spec, so a record is all a restart needs.
- `unforge(registry, store, id)` unregisters the skill and drops
  its record. It returns `false` when the forge holds no record
  for the id: the forge only unmakes what it made, so built-ins
  are never removed through here.

## Boot reload — `loadForged(registry, store)`

At boot, stored forged skills are re-registered, re-running the
same validation and compilation as the original forge (smoke cases
are not stored, so they are not re-run). The report is
`{ loaded: string[], skipped: { id, reason }[] }`: a record that
no longer validates, no longer compiles, or whose id is already
registered is **skipped with its reason recorded** — never a
crashed boot. The file store's `list()` additionally skips files
that do not parse as JSON at all, so a torn or foreign file in the
directory cannot reach the loader.

## Trust model (v1)

Forged skills are **first-party**: written by our own AI under
review, not arbitrary user code. Compiled specs run **in-process
with the host's full privileges**, exactly like a hand-written
built-in — v1 has no sandbox, and the small source contract is a
usability boundary, not an isolation one. The safety is procedural:
validation, compile checks, mandatory smoke tests when the caller
provides them, complete provenance, and instant `unforge`. A real
sandbox is a hard precondition for the future community/marketplace
step, where specs would come from third parties.

## The AI seam

Spec generation plugs in at exactly one place: something produces
a `SkillSpec` plus sample cases, and calls `forgeSkill`. That is
the whole contract — a generator behind the Brain Router (BYOK keys,
chosen model) needs no other change here, and a bad generated spec
fails the same typed stages a bad hand-written one does.
