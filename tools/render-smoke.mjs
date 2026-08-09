/* render-smoke.mjs — does this app actually put something on the screen?
 *
 * Launcher-owned, run by fleet-ci.yml against each caller's OWN staged dist/.
 * Every other gate in the fleet can be green while the product is a black
 * rectangle: unit suites cover pure logic and never touch a canvas,
 * verify-artifact.mjs proves every referenced file is published (a blank game
 * publishes perfectly), and `node --check` proves the JS parses (blank games
 * parse fine).
 *
 *   node tools/render-smoke.mjs <distDir> [options]
 *
 *     --hints <file>   per-app declaration (an app's own tools/smoke.mjs)
 *     --sdk <dir>      launcher checkout to overlay origin-level scripts from
 *     --label <name>   what to call the app in output
 *     --port <n>       defaults to 4801
 *     --warn           report a failure without failing the run (exit 0)
 *     --shot <file>    keep the screenshot, for looking at afterwards
 *
 * ── What it asserts, and what it deliberately does not ──────────────────────
 *
 * The assertion is on the SCREENSHOT BUFFER: the decoded pixels must be
 * non-trivially non-uniform. Not on rAF ticks, not on frame counters, not on a
 * paint-count hook. Those all read as zero under headless and hidden-page
 * conditions where the SDK is *correctly* suspending the game, which is the
 * single most likely way this check turns into runner weather — two blank-game
 * reports in this fleet were both measurement artifacts of exactly that, not
 * rendering failures.
 *
 * The same reasoning drives two things that look like over-caution:
 *
 *   · The page is brought to the front and given a real viewport, because a
 *     background tab reports `visibilityState === 'hidden'`, the SDK sets
 *     pageSuspended, and every conforming game in the fleet stops drawing. A
 *     harness that gets that wrong reports 100% breakage and gets ignored.
 *   · The launcher's origin-level scripts are overlaid at their real paths.
 *     Games load `/arcade-sdk.js` by absolute path; serving a game's dist/ on
 *     its own 404s it, and the app then boots down a degraded path no player
 *     ever takes. That is a property of the harness, not of the app.
 *
 * It knows nothing about any game's rules. It knows "not a black rectangle".
 */
import { chromium } from 'playwright';
import { inflateSync } from 'node:zlib';
import { existsSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { serveRepo } from './lib/static-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// a minimal PNG reader
// ---------------------------------------------------------------------------
//
// Playwright screenshots are 8-bit, non-interlaced, colour type 2 (RGB) or 6
// (RGBA). Anything else is refused rather than guessed at — a decoder that
// silently mis-reads its input would produce exactly the confident-and-wrong
// verdict this whole file exists to avoid.

function decodePng(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
    let pos = 8, width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
    const idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            depth = data[8]; colour = data[9]; interlace = data[12];
        } else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        pos += len + 12;
    }
    if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) {
        throw new Error(`unsupported PNG: depth=${depth} colour=${colour} interlace=${interlace}`);
    }
    const channels = colour === 6 ? 4 : 3;
    const stride = width * channels;
    const raw = inflateSync(Buffer.concat(idat));
    const out = Buffer.alloc(height * stride);

    // Un-filter, per PNG spec §9.2. Each scanline carries a filter byte.
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const row = out.subarray(y * stride, (y + 1) * stride);
        const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? row[x - channels] : 0;
            const b = prev ? prev[x] : 0;
            const c = (prev && x >= channels) ? prev[x - channels] : 0;
            let v = src[x];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            } else if (filter !== 0) throw new Error(`bad PNG filter ${filter} on row ${y}`);
            row[x] = v & 0xff;
        }
    }
    return { width, height, channels, data: out };
}

// ---------------------------------------------------------------------------
// the assertion
// ---------------------------------------------------------------------------

// A blank page is one colour, plus a little antialiasing where a scrollbar or
// a focus ring lands. A drawn one is not close. Both floors must clear, so a
// page that is a flat background with a single letter on it does not pass on
// distinct-colour count alone, and a page dithered in one hue does not pass on
// variance alone.
const MIN_DISTINCT = 24;
const MIN_STDDEV = 4;

function measure({ width, height, channels, data }) {
    const seen = new Set();
    let n = 0;
    const sum = [0, 0, 0], sumSq = [0, 0, 0];
    // Every 3rd pixel on each axis: ~9x less work, and no structure in a
    // rendered page is fine enough for that stride to miss it entirely.
    for (let y = 0; y < height; y += 3) {
        for (let x = 0; x < width; x += 3) {
            const i = y * width * channels + x * channels;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            if (seen.size < 4096) seen.add((r << 16) | (g << 8) | b);
            sum[0] += r; sum[1] += g; sum[2] += b;
            sumSq[0] += r * r; sumSq[1] += g * g; sumSq[2] += b * b;
            n++;
        }
    }
    const stddev = [0, 1, 2].map((c) => {
        const mean = sum[c] / n;
        return Math.sqrt(Math.max(0, sumSq[c] / n - mean * mean));
    });
    return {
        distinct: seen.size,
        stddev: Math.max(...stddev),
        pixels: n,
        drew: seen.size >= MIN_DISTINCT && Math.max(...stddev) >= MIN_STDDEV,
    };
}

// ---------------------------------------------------------------------------
// per-app hints — the tools/stage.mjs shape: one identical checker, a small
// per-app declaration. Most apps need none.
// ---------------------------------------------------------------------------

const DEFAULTS = {
    path: '/index.html',
    // A ceiling, not an expectation. Waits in this fleet are generous on
    // purpose: hitting one means a real bug that wants a debugger, never a
    // bigger number.
    settleMs: 2500,
    ready: null,
};

