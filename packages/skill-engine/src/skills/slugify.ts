import type { Skill } from "../types.js";

export interface SlugifyInput {
  title: string;
}

export interface SlugifyResult {
  slug: string;
}

export const slugifySkill: Skill<SlugifyInput, SlugifyResult> = {
  id: "text.slugify",
  name: "Slugify",
  description: "Turns a title into a clean, URL-safe slug.",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
  run(input) {
    const title = typeof input?.title === "string" ? input.title : "";
    const slug = title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "") // strip diacritics
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "");
    return { slug };
  },
};
