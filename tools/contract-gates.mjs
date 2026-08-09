/* contract-gates.mjs — the fleet's §5/§6d power-saver contract, as CI gates.
 *
 * Launcher-owned, run by fleet-ci.yml against EVERY caller's checkout. Three
 * gates, consolidating what three game repos each wrote a partial copy of:
 *
 *   Gate A — §6d: nothing declares an infinite CSS animation.
 *   Gate B — §5:  every declared animation-iteration-count is `1` or rides
 *                 var(--arcade-pulse-count, 3) — per comma-separated value.
 *   Gate C — §5:  every powerSaver() read is guarded, because an unguarded one
 *                 throws TypeError on a pre-3.13 vendored SDK — and inside an
 *                 onSettingsChange handler that is a throw on every launcher
 *                 settings write, not merely once at startup.
 *
 * Zero dependencies, no browser, no network — the same posture as
 * repo-gates-unit.mjs. Node reads the target's own `git ls-files`, so an
 * untracked sibling checkout (the .launcher-gates copy fleet-ci makes) is
 * never scanned as if it were the app.
 *
 *   node tools/contract-gates.mjs [targetDir]     # default: cwd
 *   node tools/contract-gates.mjs --self-test     # the fixtures, both ways
 *
 * ── Why the scanning is fussier than it looks ────────────────────────────────
 * Every one of these was a real false positive found on a real fleet repo, not
 * a hypothetical:
 *
 *   · A gate that greps a whole file for a pattern also matches that pattern
 *     quoted in a comment ABOUT the pattern. Three repos document the rule in
 *     prose sitting right next to the code that obeys it. So the gates never
 *     read raw source — they read a MASK of it, in which everything that is
 *     not the language being checked is blanked to spaces (newlines kept, so
 *     reported line numbers stay true).
 *   · The CSS gates must not read <script> blocks, and the JS gate must not
 *     read <style> blocks — an HTML file is both languages at once, and each
 *     gate's own pattern appears in prose inside the other's territory.
 *   · Two apps ship their entire game inside index.html. A JS gate scoped to
 *     '*.js' misses them completely and passes vacuously, which is the one
 *     failure mode a gate must never have.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Dev-set exclusions. Gate C's crash risk is SHIPPED code only: test files
// legitimately call powerSaver() unguarded against fakes, and this repo's own
// acceptance suite carries four unguarded reads inside browser-eval strings.
// Matched per path SEGMENT, not just at the root — nested tests/ directories
// are common enough that a root-only check would turn them red for no reason.
const DEV_SEGMENTS = new Set([
    'tests', 'test', '__tests__', 'spec', 'tools', 'scripts', 'docs',
    '.github', '.claude', 'node_modules',
]);
const isDev = (p) => p.split('/').some((seg) => DEV_SEGMENTS.has(seg));

// ---------------------------------------------------------------------------
// masking
// ---------------------------------------------------------------------------

/** Same length, same newlines, no content — so offsets and line numbers hold. */
const blank = (s) => s.replace(/[^\n]/g, ' ');

const lineOf = (text, index) => {
    let n = 1;
    for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
};

/** Blank every /* … *​/ comment in a CSS-shaped string. */
function maskCssComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, blank);
}

/**
 * The CSS a file actually declares, as a mask of the original.
 * For .css that is the whole file minus comments. For .html it is the interior
 * of <style> elements plus the value of every inline style="" attribute —
 * <script> is deliberately not CSS and is left blank.
 */
function cssMask(file, src) {
    if (file.endsWith('.css')) return maskCssComments(src);
    const out = blank(src).split('');
    const keep = (start, text) => {
        for (let i = 0; i < text.length; i++) out[start + i] = text[i];
    };
    for (const m of src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
        keep(m.index + m[0].indexOf(m[1], m[0].indexOf('>')), m[1]);
    }
    // An inline style attribute can carry a full `animation:` shorthand, so it
    // is a real place a violation could hide from a <style>-only scan.
    for (const m of src.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        const val = m[1] !== undefined ? m[1] : m[2];
        keep(m.index + m[0].lastIndexOf(val), val);
    }
    return maskCssComments(out.join(''));
}

