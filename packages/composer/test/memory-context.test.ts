import { describe, expect, it } from "vitest";
import { MockProvider, Router, type ChatMessage } from "@kavvo/router";
import { createDefaultRegistry } from "@kavvo/skill-engine";
import {
  InMemoryMemoryStore,
  MemoryCore,
  estimateTokens,
  type AddMemoryInput,
} from "../../memory-core/src/index.js";
import {
  Composer,
  InMemoryJobStore,
  MEMORY_CONTEXT_CLOSE,
  MEMORY_CONTEXT_OPEN,
  type ChatClient,
  type MemoryContextSource,
} from "../src/index.js";

/** A ChatClient that records the exact messages each call received. */
class RecordingChat implements ChatClient {
  readonly calls: ChatMessage[][] = [];

  async chat(messages: ChatMessage[]): Promise<{ content: string }> {
    this.calls.push(messages.map((m) => ({ ...m })));
    return { content: "recorded reply" };
  }
}

/** A real MemoryCore over a fresh in-memory store, seeded via add(). */
async function memoryWith(entries: AddMemoryInput[]): Promise<MemoryCore> {
  const store = new InMemoryMemoryStore();
  for (const entry of entries) await store.add(entry);
  return new MemoryCore(store);
}

function composerWith(chat: ChatClient, memory?: MemoryContextSource, memoryTokenBudget?: number) {
  return new Composer({
    skills: createDefaultRegistry(),
    chat,
    store: new InMemoryJobStore(),
    memory,
    memoryTokenBudget,
  });
}

