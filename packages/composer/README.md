# @skillforge/composer — Agent Composer

Chains skills (and chat calls) into **jobs** and runs them with
checkpoint + resume: the platform promise that tasks pause, never die.

## Jobs and steps

A `JobDefinition` is an ordered list of steps:

```ts
{
  title: "slug then count",
  steps: [
    { id: "make-slug", kind: "skill", skillId: "text.slugify",
      input: { title: "Hello Brave New World" } },
    { id: "count", kind: "skill", skillId: "text.word-count",
      input: { text: "{{make-slug.slug}}" } },
    { id: "draft", kind: "chat",
      messages: [{ role: "user", content: "Rewrite: {{make-slug.slug}}" }] },
  ],
}
```

- A **skill step** runs `skillId` through the Skill Engine's `runSkill`.
- A **chat step** runs `messages` through a chat client. The Composer
  depends on a minimal `ChatClient` interface (`chat(messages, opts)`
  returning at least `{ content }`); the Brain Router satisfies it
  structurally, so pass a `Router` instance. A chat step stores the full
  chat result (content, serving provider, attempts) as its output.
- Step `id` is optional; missing ids become `step-1`, `step-2`, ...
  Ids (and job ids) must match `[A-Za-z0-9_-]+` so references stay
  unambiguous. Duplicate ids and empty step lists are rejected with
  `JobDefinitionError` before anything is persisted.

## Referencing earlier outputs: `{{stepId.field}}`

Inside any string in a step's input or a chat step's messages:

- `{{stepId}}` — the whole output of an earlier step.
- `{{stepId.field}}`, `{{stepId.a.b}}` — dot-path into that output
  (object fields and array indexes).

Substitution modes:

- A string that is **exactly one placeholder** is replaced by the
  referenced value as-is, keeping its type (object, number, ...).
- Placeholders **embedded in a longer string** are interpolated as
  text: primitives via `String()`, objects via `JSON.stringify()`.

Resolution is recursive through plain objects and arrays. References
may only point to **earlier, completed** steps; an unknown step or
missing field throws `StepReferenceError`, which the Composer records
as that step's failure (the job stops as `failed`, earlier outputs
kept).

## Memory context for chat steps

Pass a `memory` source in `ComposerOptions` and every chat step is
preceded by a budgeted long-term-memory lookup:

```ts
new Composer({
  skills, chat, store,
  memory,               // anything with buildContext(query, { tokenBudget })
  memoryTokenBudget: 800, // optional; this is the default
});
```

- The Composer depends only on the minimal `MemoryContextSource`
  shape; `MemoryCore` from `@skillforge/memory-core` satisfies it
  structurally.
- The query is derived from the job's **title** plus the step's
  **resolved** message contents — templates already substituted, so
  a step that references an earlier step's output retrieves memory
  about that output.
- A non-empty result is prepended as one `system` message, bracketed
  by `[Relevant memory — retrieved from long-term memory for this
  task]` and `[End of relevant memory]` (exported as
  `MEMORY_CONTEXT_OPEN` / `MEMORY_CONTEXT_CLOSE`), around the Memory
  Core's own `## kind` grouped rendering. The source's budget
  guarantee applies to the section body: its estimated tokens never
  exceed `memoryTokenBudget`.
- Injection is **runtime-only**: the persisted job definition keeps
  the author's messages untouched, and a resumed step re-derives its
  context from memory as it then stands.
- Memory is enrichment, never a dependency: no source configured,
  an empty store, nothing relevant, nothing fitting the budget, or
  a throwing lookup all leave the step's messages exactly as
  defined — no empty section, and a broken memory store never fails
  a job. Skill steps are unaffected (they have no prompt surface).

## Checkpoint + resume

The Composer persists the full job record (definition + per-step
status, output and error) through a `JobStore` **after every step
transition**. Job statuses: `pending`, `running`, `paused`, `failed`,
`completed`.

- `run(definition)` — create + execute.
- `resume(jobId)` — continue from the first incomplete step. Completed
  steps are never re-run; a failed step is retried. Works after a
  failure, a pause, or a full process restart (with `FileJobStore`).
- `pause(jobId)` — the running executor stops after its current step
  with the job `paused`; `resume` unpauses and continues.
- Step failures do **not** throw out of `run()`/`resume()`: the
  returned `JobState` carries `status: "failed"` and the recorded
  error. Unknown job ids throw `JobNotFoundError`.

Stores:

- `InMemoryJobStore` — a `Map` with copy-in/copy-out isolation.
  Survives Composer instances, not restarts.
- `FileJobStore(dir)` — one JSON file per job (`<dir>/<jobId>.json`),
  written via temp-file + rename so a crash never leaves a torn
  checkpoint. Step outputs must be JSON-serializable.

## Not yet (by design)

- No retries/backoff policy inside the Composer: a failed step waits
  for `resume()` (the fix-the-cause flow). Automatic retry policy can
  layer on later without changing the job model.
- No concurrent execution of the same job id by multiple Composers.
- Skill input validation stays the Skill Engine's (required fields);
  full JSON-Schema validation is still future work.
