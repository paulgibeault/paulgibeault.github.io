// Stage the deploy artifact — the per-app half of the fleet contract
// (GAME_INTEGRATION §13a). tools/verify-artifact.mjs is identical fleet-wide
// and calls into this; only the way an artifact gets produced differs.
//
// This repo is the launcher, so its staging differs from a game's in one
// way: the published site IS the platform's documentation, and index.html
// links to it (SELF_HOSTING.md and friends). Markdown ships here.
//
// Everything a game excludes — CI config, tests, tooling, fixtures, package
// files — is excluded here too, and used to be published by accident:
// tools/, package.json and the CI fixtures were all live on the origin the
// whole fleet loads its SDK from.
//
// Usage: node tools/stage.mjs <outDir>
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { injectPrecache } from "./inject-precache.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Published, deliberately not precached. The launcher's site IS the platform's
// documentation, so prose ships and is linked — but a player offline wants the
// arcade to boot, not the self-hosting guide, and precaching every doc would
// spend their cache budget on reading material. Prose is fetched live.
export const PRECACHE_EXCLUDE = ["*.md", "plans/", "docs/", "LICENSE", "NOTICE"];

const EXCLUDE_DIRS = new Set([".github", ".claude", "node_modules",
  "tests", "test", "scratch", "tools", "scripts"]);
const EXCLUDE_ROOT = new Set(["package.json", "package-lock.json",
  ".gitignore", "go.sh", "ago", "dev.sh"]);
const EXCLUDE_EXT = new Set([".py", ".pid"]);

export function isDevOnly(f) {
  return EXCLUDE_DIRS.has(f.split("/")[0]) ||
    (!f.includes("/") && EXCLUDE_ROOT.has(f)) ||
    (!f.includes("/") && /^test_/.test(f)) ||
    EXCLUDE_EXT.has(path.extname(f));
}

export function stage(outDir) {
  const out = path.resolve(ROOT, outDir);
  fs.rmSync(out, { recursive: true, force: true });
  const files = execSync("git ls-files -z", { cwd: ROOT, encoding: "utf8" })
    .split("\0").filter(Boolean);
  let staged = 0;
  for (const f of files) {
    if (isDevOnly(f)) continue;
    fs.mkdirSync(path.join(out, path.dirname(f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(out, f));
    staged++;
  }
  // Last, so it sees the finished artifact — the precache list is written
  // from what is actually about to deploy, not from what anyone believes is.
  const precached = injectPrecache(out, { exclude: PRECACHE_EXCLUDE });
  return { outDir: out, staged, total: files.length, precached: precached?.length ?? 0 };
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const out = process.argv[2];
  if (!out) { console.error("usage: node tools/stage.mjs <outDir>"); process.exit(1); }
  const r = stage(out);
  console.log(`staged ${r.staged} files to ${out} (${r.total - r.staged} dev files excluded)`);
}
