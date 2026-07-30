// The whole CI tier, in one command: `npm test`.
//
// This used to live as ~20 enumerated steps inside pages.yml, which meant CI
// was the only place it could run and the workflow was the only place it was
// written down. It is a script now so the fleet's thin caller
// (GAME_INTEGRATION §13a) can gate this repo the same way it gates every
// game — `npm test` is the gate everywhere — and so a laptop can run exactly
// what CI runs.
//
// Usage:
//   node tools/run-ci.mjs             # everything
//   node tools/run-ci.mjs p2p sync    # only stages matching a substring
//   SKIP_BROWSER=1 node tools/run-ci.mjs   # syntax + units only
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

// Real-WebRTC negotiation is timing-sensitive under headless CI; a suite that
// negotiates retries so a transient hiccup doesn't fail the run. A genuine
// regression fails all attempts.
//
// DETECTED, not enumerated — the same rule the artifact verifier follows. The
// property that earns a retry is "drives peer connections through the shared
// P2P harness", and the import is that property, so it is the test. A
// hand-kept list drifts silently in the direction that hurts: it was five
// names while NINE suites sat on the harness, so the four unlisted ones ran
// with zero retries purely because nobody remembered to add them.
const HARNESS = "lib/p2p-test-harness.mjs";
const negotiates = (file) =>
  fs.readFileSync(path.join(ROOT, "tools", file), "utf8").includes(HARNESS);

// Suites that run locally but not in CI, each with the evidence for why.
// This is enumeration-with-a-reason, which is different from the FLAKY list
// this file used to carry: that was a drifting cache of a detectable property;
// this is a decision, and the reason is the entry. An entry with a fixed
// underlying cause gets deleted, not kept.
const MANUAL_ONLY = new Map([
  ["p2p-multiparty-acceptance.mjs",
    "M8's relayed-identity-gossip wait times out on CI runners: device A sees " +
    "indirect={} after 20s, 3/3 attempts (four Chromium instances on a 2-core " +
    "runner), while the suite passes locally in ~11s. Until the gossip-under-" +
    "load behavior is investigated, run it by hand: npm run p2p-multiparty"],
]);

// Suites that need arguments rather than a bare invocation.
const WITH_ARGS = {
  "acceptance.mjs:pool": ["tools/acceptance.mjs", "--pool", "--serve",
    "--catalog", "tools/fixtures/ci-catalog.json"],
  "acceptance.mjs:per-game": ["tools/acceptance.mjs", "--serve",
    "--catalog", "tools/fixtures/pergame-catalog.json",
    "--mount", "starter-app=tools/fixtures/starter-app",
    "http://127.0.0.1:4799/starter-app/"],
};

const filters = process.argv.slice(2);
const wanted = (name) => !filters.length || filters.some((f) => name.includes(f));
const results = [];

function run(name, argv, { retries = 0 } = {}) {
  if (!wanted(name)) return;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    process.stdout.write(`\n===== ${name}${attempt > 1 ? ` (attempt ${attempt})` : ""} =====\n`);
    const r = spawnSync(node, argv, { cwd: ROOT, stdio: "inherit" });
    if (r.status === 0) { results.push([name, "pass"]); return; }
    if (attempt === retries + 1) { results.push([name, "FAIL"]); return; }
    process.stdout.write(`${name} failed; retrying\n`);
  }
}

// ---- syntax: every tracked JS/MJS must parse -------------------------------
if (wanted("syntax")) {
  process.stdout.write("\n===== syntax =====\n");
  const files = execFileSync("git", ["ls-files", "-z", "*.js", "*.mjs"],
    { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  let bad = 0;
  for (const f of files) {
    if (spawnSync(node, ["--check", f], { cwd: ROOT }).status !== 0) {
      console.error(`  FAIL ${f}`); bad++;
    }
  }
  console.log(`  ${files.length - bad}/${files.length} parse`);
  results.push(["syntax", bad ? "FAIL" : "pass"]);
}

// ---- the deploy artifact (identical gate fleet-wide) -----------------------
run("deploy-artifact", ["tools/verify-artifact.mjs"]);

// ---- unit tier: discovered, no browser ------------------------------------
run("units", ["tools/run-units.mjs"]);

// ---- service-worker cache-version gate ------------------------------------
// RETIRED. This ran tools/check-sw-bump.mjs, which failed a PR that touched a
// precached asset without hand-bumping sw.js's CACHE_NAME. The gate existed
// only because the version was hand-maintained; fleet CI now rewrites
// APP_VERSION on every deploy, so the bump can no longer be forgotten and
// there is nothing left for a diff gate to catch.
//
// What replaced it is not nothing: repo-gates-unit.mjs Gate D asserts sw.js
// still declares APP_VERSION in exactly the form CI's sed targets, and derives
// CACHE_NAME from it. That is the invariant that actually matters — if the
// line stops matching, the rewrite stops firing silently, which is precisely
// how a green deploy once reached no returning player at all. A shape
// assertion catches that; a bump-diff never could.

// ---- acceptance tier ------------------------------------------------------
if (!process.env.SKIP_BROWSER) {
  for (const [key, argv] of Object.entries(WITH_ARGS)) run(key, argv);

  // Discovery, not enumeration: a new tools/<thing>-acceptance.mjs runs here
  // with no edit to this file or the workflow.
  const suites = fs.readdirSync(path.join(ROOT, "tools"))
    .filter((f) => f.endsWith("-acceptance.mjs"))
    .sort();
  for (const f of suites) {
    if (process.env.CI && MANUAL_ONLY.has(f)) { results.push([f, "skipped"]); continue; }
    run(f, [`tools/${f}`], { retries: negotiates(f) ? 2 : 0 });
  }
} else {
  console.log("\nSKIP_BROWSER set — acceptance tier skipped");
}

// ---- report ---------------------------------------------------------------
const failed = results.filter(([, s]) => s === "FAIL");
const skipped = results.filter(([, s]) => s === "skipped");
console.log("\n" + "=".repeat(72));
console.log(`${results.length - failed.length - skipped.length} passed, ${failed.length} failed` +
  (skipped.length ? `, ${skipped.length} manual-only (skipped in CI)` : ""));
for (const [n] of skipped) console.log(`  manual-only: ${n} — ${MANUAL_ONLY.get(n)}`);
for (const [n] of failed) console.log(`  FAILED:  ${n}`);
process.exit(failed.length ? 1 : 0);
