// Build helper: tsc emits the compiled shell to
// dist/apps/web/src/ (rootDir is the workspace root), and the running
// server looks for its static UI in ../public relative to server.js —
// so copy the source public/ folder to dist/apps/web/public/.
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(appRoot, "public");
const to = join(appRoot, "dist", "apps", "web", "public");

rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log(`copied ${from} -> ${to}`);