/**
 * Blank JS comments while respecting string and template literals, so a URL's
 * "https://" is not mistaken for a line comment. Regex literals are the one
 * ambiguity left standing (`/` is division or a literal depending on context);
 * a regex containing `//` or `/*` would confuse this, and none in the fleet do.
 */
function maskJsComments(js) {
    const out = js.split('');
    let i = 0;
    const n = js.length;
    while (i < n) {
        const c = js[i];
        if (c === '/' && js[i + 1] === '/') {
            while (i < n && js[i] !== '\n') out[i++] = ' ';
        } else if (c === '/' && js[i + 1] === '*') {
            const end = js.indexOf('*/', i + 2);
            const stop = end === -1 ? n : end + 2;
            while (i < stop) { if (js[i] !== '\n') out[i] = ' '; i++; }
        } else if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            i++;
            while (i < n) {
                if (js[i] === '\\') { i += 2; continue; }
                if (js[i] === quote) { i++; break; }
                i++;
            }
        } else {
            i++;
        }
    }
    return out.join('');
}

/**
 * The JS a file actually executes, as a mask of the original. For .html that
 * is the interior of every <script> element that is not a data block — which
 * is the only reason the two index.html-only apps in the fleet get scanned at
 * all.
 */
function jsMask(file, src) {
    if (file.endsWith('.js') || file.endsWith('.mjs')) return maskJsComments(src);
    const out = blank(src).split('');
    for (const m of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        const attrs = m[1] || '';
        // <script type="application/json"> and friends are data, not code.
        const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
        const t = type ? (type[1] ?? type[2] ?? type[3] ?? '').toLowerCase() : '';
        if (t && !/javascript|module|^text\/babel$/.test(t)) continue;
        const body = m[2];
        const start = m.index + m[0].lastIndexOf(body);
        for (let k = 0; k < body.length; k++) out[start + k] = body[k];
    }
    return maskJsComments(out.join(''));
}

// ---------------------------------------------------------------------------
// value parsing
// ---------------------------------------------------------------------------

/** Split on top-level commas only — var(--arcade-pulse-count, 3) has one inside. */
function splitTopLevel(value) {
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 0) { parts.push(value.slice(start, i)); start = i + 1; }
    }
    parts.push(value.slice(start));
    return parts.map((p) => p.trim().replace(/\s+/g, ' ')).filter((p) => p.length);
}

const ONE = /^1(?:\s+!important)?$/;
const TOKEN = /^var\(\s*--arcade-pulse-count\s*,\s*3\s*\)(?:\s+!important)?$/;

// ---------------------------------------------------------------------------
// the gates
// ---------------------------------------------------------------------------

