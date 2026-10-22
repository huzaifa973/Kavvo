// Build helper: tsc emits the compiled desktop main (plus the web
// shell and core packages it imports) into dist/, mirroring the
// repo layout — the main lands in dist/apps/desktop/src/, the shell
// in dist/apps/web/src/. Two runtime assets are not TypeScript and
// must be copied beside that output:
//   preload.cjs        -> dist/apps/desktop/src/preload.cjs
//     (the main points the BrowserWindow at it, next to itself)
//   apps/web/public/   -> dist/apps/web/public/
//     (the shell serves its UI from beside its compiled server.js)
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const preloadFrom = join(appRoot, "preload.cjs");
const preloadTo = join(appRoot, "dist", "apps", "desktop", "src", "preload.cjs");
cpSync(preloadFrom, preloadTo);
console.log(`copied ${preloadFrom} -> ${preloadTo}`);

const publicFrom = join(appRoot, "..", "web", "public");
const publicTo = join(appRoot, "dist", "apps", "web", "public");
rmSync(publicTo, { recursive: true, force: true });
cpSync(publicFrom, publicTo, { recursive: true });
console.log(`copied ${publicFrom} -> ${publicTo}`);
