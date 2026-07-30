// The service worker's precache list, written from the artifact that actually
// deploys instead of maintained by hand.
//
// IDENTICAL IN EVERY FLEET REPO. Do not edit one copy: change the canonical
// file and re-copy it (GAME_INTEGRATION §13a). Like verify-artifact.mjs it is
// a plain module, callable from any of the three test runners the fleet uses.
//
// WHY THIS EXISTS
//
// A hand-listed precache is three lists that must agree — index.html's tags,
// sw.js's array, and what the deploy publishes — with nothing checking the
// third against the second. Every drift mode showed up in the fleet at once:
// an app shipped a bundled file the list could not name because the name is
// content-hashed and changes every build; another listed paths in a form the
// verifier's pattern never matched, so its entries went unchecked for months;
// a third precached a file it no longer published. The failure is always the
// same shape and always silent — install() rejects, or the cache is missing
// the one file the game needs, and the only symptom is a game that works
// online and breaks on a plane.
//
// So the list is generated. The input is the staged directory, which is the
// bytes that deploy; nothing can be listed that isn't published, and nothing
// published is omitted unless the app says so out loud.
//
// THE CONTRACT
//
// sw.js carries a generated region, and this rewrites what is between the
// markers:
//
//   // arcade:precache-begin
//   const ASSETS = [ './', './index.html' ];
//   // arcade:precache-end
//
// The checked-in list is a placeholder — service workers are disabled on
// loopback fleet-wide, so a dev checkout never uses it.
//
// An app that must leave something out of the cache — a diagnostic it ships
// but never boots, a heavy asset it fetches on demand — declares it as
// PRECACHE_EXCLUDE in tools/stage.mjs, where the rest of its per-app deploy
// declaration already lives. That is deliberately the only knob, and it is
// visible in review: verify-artifact.mjs asserts that every published file is
// either precached or named there, so dropping a file out of the cache is a
// decision someone writes down rather than an omission nobody notices.
import fs from "node:fs";
import path from "node:path";

const BEGIN = "// arcade:precache-begin";
const END = "// arcade:precache-end";

/** Every file in the artifact, as forward-slash paths relative to its root. */
export function artifactFiles(dir) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : [path.relative(dir, p).split(path.sep).join("/")];
  });
  return walk(dir).sort();
}

/**
 * Files that are published but never precached, whatever the app.
 *
 * sw.js itself: the worker is fetched by the browser's update check, which
 * must reach the network to ever see a new version — caching it is how a
 * worker makes itself permanent.
 *
 * Dotfiles: .DS_Store, .gitkeep and friends are never runtime assets. They
 * should not be in the artifact at all, but a precache list is the wrong
 * place to discover that, and addAll() rejecting on one would take the whole
 * cache down with it.
 */
const NEVER = (rel) => rel === "sw.js" || rel.split("/").some((seg) => seg.startsWith("."));

/**
 * True if `rel` is excluded by `patterns`.
 *
 * Three forms, deliberately not a glob library: an exact path, a `dir/`
 * prefix, and a `*.ext` suffix. Exclusions are read by whoever reviews a
 * deploy, so the vocabulary stays small enough to be obvious at a glance —
 * and anything subtler than "this file", "this directory" or "this kind of
 * file" is a sign the artifact itself wants fixing, not the filter.
 */
export function isExcluded(rel, patterns) {
  return patterns.some((p) => {
    if (p.startsWith("*")) return rel.endsWith(p.slice(1));
    if (p.endsWith("/")) return rel.startsWith(p);
    return rel === p;
  });
}

/** What the artifact in `dir` should precache, given the app's exclusions. */
export function precacheList(dir, exclude = []) {
  const entries = artifactFiles(dir)
    .filter((f) => !NEVER(f) && !isExcluded(f, exclude))
    .map((f) => `./${f}`);
  // "./" is the directory itself — what a player actually navigates to. It is
  // a distinct cache key from ./index.html and both are needed: the former is
  // the URL, the latter is what a relative fetch resolves to.
  return ["./", ...entries];
}

/**
 * Rewrite the generated region of `dir/sw.js` from the staged artifact.
 * Returns the entries written, or null if this artifact ships no worker.
 */
export function injectPrecache(dir, { exclude = [] } = {}) {
  const swPath = path.join(dir, "sw.js");
  if (!fs.existsSync(swPath)) return null;

  const src = fs.readFileSync(swPath, "utf8");
  const from = src.indexOf(BEGIN);
  const to = src.indexOf(END);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(
      `sw.js has no generated precache region — expected ${BEGIN} … ${END}. ` +
      `See tools/templates/game-sw.js (GAME_INTEGRATION §10).`
    );
  }

  const entries = precacheList(dir, exclude);
  const block = [
    BEGIN,
    "// Generated at stage time by tools/inject-precache.mjs from the files this",
    "// deploy actually publishes. DO NOT EDIT BY HAND — your edit is overwritten",
    "// on the next build. To leave a file out, add it to PRECACHE_EXCLUDE in",
    "// tools/stage.mjs.",
    "const ASSETS = [",
    ...entries.map((e) => `  '${e}',`),
    "];",
  ].join("\n");

  fs.writeFileSync(swPath, src.slice(0, from) + block + "\n" + src.slice(to));
  return entries;
}