const RE_INFINITE = /animation(?:-iteration-count)?\s*:[^;}]*\binfinite\b/g;
const RE_COUNT = /animation-iteration-count\s*:\s*([^;}]*)/g;
const RE_CALL = /\.powerSaver\s*\(/g;

function gateA(file, css, report) {
    for (const m of css.matchAll(RE_INFINITE)) {
        report(file, lineOf(css, m.index),
            'infinite CSS animation — §6d, "let the screen rest". Nothing may loop '
            + 'forever on a visible, idle screen. Bound the effect with '
            + 'animation-iteration-count: var(--arcade-pulse-count, 3) and settle it '
            + 'onto a resting treatment that still says the same thing — a colour, a '
            + 'border, a static glow. Check where your keyframes\' 100% stop actually '
            + 'lands: a pulse that settles at its dim trough disappears.');
    }
}

function gateB(file, css, report) {
    for (const m of css.matchAll(RE_COUNT)) {
        for (const value of splitTopLevel(m[1])) {
            if (ONE.test(value) || TOKEN.test(value)) continue;
            report(file, lineOf(css, m.index),
                `animation-iteration-count value \`${value}\` is neither 1 nor `
                + 'var(--arcade-pulse-count, 3) — §5. Attention pulses ride the token so '
                + 'the player\'s power-saver setting reaches them (3 normally, 1 saving, '
                + '0 under reduced motion); a hard-coded count opts the effect out of the '
                + 'lever entirely.\n'
                + '      Declare it as the LONGHAND, never inside the `animation` '
                + 'shorthand: a var() in the shorthand becomes a pending-substitution '
                + 'value — invisible to CSSOM, and one bad token kills the whole '
                + 'animation rather than just the count.\n'
                + '      Each comma-separated value is checked on its own, so a stacked '
                + 'list like `1, var(--arcade-pulse-count, 3)` is fine.');
        }
    }
}

/** The receiver expression immediately left of `.powerSaver(`. */
function receiverBefore(js, dotIndex) {
    let i = dotIndex;
    let seen = '';
    for (;;) {
        let j = i;
        while (j > 0 && /\s/.test(js[j - 1])) j--;
        let k = j;
        while (k > 0 && /[A-Za-z0-9_$]/.test(js[k - 1])) k--;
        if (k === j) break;                       // no identifier here
        seen = js.slice(k, j) + (seen ? '.' + seen : '');
        let p = k;
        while (p > 0 && /\s/.test(js[p - 1])) p--;
        if (js[p - 1] !== '.') break;             // chain ends
        i = p - 1;
    }
    return seen;
}

function gateC(file, js, report) {
    // How much context counts as "nearby". The widest real guard in the fleet
    // spans a three-line `typeof … === 'function' && …` expression; 400 chars
    // covers that with room, and is tight enough that an unrelated guard on a
    // different call site does not launder this one.
    const WINDOW = 400;
    for (const m of js.matchAll(RE_CALL)) {
        const recv = receiverBefore(js, m.index);
        if (!recv) continue;                       // e.g. `(x).powerSaver()`
        const esc = recv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const from = Math.max(0, m.index - WINDOW);
        const around = js.slice(from, m.index + WINDOW);
        const truthy = new RegExp(esc + '\\s*\\.\\s*powerSaver\\s*(?:\\?|&&|\\|\\||\\))');
        const typeofGuard = new RegExp(
            'typeof\\s+' + esc + '\\s*\\.\\s*powerSaver\\s*[!=]==?\\s*[\'"`]function[\'"`]');
        if (truthy.test(around) || typeofGuard.test(around)) continue;
        report(file, lineOf(js, m.index),
            `unguarded \`${recv}.powerSaver()\` — §5. Arcade.settings.powerSaver landed in `
            + 'SDK 3.13.0; on anything older the property is undefined and calling it '
            + 'throws TypeError. Inside an onSettingsChange handler that is a throw on '
            + 'EVERY launcher settings write, not once at startup, so a repo on a '
            + 'vendored pre-3.13 SDK breaks the moment a player changes any setting.\n'
            + `      Guard the read on the same receiver: \`${recv}.powerSaver ? `
            + `${recv}.powerSaver() : false\`, or \`typeof ${recv}.powerSaver === `
            + "'function' && …\`. An older SDK then degrades to \"not saving\".\n"
            + '      The CSS half needs no guard — var(--arcade-pulse-count, 3) carries '
            + 'its own fallback.');
    }
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

function trackedFiles(dir, patterns) {
    try {
        return execFileSync('git', ['ls-files', '-z', '--', ...patterns],
            { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
            .split('\0').filter(Boolean);
    } catch (e) {
        console.error(`contract-gates: cannot enumerate tracked files in ${dir}\n${e.message}`);
        process.exit(2);
    }
}

/** Run all three gates over one file's source. Shared by the driver and the
 *  self-test, so the fixtures exercise the same code path the fleet does. */
function gateFile(rel, src, report) {
    if (/\.(css|html?)$/i.test(rel)) {
        const css = cssMask(rel, src);
        gateA(rel, css, report);
        gateB(rel, css, report);
    }
    if (/\.(js|mjs|html?)$/i.test(rel)) {
        gateC(rel, jsMask(rel, src), report);
    }
}

export function runGates(dir) {
    const findings = [];
    const report = (file, line, message) => findings.push({ file, line, message });

    // This repo's own fixtures are deliberate violations. They live under
    // tools/, which the dev set already excludes — the generalized form of the
    // lesson a fleet repo learned by writing a gate that matched the pattern
    // quoted inside its own regex.
    const files = trackedFiles(dir, ['*.css', '*.html', '*.htm', '*.js', '*.mjs'])
        .filter((f) => !isDev(f));
    for (const f of files) gateFile(f, readFileSync(path.join(dir, f), 'utf8'), report);

    return { findings, scanned: files.length };
}

// ---------------------------------------------------------------------------
// self-test — a gate that cannot fail is worth nothing
// ---------------------------------------------------------------------------

const FIXTURES = path.join(HERE, 'fixtures', 'contract-gates');

function selfTest() {
    let pass = 0, fail = 0;
    const ok = (cond, label, detail = '') => {
        if (cond) { pass++; console.log('  ✓ ' + label); }
        else { fail++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
    };

    // Read from disk, not from `git ls-files`: a fixture someone forgets to
    // `git add` would otherwise vanish from the self-test silently, which is
    // the same class of hole as a gate that cannot fail.
    const list = (sub) => readdirSync(path.join(FIXTURES, sub))
        .filter((f) => /\.(css|html?|js|mjs)$/i.test(f)).sort();

    const scan = (sub, name) => {
        const file = path.join(FIXTURES, sub, name);
        const found = [];
        gateFile(name, readFileSync(file, 'utf8'),
            (f, line, message) => found.push({ line, message }));
        return found;
    };

    console.log('\nMust PASS — every idiom the fleet actually ships');
    const passing = list('pass');
    ok(passing.length >= 5, `the pass corpus is populated (${passing.length} fixtures)`);
    for (const f of passing) {
        const found = scan('pass', f);
        ok(found.length === 0, `clean: pass/${f}`,
            found.map((x) => `line ${x.line}: ${x.message.split('\n')[0]}`).join('\n      '));
    }

    // Each fail fixture is named for the gate it must trip, so "something
    // failed" is never mistaken for "the right thing failed" — a Gate B typo
    // in a Gate A fixture would otherwise read as a pass.
    console.log('\nMust FAIL — a planted violation per gate');
    const failing = list('fail');
    for (const gate of ['a', 'b', 'c']) {
        ok(failing.some((f) => f.startsWith(`gate-${gate}-`)),
            `a planted violation exists for Gate ${gate.toUpperCase()}`);
    }
    for (const f of failing) {
        const want = /^gate-([abc])-/.exec(f);
        const found = scan('fail', f);
        if (!want) { ok(false, `fail/${f} is not named gate-<a|b|c>-…`); continue; }
        const gate = want[1].toUpperCase();
        const hits = found.filter((x) => x.message.includes(GATE_MARK[gate]));
        ok(hits.length > 0, `Gate ${gate} catches fail/${f}`,
            found.length
                ? `${found.length} finding(s), but none from Gate ${gate}`
                : 'the planted violation was not detected at all');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    return fail === 0;
}

/** A phrase unique to each gate's message, so the self-test can tell them apart. */
const GATE_MARK = {
    A: 'infinite CSS animation',
    B: 'is neither 1 nor',
    C: 'unguarded',
};

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) {
    process.exit(selfTest() ? 0 : 1);
}

const target = path.resolve(argv[0] || '.');
if (!existsSync(target)) {
    console.error(`contract-gates: no such directory: ${target}`);
    process.exit(2);
}

const { findings, scanned } = runGates(target);

console.log(`\nfleet contract gates — §5/§6d — ${path.basename(target)}`);
console.log(`  ${scanned} tracked file(s) scanned`);

// Nothing to scan is not a pass. Every fleet app tracks CSS, HTML or JS, so an
// empty enumeration means the gate was pointed somewhere wrong — a checkout
// that silently failed, a path typo in the pipeline, a submodule that was never
// initialised. Reporting three green gates there is exactly the vacuous pass
// this whole file exists to avoid; exit 2 to distinguish it from a violation.
if (scanned === 0) {
    console.error(
        '\n  ✗ no tracked .css/.html/.js/.mjs files found — refusing to report a pass.\n'
        + `      Is ${target} the right directory, and is it a git checkout with files in it?`);
    process.exit(2);
}
if (findings.length === 0) {
    console.log('  ✓ Gate A: no infinite CSS animations');
    console.log('  ✓ Gate B: every iteration count is 1 or rides --arcade-pulse-count');
    console.log('  ✓ Gate C: every powerSaver() read is guarded');
    process.exit(0);
}
console.log('');
for (const f of findings) console.log(`  ✗ ${f.file}:${f.line}\n      ${f.message}`);
console.log(`\n${findings.length} contract violation(s). `
    + 'These gates live in the launcher (tools/contract-gates.mjs) and run for every '
    + 'fleet-ci caller; see GAME_INTEGRATION.md §5 and §6d.');
process.exit(1);
