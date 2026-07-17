/* check-sw-bump.mjs — CI gate: a change to any precached asset must bump
 * sw.js's CACHE_NAME in the same change set.
 *
 * The bump is what makes the service worker's activate-time cleanup drop the
 * old cache; forgetting it has shipped stale JS to returning users twice
 * (the runtime network-first cache papers over it for online users, but the
 * activate-time cleanup never runs). This turns the convention into a gate.
 *
 * Base resolution (first that works): argv[2] → $SW_BUMP_BASE →
 * origin/main → HEAD~1. If none resolves (shallow clone, fresh repo) the
 * check SKIPS with a note rather than failing — it is a diff gate, not a
 * unit test, which is also why it is not named *-unit.mjs (run-units.mjs
 * must stay green on a checkout with no git history).
 *
 * Run: `node tools/check-sw-bump.mjs [base-ref]`.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(...args) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function resolveBase() {
    const candidates = [process.argv[2], process.env.SW_BUMP_BASE, 'origin/main', 'HEAD~1'].filter(Boolean);
    for (const ref of candidates) {
        try { git('rev-parse', '--verify', '--quiet', ref + '^{commit}'); return ref; }
        catch (e) { /* try next */ }
    }
    return null;
}

const base = resolveBase();
if (!base) {
    console.log('check-sw-bump: no usable base ref (shallow clone?) — SKIPPED');
    process.exit(0);
}

let changed;
try { changed = git('diff', '--name-only', base + '...HEAD').split('\n').filter(Boolean); }
catch (e) {
    // A...B needs a merge base; fall back to a plain two-dot diff.
    changed = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
}
// Uncommitted work counts too (useful locally before committing).
for (const f of git('diff', '--name-only', 'HEAD').split('\n').filter(Boolean)) {
    if (!changed.includes(f)) changed.push(f);
}

const sw = readFileSync(resolve(ROOT, 'sw.js'), 'utf8');
const listMatch = /const ASSETS_TO_CACHE = \[([\s\S]*?)\];/.exec(sw);
const precached = new Set();
if (listMatch) {
    let m;
    const entryRe = /['"]\.\/([^'"]+)['"]/g;
    while ((m = entryRe.exec(listMatch[1])) !== null) precached.add(m[1]);
}
precached.add('sw.js'); // editing the SW itself also requires a bump

const touchedPrecached = changed.filter((f) => precached.has(f) && f !== 'sw.js');
const nameNow = (/const CACHE_NAME = '([^']+)'/.exec(sw) || [])[1];
let nameBase = null;
try { nameBase = (/const CACHE_NAME = '([^']+)'/.exec(git('show', base + ':sw.js')) || [])[1]; }
catch (e) { /* sw.js absent at base — any name counts as a bump */ }

if (!touchedPrecached.length) {
    console.log(`check-sw-bump: no precached asset changed vs ${base} — OK`);
    process.exit(0);
}
if (nameNow && nameNow !== nameBase) {
    console.log(`check-sw-bump: ${touchedPrecached.length} precached asset(s) changed and CACHE_NAME bumped (${nameBase || 'none'} → ${nameNow}) — OK`);
    process.exit(0);
}
console.error(`check-sw-bump: FAILED — these precached assets changed vs ${base} without a CACHE_NAME bump (still '${nameNow}'):`);
for (const f of touchedPrecached) console.error('  - ' + f);
console.error("Bump CACHE_NAME in sw.js (e.g. v34 → v35) so returning users' activate-time cleanup drops the stale cache.");
process.exit(1);
