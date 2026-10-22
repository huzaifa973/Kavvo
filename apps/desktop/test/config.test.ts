import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW_SIZE,
  parseQuitAfterMs,
  resolvePreloadPath,
  resolvePublicDir,
  resolveUserDataDir,
} from "../src/config.js";

describe("resolveUserDataDir", () => {
  it("uses the env override when set", () => {
    expect(resolveUserDataDir("/tmp/smoke-data", "/os/userData")).toBe(
      "/tmp/smoke-data",
    );
  });

  it("trims the override and falls back when it is blank or unset", () => {
    expect(resolveUserDataDir("  /tmp/smoke-data  ", "/os/userData")).toBe(
      "/tmp/smoke-data",
    );
    expect(resolveUserDataDir("   ", "/os/userData")).toBe("/os/userData");
    expect(resolveUserDataDir(undefined, "/os/userData")).toBe("/os/userData");
  });
});

describe("parseQuitAfterMs", () => {
  it("parses a positive duration", () => {
    expect(parseQuitAfterMs("25000")).toBe(25000);
    expect(parseQuitAfterMs("2500.9")).toBe(2500);
  });

  it("treats unset, non-numeric and non-positive values as no auto-quit", () => {
    expect(parseQuitAfterMs(undefined)).toBeUndefined();
    expect(parseQuitAfterMs("abc")).toBeUndefined();
    expect(parseQuitAfterMs("0")).toBeUndefined();
    expect(parseQuitAfterMs("-5")).toBeUndefined();
  });
});

describe("build-tree paths", () => {
  const mainModuleDir = join("/repo", "apps", "desktop", "dist", "apps", "desktop", "src");

  it("resolves the copied UI dir beside the compiled web shell", () => {
    expect(resolvePublicDir(mainModuleDir)).toBe(
      join("/repo", "apps", "desktop", "dist", "apps", "web", "public"),
    );
  });

  it("resolves the preload next to the compiled main", () => {
    expect(resolvePreloadPath(mainModuleDir)).toBe(
      join(mainModuleDir, "preload.cjs"),
    );
  });

  it("pins the default window size at 1280x800", () => {
    expect(DEFAULT_WINDOW_SIZE).toEqual({ width: 1280, height: 800 });
  });
});
