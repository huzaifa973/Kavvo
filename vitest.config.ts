import { defineConfig } from "vitest/config";

const pkg = (name: string) =>
  new URL(`./packages/${name}/src/index.ts`, import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: {
      "@kavvo/rules-engine": pkg("rules-engine"),
      "@kavvo/router": pkg("router"),
      "@kavvo/skill-engine": pkg("skill-engine"),
    },
  },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
    ],
  },
});
