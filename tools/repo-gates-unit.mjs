/* repo-gates-unit.mjs — static drift gates for the hand-maintained lists.
 *
 * The repo's recurring failure class is a hand-maintained list drifting from
 * the code it mirrors (the sw.js precache list has shipped stale twice; the
 * catalog is only exercised by a live render test). These gates turn that
 * silent drift into a loud unit-tier failure, without a build step:
 *
 *   Gate A — RETIRED; the precache list is generated from the artifact now.
 *            See the note where it used to live.
 *   Gate B — catalog.json schema: required fields, unique ids, root-relative
 *            urls, icons that exist on disk — checked without a browser, so
 *            a malformed entry fails CI before the render-test tier.
 *   Gate D — service-worker version/cleanup shape: the APP_VERSION line still
 *            matches what fleet CI's sed rewrites, CACHE_NAME derives from it,
 *            and activate-time cleanup is filtered to this app's own prefix.
 *
 * No browser, no network. Run: `node tools/repo-gates-unit.mjs`.
 * (Gate D replaced tools/check-sw-bump.mjs, the diff gate that required a
 * hand bump of CACHE_NAME. CI owns the version now, so the bump cannot be
 * forgotten — but the rewrite can stop matching, which is what D catches.)
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}

// ---- Gate A: RETIRED ----
//
// Gate A walked index.html's module graph and asserted every reachable module
// appeared in sw.js's precache array. It existed because that array was
// hand-maintained and had shipped stale twice.
//
// The array is generated now, at stage time, from the artifact that actually
// deploys (tools/inject-precache.mjs), so the checked-in list is a placeholder
// and there is nothing left here for a static gate to read. What replaced it
// is stronger in both directions: verify-artifact.mjs asserts that every file
// the deploy publishes is either precached or named in PRECACHE_EXCLUDE, which
// covers images, fonts, JSON and content-hashed bundles — none of which a
// JS-import walk could ever see — and it asks the artifact rather than the
// checkout, so it also catches a file that staging drops.
//
// Gate A could only ever have caught a missing *statically imported module*.
// That is now a subset of a check that cannot be forgotten, because the list
// is not written by hand at all.

// ---- Gate B: catalog.json schema (catalogVersion 1) ----

const ID_RE = /^[a-z0-9][a-z0-9-]*$/; // must match arcade-catalog.js's ID_RE

function gateB() {
    console.log('\nGate B — catalog.json schema');
    let doc;
    try { doc = JSON.parse(readFileSync(join(ROOT, 'catalog.json'), 'utf8')); }
    catch (e) { ok(false, 'catalog.json parses: ' + e.message); return; }
    ok(doc.catalogVersion === 1, 'catalogVersion is 1');
    ok(Array.isArray(doc.games) && doc.games.length > 0, 'games[] is a non-empty array');
    if (!Array.isArray(doc.games)) return;
    const ids = new Set();
    for (const g of doc.games) {
        const label = (g && g.id) || JSON.stringify(g).slice(0, 40);
        ok(g && typeof g === 'object', `entry is an object: ${label}`);
        if (!g || typeof g !== 'object') continue;
        ok(typeof g.id === 'string' && ID_RE.test(g.id), `id is a lowercase slug: ${label}`);
        ok(!ids.has(g.id), `id is unique: ${label}`);
        ids.add(g.id);
        ok(typeof g.name === 'string' && g.name.length > 0, `name present: ${label}`);
        ok(typeof g.url === 'string' && g.url.startsWith('/') && g.url.endsWith('/'),
            `url is root-relative directory ('/${g.id}/'-style): ${label}`);
        ok(typeof g.subtitle === 'string', `subtitle present (may be empty): ${label}`);
        // Icons are served by the app that owns them ('/<gameId>/icon.png'), so
        // "exists on disk" is the wrong check — the file is in another repo by
        // design. What this repo can still guarantee is that the path is
        // root-relative and points inside the app's own mount, which is what
        // keeps a typo from silently resolving somewhere else on the origin.
        // Anything still served from this repo (launcher chrome) is checked as
        // before. Whether the app has actually deployed its icon is a runtime
        // fact no static gate can know; the launcher already degrades to a
        // text-only tile on a broken image.
        if (g.icon !== undefined) {
            ok(typeof g.icon === 'string' && g.icon.length > 0, `icon is a string: ${label}`);
            if (typeof g.icon === 'string') {
                if (g.icon.startsWith('/')) {
                    ok(g.icon.startsWith(`/${g.id}/`),
                        `icon is served from the app's own mount: ${label} (${g.icon})`);
                } else {
                    ok(existsSync(join(ROOT, g.icon)),
                        `launcher-hosted icon exists on disk: ${label} (${g.icon})`);
                }
            }
        }
        if (g.spotlight !== undefined) ok(typeof g.spotlight === 'boolean', `spotlight is boolean: ${label}`);
        if (g.profile !== undefined) {
            const p = g.profile;
            ok(p && typeof p === 'object' && !Array.isArray(p), `profile is an object: ${label}`);
            if (p && typeof p === 'object') {
                for (const f of ['name', 'subtitle', 'alt', 'descLead', 'descBody', 'kicker']) {
                    if (p[f] !== undefined) ok(typeof p[f] === 'string', `profile.${f} is a string: ${label}`);
                }
                if (p.tags !== undefined) {
                    ok(Array.isArray(p.tags) && p.tags.every((t) => typeof t === 'string'),
                        `profile.tags is a string array: ${label}`);
                }
                if (p.codeUrl !== undefined) {
                    ok(typeof p.codeUrl === 'string' && /^https:\/\//.test(p.codeUrl),
                        `profile.codeUrl is https: ${label}`);
                }
            }
        }
    }
}

// ---- Gate C: no fleet-game references outside catalog.json ----
//
// The framework must not know which games exist. catalog.json is the single
// sanctioned place a game id may appear — it is launcher configuration, read at
// runtime. Anywhere else (SDK, launcher modules, tooling, tests, docs, fixtures)
// a game id is a reverse dependency: it makes framework code, or a framework
// test, fail when a *game* is renamed or leaves the fleet.
//
// The id list is READ FROM the catalog rather than hardcoded, so a newly listed
// game is guarded with no edit here. TOMBSTONES covers ids that have left the
// catalog but whose stragglers should still be findable for one release.
//
// If a genuine need arises to name a game — it almost never does; prefer stating
// the behavior and linking that repo's issue — the honest fix is to add the file
// to ALLOW with a comment saying why, not to soften the pattern.

const TOMBSTONES = [];       // ids removed from the catalog within the last release
const ALLOW = new Set([
    'catalog.json',          // the sanctioned registry itself
]);
// Prefixes exempt because they are DATED RECORD, not living surface. History
// says what happened, and what happened involved named apps; rewriting it to
// remove the names would make it a worse record and no cleaner a framework.
// The rule for both: append-only. Nothing here is read at runtime, imported by
// framework code, or used to decide behavior — the moment one of these files
// starts driving something, it stops being a record and belongs under the gate.
const ALLOW_PREFIX = [
    'plans/',                // decision + remediation history, dated per round
    'sdk/CHANGELOG.md',      // release history
];

// Directories that are not framework surface at all.
const SKIP_DIRS = new Set(['node_modules', '.git', '.dev-stage', 'out', 'images', 'p2p']);
const SCAN_EXT = /\.(js|mjs|json|sh|html|css|md)$/;

function walk(dir, rel = '', acc = []) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith('.') && ent.name !== '.gitignore') continue;
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
            if (SKIP_DIRS.has(ent.name)) continue;
            walk(join(dir, ent.name), r, acc);
        } else if (SCAN_EXT.test(ent.name)) {
            acc.push(r);
        }
    }
    return acc;
}

function gateC() {
    console.log('\nGate C — no fleet-game references outside catalog.json');
    let doc;
    try { doc = JSON.parse(readFileSync(join(ROOT, 'catalog.json'), 'utf8')); }
    catch { ok(false, 'catalog.json parses (needed to derive the id list)'); return; }

    const ids = [...(doc.games || []).map((g) => g && g.id).filter(Boolean), ...TOMBSTONES];
    if (!ids.length) { ok(false, 'catalog has ids to check against'); return; }

    // Match the id as a whole token: an id must not fire inside a longer slug
    // that merely starts with it (`my-app` must not match `my-app-2`). \b is
    // wrong here because '-' is a non-word character, so \bmy-app\b matches
    // inside 'my-app-2'; hence the explicit non-[A-Za-z0-9-] bounds.
    const patterns = ids.map((id) => ({
        id,
        re: new RegExp(`(^|[^A-Za-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9-]|$)`, 'i')
    }));

    const offenders = [];
    for (const rel of walk(ROOT)) {
        if (ALLOW.has(rel) || ALLOW_PREFIX.some((p) => rel.startsWith(p))) continue;
        let src;
        try { src = readFileSync(join(ROOT, rel), 'utf8'); } catch { continue; }
        const hits = new Set();
        for (const { id, re } of patterns) {
            for (const line of src.split('\n')) if (re.test(line)) { hits.add(id); break; }
        }
        if (hits.size) offenders.push(`${rel} → ${[...hits].join(', ')}`);
    }

    ok(offenders.length === 0,
        `no catalog-game ids outside the allowlist${offenders.length ? ':\n      ' + offenders.join('\n      ') : ''}`);
}

// ---- Gate D: service-worker version + cleanup shape ----

// This is the CI contract, character for character. fleet-ci.yml guards with
// `grep -q "^const APP_VERSION = '"` and rewrites with a `^`-anchored sed, so
// re-indenting this line, switching to double quotes, or renaming the constant
// all turn the deploy-time rewrite into a silent no-op. Nothing fails; the
// cache name simply freezes, and every subsequent fix ships to an origin that
// no returning player re-fetches — a green deploy that reaches nobody.
const APP_VERSION_LINE = /^const APP_VERSION = '[^']*';$/m;

function gateD() {
    console.log('\nGate D — service-worker version + cleanup shape');
    const sw = readFileSync(resolve(ROOT, 'sw.js'), 'utf8');

    ok(APP_VERSION_LINE.test(sw),
        "sw.js declares APP_VERSION in the exact form fleet-ci.yml's sed targets");

    // Deliberately NOT an equality check against package.json. That version
    // was tried and false-failed every PR left open across a deploy, because
    // main auto-bumps underneath the branch. The shape is the invariant; the
    // value is CI's business.
    const prefix = (/^const CACHE_PREFIX = '([^']+)';$/m.exec(sw) || [])[1];
    ok(!!prefix, 'sw.js declares a CACHE_PREFIX');

    ok(/^const CACHE_NAME = `\$\{CACHE_PREFIX\}v\$\{APP_VERSION\}`;$/m.test(sw),
        'CACHE_NAME interpolates APP_VERSION rather than hardcoding a version');

    // The cross-game bug. caches.keys() is origin-scoped and the whole fleet
    // shares paulgibeault.github.io, so a bare `name !== CACHE_NAME` filter
    // deletes every sibling game's cache on each activation.
    const cleanup = /\.filter\(\((\w+)\) => \1\.startsWith\(CACHE_PREFIX\) && \1 !== CACHE_NAME\)/.test(sw);
    ok(cleanup, 'activate-time cleanup is filtered to CACHE_PREFIX (never deletes sibling apps\' caches)');

    // Without this the launcher's update control has nothing to talk to, and
    // a worker that installs correctly waits forever.
    ok(sw.includes("'arcade:sw.skipWaiting'"),
        'sw.js honours the arcade:sw.skipWaiting message the update control sends');
    ok(!/^\s*self\.skipWaiting\(\);/m.test(sw),
        'sw.js does not skipWaiting() unconditionally on install (that swaps the cache unannounced)');
}

// ---- Gate E: version_bump needs push permission ----

function gateE() {
    console.log('\nGate E — version_bump implies contents: write');
    let yml;
    try { yml = readFileSync(resolve(ROOT, '.github/workflows/pages.yml'), 'utf8'); }
    catch { ok(false, 'pages.yml is readable'); return; }

    const wantsBump = /^\s*version_bump:\s*true\s*$/m.test(yml);
    const canPush = /^\s*contents:\s*write\b/m.test(yml);

    // Learned the expensive way: the launcher opted into version_bump without
    // this, and the deploy job ran the whole bump, committed it, and THEN died
    // 403 on push. The test tier was green, the merge looked clean, and the
    // site simply never updated. A reusable workflow inherits the caller's
    // permissions, so the grant has to live here, next to the opt-in.
    ok(!wantsBump || canPush,
        'pages.yml enabling version_bump also grants `contents: write` ' +
        '(without it the bump commits and then fails to push, after tests pass)');
}

console.log('Repo drift gates — catalog schema + SW shape (no browser)');
gateB();
gateC();
gateD();
gateE();
console.log(`\n${fail ? `${fail} check(s) FAILED.` : `All ${pass} repo-gate checks passed.`}`);
process.exit(fail ? 1 : 0);
