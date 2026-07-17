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
import { readFileSync, existsSync } from 'node:fs';
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

console.log('Repo drift gates — precache completeness + catalog schema (no browser)');
gateA();
gateB();
console.log(`\n${fail ? `${fail} check(s) FAILED.` : `All ${pass} repo-gate checks passed.`}`);
process.exit(fail ? 1 : 0);