async function loadHints(file) {
    if (!file) return { ...DEFAULTS, source: 'defaults' };
    if (!existsSync(file)) throw new Error(`--hints file not found: ${file}`);
    const mod = await import(pathToFileURL(path.resolve(file)).href);
    const decl = mod.default || mod.smoke || mod;
    return { ...DEFAULTS, ...decl, source: path.relative(process.cwd(), file) };
}

// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(['--hints', '--sdk', '--label', '--port', '--shot']);
const opts = {};
const positional = [];
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (VALUE_FLAGS.has(a)) opts[a] = process.argv[++i];
    else if (a.startsWith('--')) opts[a] = true;
    else positional.push(a);
}

const distDir = path.resolve(positional[0] || 'dist');
const label = opts['--label'] || path.basename(path.dirname(distDir)) || 'app';
// 4860, not 4801: the acceptance suites own 4784–4808, one fixed port each,
// and 4801 is export-advanced-acceptance's. Sequential CI runs would not have
// collided, but anyone smoking an artifact while a suite is up would have.
const port = Number(opts['--port'] || 4860);
const warnOnly = Boolean(opts['--warn']);
const shotPath = opts['--shot'] || null;
const flag = (name, fallback = null) => opts[name] ?? fallback;

if (!existsSync(distDir)) {
    console.error(`render-smoke: no such directory: ${distDir}\n`
        + '  Stage the app first, the same way the deploy does.');
    process.exit(2);
}

// The origin-level scripts a game loads by absolute path. Taken from a real
// launcher checkout when one is given, so what runs is the SDK that actually
// ships — not a stub whose behaviour nobody maintains.
//
// Two surfaces, and both are needed: `arcade-*.js` at the root, which is what
// a game's `<script src="/arcade-sdk.js">` resolves to, and everything under
// `sdk/`, which is where the version-pinned path lives (an app that pins
// `/sdk/v3/arcade-sdk.js` is insulated from a breaking major, and the starter
// fixture does exactly that). Enumerated rather than falling back to the
// launcher for any 404, so a genuinely missing file in the app's own artifact
// still 404s here instead of being quietly satisfied from next door.
function buildOverlay(sdkDir) {
    if (!sdkDir) return null;
    const root = path.resolve(sdkDir);
    const overlay = {};
    for (const f of readdirSync(root)) {
        if (/^arcade-[a-z0-9-]+\.js$/.test(f)) overlay['/' + f] = path.join(root, f);
    }
    const walk = (rel) => {
        const abs = path.join(root, rel);
        if (!existsSync(abs)) return;
        for (const e of readdirSync(abs, { withFileTypes: true })) {
            const child = `${rel}/${e.name}`;
            if (e.isDirectory()) walk(child);
            else if (e.name.endsWith('.js')) overlay['/' + child] = path.join(root, child);
        }
    };
    walk('sdk');
    return Object.keys(overlay).length ? overlay : null;
}

async function attempt(hints, overlay) {
    const server = await serveRepo({ root: distDir, port, cors: true, overlay });
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        const consoleErrors = [];
        page.on('pageerror', (e) => consoleErrors.push(String(e).split('\n')[0]));
        page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

        await page.goto(server.origin + hints.path, { waitUntil: 'load', timeout: 30000 });
        // A background page reports hidden, the SDK suspends, and a conforming
        // game correctly stops drawing. This is the difference between a
        // harness that works and one that fails everything.
        await page.bringToFront();
        await page.waitForFunction(() => document.visibilityState === 'visible',
            null, { timeout: 10000 });

        if (typeof hints.ready === 'function') await hints.ready(page);
        await page.waitForTimeout(hints.settleMs);

        const shot = await page.screenshot({ type: 'png' });
        if (shotPath) writeFileSync(shotPath, shot);
        return { ...measure(decodePng(shot)), consoleErrors, bytes: shot.length };
    } finally {
        await browser.close();
        await server.close();
    }
}

const hints = await loadHints(flag('--hints'));
const overlay = buildOverlay(flag('--sdk'));

console.log(`\nrender smoke — ${label}`);
console.log(`  artifact  ${distDir}`);
console.log(`  entry     ${hints.path}   (hints: ${hints.source})`);
console.log(`  origin    ${overlay ? Object.keys(overlay).sort().join(' ') : 'no launcher scripts overlaid'}`);

// One retry, in CI only — the same policy run-ci.mjs already applies to its
// timing-sensitive suites. A genuine blank fails both times.
const attempts = process.env.CI ? 2 : 1;
let result = null;
for (let i = 1; i <= attempts; i++) {
    result = await attempt(hints, overlay);
    if (result.drew) break;
    if (i < attempts) console.log(`  …nothing drawn on attempt ${i}; retrying`);
}

console.log(`  measured  ${result.distinct} distinct colours, `
    + `channel σ ${result.stddev.toFixed(1)}, over ${result.pixels} sampled pixels`);
if (result.consoleErrors.length) {
    console.log('  page errors:');
    for (const e of [...new Set(result.consoleErrors)].slice(0, 8)) console.log(`    · ${e}`);
}

if (result.drew) {
    console.log('  ✓ the app drew something');
    process.exit(0);
}

const message = `${label} rendered a near-uniform frame — `
    + `${result.distinct} distinct colours (floor ${MIN_DISTINCT}), `
    + `channel σ ${result.stddev.toFixed(1)} (floor ${MIN_STDDEV}). `
    + 'Either it draws nothing, or it needs a tools/smoke.mjs declaration to '
    + 'reach a drawn frame (an intro tap-gate or a first-run modal in the way).';
if (warnOnly) {
    console.log(`  ⚠ ${message}`);
    console.log('::warning title=render smoke::' + message);
    console.log('  (warn mode — not failing the run)');
    process.exit(0);
}
console.error(`  ✗ ${message}`);
process.exit(1);
