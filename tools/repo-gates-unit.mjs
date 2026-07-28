/* repo-gates-unit.mjs — static drift gates for the hand-maintained lists.
 *
 * The repo's recurring failure class is a hand-maintained list drifting from
 * the code it mirrors (the sw.js precache list has shipped stale twice; the
 * catalog is only exercised by a live render test). These gates turn that
 * silent drift into a loud unit-tier failure, without a build step:
 *
 *   Gate A — service-worker precache completeness: every same-origin JS
 *            module statically reachable from index.html / profile.html
 *            (static imports, re-exports, and dynamic import('./…') literals,
 *            followed transitively) must appear in sw.js ASSETS_TO_CACHE.
 *   Gate B — catalog.json schema: required fields, unique ids, root-relative
 *            urls, icons that exist on disk — checked without a browser, so
 *            a malformed entry fails CI before the render-test tier.
 *
 * No browser, no network. Run: `node tools/repo-gates-unit.mjs`.
 * (The companion CACHE_NAME-bump check needs a git base to diff against and
 * lives in tools/check-sw-bump.mjs — CI-only by nature.)
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

// ---- Gate A: SW precache completeness ----

// Repo-relative ('./x.js' style, no leading './') specifiers found in a
// source string: static imports/re-exports plus dynamic import('…') literals.
function importSpecifiers(source) {
    const out = new Set();
    const patterns = [
        /(?:^|[^\w.])import\s+[^'"]*?from\s*['"](\.\.?\/[^'"]+)['"]/g,
        /(?:^|[^\w.])import\s*['"](\.\.?\/[^'"]+)['"]/g,
        /(?:^|[^\w.])export\s+[^'"]*?from\s*['"](\.\.?\/[^'"]+)['"]/g,
        /(?:^|[^\w.$])import\(\s*['"](\.\.?\/[^'"]+)['"]/g
    ];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(source)) !== null) out.add(m[1]);
    }
    return out;
}

// BFS over the static module graph starting from the specifiers embedded in
// an HTML file, tracking each module's repo-relative path.
function reachableModules(htmlFiles) {
    const queue = [];
    const seen = new Set();
    for (const html of htmlFiles) {
        const src = readFileSync(join(ROOT, html), 'utf8');
        for (const spec of importSpecifiers(src)) {
            const rel = spec.replace(/^\.\//, '');
            if (!seen.has(rel)) { seen.add(rel); queue.push(rel); }
        }
        // <script src="…"> same-origin references count too.
        let m;
        const tagRe = /<script[^>]*\bsrc=["'](?!https?:)([^"']+\.js)["']/g;
        while ((m = tagRe.exec(src)) !== null) {
            const rel = m[1].replace(/^\.?\//, '');
            if (!seen.has(rel)) { seen.add(rel); queue.push(rel); }
        }
    }
    while (queue.length) {
        const rel = queue.shift();
        const abs = join(ROOT, rel);
        if (!existsSync(abs)) continue; // missing files reported separately
        const dir = dirname(rel);
        for (const spec of importSpecifiers(readFileSync(abs, 'utf8'))) {
            // Resolve './x' / '../x' against the importing module's directory.
            const next = join(dir === '.' ? '' : dir, spec).replace(/\\/g, '/').replace(/^\.\//, '');
            if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
    }
    return seen;
}

function precacheList() {
    const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
    const m = /const ASSETS_TO_CACHE = \[([\s\S]*?)\];/.exec(sw);
    if (!m) return null;
    const entries = new Set();
    let e;
    const entryRe = /['"]\.\/([^'"]+)['"]/g;
    while ((e = entryRe.exec(m[1])) !== null) entries.add(e[1]);
    return entries;
}

function gateA() {
    console.log('\nGate A — sw.js precache covers every reachable launcher module');
    const precache = precacheList();
    ok(!!precache && precache.size > 0, 'sw.js ASSETS_TO_CACHE parsed');
    if (!precache) return;
    const reachable = reachableModules(['index.html', 'profile.html']);
    ok(reachable.size > 0, `module graph walked (${reachable.size} reachable files)`);
    for (const rel of [...reachable].sort()) {
        ok(existsSync(join(ROOT, rel)), `referenced module exists on disk: ${rel}`);
        ok(precache.has(rel), `precached: ${rel}`);
    }
    // The SDK is loaded by game pages rather than imported by the launcher,
    // so the graph walk can't see it — pin it explicitly.
    ok(precache.has('arcade-sdk.js'), 'precached: arcade-sdk.js (game-loaded, pinned explicitly)');
    for (const rel of [...precache].sort()) {
        if (!/\.(js|css|json|html|png)$/.test(rel)) continue;
        ok(existsSync(join(ROOT, rel)), `precache entry exists on disk: ${rel}`);
    }
}

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
        if (g.icon !== undefined) {
            ok(typeof g.icon === 'string' && existsSync(join(ROOT, g.icon)),
                `icon exists on disk: ${label} (${g.icon})`);
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

console.log('Repo drift gates — precache completeness + catalog schema (no browser)');
gateA();
gateB();
gateC();
console.log(`\n${fail ? `${fail} check(s) FAILED.` : `All ${pass} repo-gate checks passed.`}`);
process.exit(fail ? 1 : 0);
