import { defineConfig } from "vitest/config";

const pkg = (name: string) =>
  new URL(`./packages/${name}/src/index.ts`, import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: {
      "@skillforge/rules-engine": pkg("rules-engine"),
      "@skillforge/router": pkg("router"),
      "@skillforge/skill-engine": pkg("skill-engine"),
    },
  },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
    ],
  },
});