describe("Composer memory context", () => {
  it("injects relevant memory as a delimited system message ahead of the chat step's messages", async () => {
    const memory = await memoryWith([
      {
        kind: "fact",
        text: "The production deployment server is hosted in Frankfurt",
        importance: 5,
      },
      {
        kind: "preference",
        text: "Prefers all reports written with metric units",
        importance: 4,
      },
      {
        kind: "note",
        text: "Bananas were on sale at the corner market yesterday",
        importance: 3,
      },
    ]);
    const chat = new RecordingChat();
    const composer = composerWith(chat, memory);

    const result = await composer.run({
      title: "Plan the deployment report",
      steps: [
        {
          id: "ask",
          kind: "chat",
          messages: [
            {
              role: "user",
              content:
                "Where is the deployment server hosted, and which units should the report use?",
            },
          ],
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(chat.calls).toHaveLength(1);
    const messages = chat.calls[0]!;
    expect(messages).toHaveLength(2);

    // First message: the memory section, clearly delimited, grouped
    // by kind in the Memory Core's fixed kind order.
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content.startsWith(MEMORY_CONTEXT_OPEN)).toBe(true);
    expect(messages[0]!.content.endsWith(MEMORY_CONTEXT_CLOSE)).toBe(true);
    expect(messages[0]!.content).toContain("Frankfurt");
    expect(messages[0]!.content).toContain("metric units");
    expect(messages[0]!.content.indexOf("## fact")).toBeLessThan(
      messages[0]!.content.indexOf("## preference"),
    );
    // The irrelevant memory never entered the context.
    expect(messages[0]!.content).not.toContain("Bananas");

    // The step's own message follows, exactly as defined.
    expect(messages[1]).toEqual({
      role: "user",
      content:
        "Where is the deployment server hosted, and which units should the report use?",
    });

    // Injection is runtime-only: the persisted definition is untouched.
    const ask = result.definition.steps[0]!;
    expect(ask.kind).toBe("chat");
    if (ask.kind === "chat") expect(ask.messages).toHaveLength(1);
  });

  it("orders same-kind memories by relevance inside the section", async () => {
    const memory = await memoryWith([
      {
        kind: "fact",
        text: "Deployment notes live in the shared runbook folder",
        importance: 1,
      },
      {
        kind: "fact",
        text: "Deployment server region is Frankfurt",
        importance: 5,
      },
    ]);
    const chat = new RecordingChat();
    const composer = composerWith(chat, memory);

    const result = await composer.run({
      title: "Deployment planning",
      steps: [
        {
          id: "ask",
          kind: "chat",
          messages: [
            { role: "user", content: "Which deployment server region should we use?" },
          ],
        },
      ],
    });

    expect(result.status).toBe("completed");
    const content = chat.calls[0]![0]!.content;
    expect(content.indexOf("Frankfurt")).toBeGreaterThan(-1);
    expect(content.indexOf("runbook")).toBeGreaterThan(-1);
    expect(content.indexOf("Frankfurt")).toBeLessThan(content.indexOf("runbook"));
  });

  it("enforces the configured budget: oversized memory is trimmed to fit", async () => {
    const entries: AddMemoryInput[] = [
      { kind: "fact", text: "Kestrel migration checkpoint alpha recorded", importance: 5 },
      { kind: "fact", text: "Kestrel migration checkpoint bravo recorded", importance: 3 },
      { kind: "fact", text: "Kestrel migration checkpoint charlie noted", importance: 1 },
    ];
    const job = {
      steps: [
        {
          id: "ask",
          kind: "chat" as const,
          messages: [
            { role: "user" as const, content: "Status of the kestrel migration checkpoint?" },
          ],
        },
      ],
    };

    // Tight budget: only the top-ranked fact fits.
    const tightChat = new RecordingChat();
    const tight = composerWith(tightChat, await memoryWith(entries), 20);
    const tightResult = await tight.run(job);
    expect(tightResult.status).toBe("completed");
    const tightMessages = tightChat.calls[0]!;
    expect(tightMessages).toHaveLength(2);
    const section = tightMessages[0]!.content;
    expect(section).toContain("alpha");
    expect(section).not.toContain("bravo");
    expect(section).not.toContain("charlie");
    // The section body itself honors the budget (the Memory Core's
    // guarantee), not just the item count.
    const body = section.slice(
      section.indexOf("\n") + 1,
      section.lastIndexOf("\n"),
    );
    expect(estimateTokens(body)).toBeLessThanOrEqual(20);

    // Generous budget: all three facts are admitted.
    const wideChat = new RecordingChat();
    const wide = composerWith(wideChat, await memoryWith(entries), 200);
    const wideResult = await wide.run(job);
    expect(wideResult.status).toBe("completed");
    const wideSection = wideChat.calls[0]![0]!.content;
    expect(wideSection).toContain("alpha");
    expect(wideSection).toContain("bravo");
    expect(wideSection).toContain("charlie");
  });

  it("derives the query from resolved step references, so memory matches what the step actually says", async () => {
    const memory = await memoryWith([
      {
        kind: "fact",
        text: "Frankfurt is the deployment region for all European services",
        importance: 4,
      },
    ]);
    const chat = new RecordingChat();
    const composer = composerWith(chat, memory);

    const result = await composer.run({
      steps: [
        {
          id: "make-slug",
          kind: "skill",
          skillId: "text.slugify",
          input: { title: "Frankfurt Deployment Guide" },
        },
        {
          id: "ask",
          kind: "chat",
          messages: [
            { role: "user", content: "Write a summary for {{make-slug.slug}}" },
          ],
        },
      ],
    });

    expect(result.status).toBe("completed");
    const messages = chat.calls[0]!;
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain(
      "Frankfurt is the deployment region",
    );
    expect(messages[1]!.content).toBe(
      "Write a summary for frankfurt-deployment-guide",
    );
  });

  it("reaches the provider through a real Router with the memory message first", async () => {
    const memory = await memoryWith([
      {
        kind: "preference",
        text: "Prefers release notes in a terse bullet style",
        importance: 4,
      },
    ]);
    const provider = new MockProvider("mock", { content: "done" });
    const router = new Router({ providers: [provider] });
    const composer = composerWith(router, memory);

    const result = await composer.run({
      steps: [
        {
          id: "ask",
          kind: "chat",
          messages: [{ role: "user", content: "Draft the release notes" }],
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(provider.lastMessages).toHaveLength(2);
    expect(provider.lastMessages![0]!.role).toBe("system");
    expect(provider.lastMessages![0]!.content).toContain("terse bullet style");
    expect(provider.lastMessages![1]).toEqual({
      role: "user",
      content: "Draft the release notes",
    });
  });

  it("is a no-op when the memory store is empty", async () => {
    const chat = new RecordingChat();
    const composer = composerWith(chat, await memoryWith([]));
    const original = [{ role: "user" as const, content: "Hello there" }];

    const result = await composer.run({
      steps: [{ id: "ask", kind: "chat", messages: original }],
    });

    expect(result.status).toBe("completed");
    expect(chat.calls[0]).toEqual(original);
  });

  it("is a no-op when nothing in memory is relevant to the step", async () => {
    const memory = await memoryWith([
      {
        kind: "note",
        text: "Bananas were on sale at the corner market yesterday",
        importance: 5,
      },
    ]);
    const chat = new RecordingChat();
    const composer = composerWith(chat, memory);
    const original = [
      { role: "user" as const, content: "Summarize the quarterly deployment plan" },
    ];

    const result = await composer.run({
      steps: [{ id: "ask", kind: "chat", messages: original }],
    });

    expect(result.status).toBe("completed");
    // No empty memory section is prepended.
    expect(chat.calls[0]).toEqual(original);
  });

  it("leaves chat steps exactly as defined when no memory source is configured", async () => {
    const chat = new RecordingChat();
    const composer = composerWith(chat);
    const original = [{ role: "user" as const, content: "Hello there" }];

    const result = await composer.run({
      steps: [{ id: "ask", kind: "chat", messages: original }],
    });

    expect(result.status).toBe("completed");
    expect(chat.calls[0]).toEqual(original);
  });

  it("never fails a chat step when the memory lookup itself throws", async () => {
    const broken: MemoryContextSource = {
      buildContext: async () => {
        throw new Error("memory store exploded");
      },
    };
    const chat = new RecordingChat();
    const composer = composerWith(chat, broken);
    const original = [{ role: "user" as const, content: "Hello there" }];

    const result = await composer.run({
      steps: [{ id: "ask", kind: "chat", messages: original }],
    });

    expect(result.status).toBe("completed");
    expect(chat.calls[0]).toEqual(original);
  });
});
