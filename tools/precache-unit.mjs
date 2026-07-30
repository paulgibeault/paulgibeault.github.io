#!/usr/bin/env node
//
// tools/precache-unit.mjs — the generated precache list and the artifact
// assertion that backs it (tools/inject-precache.mjs).
//
// The bug this guards is not a wrong list, it is a list nobody notices is
// wrong: a published file outside the cache breaks a game only offline, which
// no green CI run has ever exercised. So the assertions here are mostly about
// the failure being LOUD — the injector refusing a worker it cannot rewrite,
// and the verifier naming a file that got published without being cached.
//
//   node tools/precache-unit.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { injectPrecache, precacheList, isExcluded } from "./inject-precache.mjs";
import { verify } from "./verify-artifact.mjs";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

const SW_STUB = [
  "const APP_VERSION = '0.0.0';",
  "// arcade:precache-begin",
  "const ASSETS = [",
  "  './',",
  "];",
  "// arcade:precache-end",
  "self.addEventListener('install', () => {});",
].join("\n");

/** A throwaway artifact: {relPath: contents}. */
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "precache-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

console.log("\nprecache generation");

test("lists every published file, './' first", () => {
  const dir = fixture({ "sw.js": SW_STUB, "index.html": "x", "main.js": "y" });
  const list = precacheList(dir);
  assert.equal(list[0], "./");
  assert.deepEqual(list, ["./", "./index.html", "./main.js"]);
});

test("never precaches the worker itself", () => {
  // A worker in its own cache is a worker that can outlive its own update.
  const dir = fixture({ "sw.js": SW_STUB, "index.html": "x" });
  assert.ok(!precacheList(dir).includes("./sw.js"));
});

test("never precaches dotfiles", () => {
  // addAll() is all-or-nothing: one .DS_Store 404 takes the whole cache down.
  const dir = fixture({ "sw.js": SW_STUB, "index.html": "x", "assets/.DS_Store": "junk" });
  assert.ok(!precacheList(dir).some((e) => e.includes(".DS_Store")));
});

test("content-hashed bundle names need no declaration", () => {
  // The case a hand-kept list structurally cannot serve: the name changes
  // every build, so it was simply never listed.
  const dir = fixture({ "sw.js": SW_STUB, "index.html": "x", "assets/index-A1b2C3.js": "y" });
  assert.ok(precacheList(dir).includes("./assets/index-A1b2C3.js"));
});

test("exclusions: exact path, dir/ prefix, *.ext suffix", () => {
  assert.ok(isExcluded("LICENSE", ["LICENSE"]));
  assert.ok(isExcluded("plans/x/y.md", ["plans/"]));
  assert.ok(isExcluded("README.md", ["*.md"]));
  assert.ok(!isExcluded("plans-of-record.js", ["plans/"]));
  assert.ok(!isExcluded("markdown.js", ["*.md"]));
});

console.log("\ninjection into sw.js");

test("rewrites only the generated region", () => {
  const dir = fixture({ "sw.js": SW_STUB, "index.html": "x", "main.js": "y" });
  injectPrecache(dir);
  const out = fs.readFileSync(path.join(dir, "sw.js"), "utf8");
  assert.ok(out.includes("'./main.js',"), "wrote the new entry");
  assert.ok(out.startsWith("const APP_VERSION = '0.0.0';"), "left the version line alone");
  assert.ok(out.includes("self.addEventListener('install'"), "left the body alone");
});

test("preserves the APP_VERSION line CI rewrites", () => {
  // Re-indenting or re-quoting that line silently disables fleet CI's
  // anchored sed, which is how a deploy once reached no returning player.
  const dir = fixture({ "sw.js": SW_STUB, "index.html": "x" });
  injectPrecache(dir);
  const out = fs.readFileSync(path.join(dir, "sw.js"), "utf8");
  assert.match(out, /^const APP_VERSION = '[^']*';$/m);
});

test("is idempotent — a second run reproduces the first", () => {
  const dir = fixture({ "sw.js": SW_STUB, "index.html": "x", "main.js": "y" });
  injectPrecache(dir);
  const once = fs.readFileSync(path.join(dir, "sw.js"), "utf8");
  injectPrecache(dir);
  assert.equal(fs.readFileSync(path.join(dir, "sw.js"), "utf8"), once);
});

test("refuses a worker with no generated region", () => {
  // Silently skipping would ship a stale hand-list forever, looking adopted.
  const dir = fixture({ "sw.js": "const ASSETS = [];", "index.html": "x" });
  assert.throws(() => injectPrecache(dir), /no generated precache region/);
});

test("an artifact with no worker is not an error", () => {
  const dir = fixture({ "index.html": "x" });
  assert.equal(injectPrecache(dir), null);
});

console.log("\nthe artifact assertion");

test("a published-but-uncached file fails verification by name", () => {
  // The whole point. Before this, an artifact could publish a file no worker
  // cached and every gate stayed green — the game worked online and broke on
  // a plane, which is the one condition CI never runs in.
  const dir = fixture({ "sw.js": SW_STUB, "index.html": "x", "orphan.js": "y" });
  const bad = verify(dir);
  assert.ok(bad.some((m) => m.includes("orphan.js") && m.includes("never caches it")),
    `expected orphan.js to be named; got: ${JSON.stringify(bad)}`);
});

test("injecting first makes that same artifact verify clean", () => {
  const dir = fixture({ "sw.js": SW_STUB, "index.html": "x", "orphan.js": "y" });
  injectPrecache(dir);
  assert.deepEqual(verify(dir).filter((m) => m.includes("never caches it")), []);
});

test("an excluded file is allowed to go uncached", () => {
  // This repo's PRECACHE_EXCLUDE carries "*.md" — prose ships, uncached.
  const dir = fixture({ "sw.js": SW_STUB, "index.html": "x", "README.md": "y" });
  assert.deepEqual(verify(dir).filter((m) => m.includes("never caches it")), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
