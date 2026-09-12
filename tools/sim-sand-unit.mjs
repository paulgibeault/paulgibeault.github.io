/* sim-sand-unit.mjs — known-answer tests for the sand kernel.
 *
 * Two implementations exist on purpose: tools/sim/sand-reference.mjs is the
 * spec, sdk/v3/arcade-sim-sand.wasm is the product. This suite is the only
 * thing that makes that arrangement safe — it drives both through the same
 * seeds and paint scripts and asserts the grids are byte-identical at every
 * checkpoint, so a kernel edit that alters behaviour fails here instead of
 * silently forking every player's daily. It also pins FNV hashes of the
 * reference grid itself: the reference is allowed to change, but never
 * quietly, because a changed rule changes every share code in the wild.
 *
 *   Gate A — WASM ≡ reference: grid, pixels, quiet(), activeCells() agree
 *            after every checkpoint of every script × seed.
 *   Gate B — settle-to-quiet: once pouring stops, quiet() becomes true
 *            within a bounded number of steps and STAYS true (plan §6: a
 *            kernel that never goes quiet is a battery bug of the first
 *            order), and activeCells() is 0 whenever quiet() is.
 *   Gate C — the framebuffer is the palette: sampled cells' RGBA match the
 *            material under them, on both implementations.
 *   Gate D — pinned hashes of the reference grid per script × seed.
 *   Gate E — edges the scripts do not reach: paint validation, get() out of
 *            bounds, seed 0, a grid that is not a multiple of the chunk size.
 *   Gate F — the tools a sand-art host uses: tints share sand's physics,
 *            nudge() wakes a settled pile and it re-settles, stir() advances
 *            the stream deterministically, clear() is instantly quiet and
 *            keeps the stream, setPalette() changes pixels on both.
 *
 * No browser: node instantiates the .wasm natively. Run:
 *   node tools/sim-sand-unit.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandReference, fnv1a, PALETTE, EMPTY, SAND, WATER, WALL, SAND_BASE, SAND_COUNT, isSand, CHUNK } from './sim/sand-reference.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WASM = readFileSync(join(ROOT, 'sdk', 'v3', 'arcade-sim-sand.wasm'));

let pass = 0, fail = 0;
function ok(cond, label, detail) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label + (detail ? ` — ${detail}` : '')); }
}

// A thin node-side twin of the browser wrapper, over the raw exports. The
// wrapper itself is exercised by tools/sim-sand-acceptance.mjs in a real
// sandboxed frame; here the subject is the kernel.
async function createWasm({ width, height, seed }) {
    const instance = await WebAssembly.instantiate(new WebAssembly.Module(WASM));
    const ex = instance.exports;
    if (!ex.init(width, height, seed >>> 0)) throw new Error('init failed');
    const n = width * height;
    return {
        width, height,
        step: (c = 1) => ex.step(c),
        paint: (m, x, y, r) => ex.paint(m, x, y, r),
        nudge: (x, y, r, dx, dy) => ex.nudge(x, y, r, dx, dy),
        stir: (x, y, r) => ex.stir(x, y, r),
        clear: () => ex.clear(),
        reseed: (seed) => ex.reseed(seed >>> 0),
        setPalette: (i, r, g, b, a = 255) => ex.setPalette(i, r, g, b, a),
        get: (x, y) => ex.get(x, y),
        quiet: () => ex.quiet() !== 0,
        activeCells: () => ex.activeCells(),
        get grid() { return new Uint8Array(ex.memory.buffer, ex.gridPtr(), n); },
        get pixels() { return new Uint8ClampedArray(ex.memory.buffer, ex.pixelsPtr(), n * 4); },
        get palette() { return new Uint8Array(ex.memory.buffer, ex.palettePtr(), 48 * 4); },
    };
}

// ── the scripts ──────────────────────────────────────────────────────────
// Each is a function of (sim, step index) that paints whatever that step
// pours; `pourUntil` is the last step that paints, after which Gate B
// expects the sim to settle. Checkpoints are the steps after which both
// implementations are compared.
const W = 128, H = 96;
const SCRIPTS = {
    'pour sand': {
        // Sparse on purpose: a saturated source fills every slot below it
        // whichever grain the rng picks (grains are indistinguishable), and
        // the grid comes out seed-independent — which would leave the rng
        // stream untested. A trickle every third step keeps seeds distinct.
        pourUntil: 200, steps: 200, settleWithin: 300,
        paint(sim, k) { if (k < 200 && k % 3 === 0) sim.paint(SAND, 64, 4, 1); },
    },
    'sand then water, layered': {
        pourUntil: 400, steps: 400, settleWithin: 400,
        paint(sim, k) {
            if (k < 150) sim.paint(SAND, 40, 4, 3);
            if (k >= 150 && k < 400) sim.paint(WATER, 90, 4, 3);
            if (k >= 300 && k < 400) sim.paint(SAND, 90, 4, 2); // sand sinking through water
        },
    },
    'wall shelf': {
        pourUntil: 300, steps: 300, settleWithin: 400,
        paint(sim, k) {
            if (k === 0) {
                for (let x = 20; x < 80; x++) sim.paint(WALL, x, 50, 1); // a shelf
                sim.paint(WALL, 100, 70, 8);                              // a boulder
            }
            if (k < 300) { sim.paint(WATER, 30, 4, 2); sim.paint(SAND, 110, 4, 2); }
        },
    },
    // The sand-art session: every tint, water, a wall, two stick shoves, a
    // stir, a palette change, then clear() and a fresh pour on the same
    // stream. Pinned BEFORE the clear (step 245) — after it the grid is a
    // saturated single-tint pour and comes out the same for every seed.
    'tints, nudge, stir, clear': {
        pourUntil: 300, steps: 300, settleWithin: 300, pinAt: 245,
        paint(sim, k) {
            if (k < 120) sim.paint(SAND_BASE + (k % 32), 40 + (k % 5), 4, 2);
            if (k >= 60 && k < 180) sim.paint(WATER, 96, 4, 2);
            if (k === 100) sim.paint(WALL, 40, 60, 6);
            if (k === 190) sim.nudge(40, 88, 12, 9, -4);
            if (k === 210) sim.nudge(96, 90, 8, -7, 0);
            if (k === 230) sim.stir(50, 88, 6);
            if (k === 240) sim.setPalette(SAND_BASE + 4, 240, 20, 20, 255);
            if (k === 250) sim.clear();
            if (k >= 250 && k < 300) sim.paint(SAND_BASE + 7, 64 + (k % 3), 4, 1);
        },
    },
};
const SEEDS = [1, 7, 0xdeadbeef, 42];
const CHECKPOINTS = [1, 2, 3, 10, 50, 100, 150, 190, 200, 210, 230, 240, 245, 250, 251, 300, 400];

// Pinned reference hashes after `steps` steps. A rule change moves these;
// re-pin deliberately (and say so in sdk/CHANGELOG.md) — never quietly.
const PINNED = {
    'pour sand': { 1: 437730244, 7: 4265528268, 3735928559: 1860022680, 42: 3990896000 },
    'sand then water, layered': { 1: 1509407540, 7: 191890108, 3735928559: 1092082580, 42: 589046728 },
    'wall shelf': { 1: 3918263654, 7: 1327368378, 3735928559: 2403979590, 42: 3789155266 },
    'tints, nudge, stir, clear': { 1: 3716367102, 7: 3781409420, 3735928559: 3966140336, 42: 2484319428 },
};

function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function samplePixelsMatch(sim) {
    const { grid, pixels } = sim;
    // A spread of cells: corners, a column through the pile, a row through it.
    const idx = [0, sim.width - 1, (sim.height - 1) * sim.width, sim.width * sim.height - 1];
    for (let y = 0; y < sim.height; y += 7) idx.push(y * sim.width + 64);
    for (let x = 0; x < sim.width; x += 5) idx.push((sim.height - 3) * sim.width + x);
    for (const i of idx) {
        const m = grid[i];
        for (let c = 0; c < 4; c++) if (pixels[i * 4 + c] !== PALETTE[m * 4 + c]) return false;
    }
    return true;
}

console.log('\nGate A — WASM grid ≡ reference grid, every checkpoint of every script × seed');
const finals = {};
for (const [name, script] of Object.entries(SCRIPTS)) {
    for (const seed of SEEDS) {
        const ref = createSandReference({ width: W, height: H, seed });
        const wasm = await createWasm({ width: W, height: H, seed });
        let diverged = null;
        for (let k = 0; k < script.steps; k++) {
            script.paint(ref, k); script.paint(wasm, k);
            ref.step(); wasm.step();
            const at = k + 1;
            if (!CHECKPOINTS.includes(at) && at !== script.steps) continue;
            if (!sameBytes(ref.grid, wasm.grid)) { diverged = `grid at step ${at}`; break; }
            if (!sameBytes(ref.pixels, wasm.pixels)) { diverged = `pixels at step ${at}`; break; }
            if (!sameBytes(ref.palette, wasm.palette)) { diverged = `palette at step ${at}`; break; }
            if (ref.quiet() !== wasm.quiet()) { diverged = `quiet() at step ${at}`; break; }
            if (ref.activeCells() !== wasm.activeCells()) { diverged = `activeCells() at step ${at}`; break; }
        }
        ok(!diverged, `${name} / seed ${seed}: identical through ${script.steps} steps`, diverged);
        finals[name] ??= {};
        finals[name][seed] = { ref, wasm };
    }
}

console.log('\nGate B — settle-to-quiet after pouring stops, and stays quiet');
for (const [name, script] of Object.entries(SCRIPTS)) {
    for (const seed of SEEDS) {
        const { ref, wasm } = finals[name][seed];
        // Pouring has stopped (steps === pourUntil). Count steps to quiet.
        let n = 0;
        while (!ref.quiet() && n < script.settleWithin) { ref.step(); wasm.step(); n++; }
        ok(ref.quiet(), `${name} / seed ${seed}: reference quiet within ${script.settleWithin} steps (took ${n})`);
        ok(wasm.quiet(), `${name} / seed ${seed}: WASM quiet at the same step`);
        ok(ref.activeCells() === 0 && wasm.activeCells() === 0, `${name} / seed ${seed}: activeCells() is 0 when quiet`);
        ref.step(100); wasm.step(100);
        ok(ref.quiet() && wasm.quiet(), `${name} / seed ${seed}: still quiet 100 steps later`);
        ok(sameBytes(ref.grid, wasm.grid), `${name} / seed ${seed}: grids still identical after settling`);
        // Quiet means nothing moves: a step must be a no-op on the grid.
        const before = fnv1a(ref.grid); ref.step(); wasm.step();
        ok(fnv1a(ref.grid) === before && fnv1a(wasm.grid) === before, `${name} / seed ${seed}: a quiet step changes nothing`);
    }
}

console.log('\nGate C — pixels are the palette');
for (const [name] of Object.entries(SCRIPTS)) {
    const { ref, wasm } = finals[name][SEEDS[0]];
    ok(samplePixelsMatch(ref), `${name}: reference sampled pixels match the material palette`);
    ok(samplePixelsMatch(wasm), `${name}: WASM sampled pixels match the material palette`);
    // The settled scene is not a single colour: sand and empty at least.
    const mats = new Set(ref.grid);
    ok(mats.has(EMPTY) && ([...mats].some(isSand) || mats.has(WATER)), `${name}: settled grid holds more than one material`);
}
{
    const fresh = createSandReference({ width: 8, height: 8, seed: 1 });
    ok(fresh.pixels.every((v, i) => v === PALETTE[i & 3]), 'a fresh grid is painted EMPTY everywhere');
}

console.log('\nGate D — pinned reference hashes (a rule change must be loud)');
for (const [name, script] of Object.entries(SCRIPTS)) {
    for (const seed of SEEDS) {
        // Recompute from scratch: Gate B stepped the shared instances on.
        const ref = createSandReference({ width: W, height: H, seed });
        const upTo = script.pinAt || script.steps;
        for (let k = 0; k < upTo; k++) { script.paint(ref, k); ref.step(); }
        const got = fnv1a(ref.grid), want = PINNED[name][seed >>> 0];
        ok(got === want, `${name} / seed ${seed}: hash after ${upTo} steps ${got}`, `pinned ${want}`);
    }
    ok(new Set(Object.values(PINNED[name])).size === SEEDS.length, `${name}: every seed gives a different grid (the rng is live)`);
}

console.log('\nGate E — edges');
{
    const ref = createSandReference({ width: 20, height: 13, seed: 0 }); // not chunk-aligned; seed 0
    const wasm = await createWasm({ width: 20, height: 13, seed: 0 });
    let threw = false;
    try { ref.paint(4, 1, 1, 1); } catch (e) { threw = e instanceof RangeError; }
    ok(threw, 'reference paint() rejects an unknown material with RangeError');
    wasm.paint(4, 1, 1, 1);
    ok(wasm.grid.every((v) => v === 0), 'WASM paint() with an unknown material is a no-op');
    ok(ref.get(-1, 0) === EMPTY && ref.get(0, 99) === EMPTY && wasm.get(-1, 0) === EMPTY && wasm.get(99, 0) === EMPTY,
        'get() out of bounds is EMPTY on both');
    ref.paint(SAND, 19, 0, 2); wasm.paint(SAND, 19, 0, 2);   // clipped at the right edge
    ref.paint(WATER, 0, 0, 2); wasm.paint(WATER, 0, 0, 2);   // clipped at the left edge
    ok(!ref.quiet() && !wasm.quiet(), 'a paint wakes the sim');
    let n = 0;
    while (!ref.quiet() && n < 200) { ref.step(); wasm.step(); n++; }
    ok(ref.quiet() && wasm.quiet() && sameBytes(ref.grid, wasm.grid),
        `20×13 (partial chunks), seed 0: settles identically (${n} steps)`);
    ok(ref.get(19, 12) === SAND || ref.get(18, 12) === SAND, 'edge-clipped sand reached the floor');
    ok(CHUNK === 16, 'chunk size is 16 (the documented granularity)');
    let bad = false;
    try { createSandReference({ width: 0, height: 4 }); } catch (e) { bad = e instanceof RangeError; }
    ok(bad, 'reference rejects a zero-width grid');
    const instance = await WebAssembly.instantiate(new WebAssembly.Module(WASM));
    ok(instance.exports.init(0, 4, 1) === 0, 'WASM init() refuses a zero-width grid');
    ok(WebAssembly.Module.imports(new WebAssembly.Module(WASM)).length === 0, 'the binary imports nothing');
}

console.log('\nGate F — tints, nudge, stir, clear, reseed, setPalette');
{
    ok(SAND_BASE === 16 && SAND_COUNT === 32 && isSand(SAND) && isSand(16) && isSand(47) && !isSand(48) && !isSand(WATER),
        'sand ids: 1 and 16..47 are sand, 48 and water are not');
    // Tints share sand's physics: the same script with every grain re-tinted
    // gives the same SHAPE (grid with tints collapsed to SAND).
    const plain = createSandReference({ width: 64, height: 48, seed: 3 });
    const tinted = createSandReference({ width: 64, height: 48, seed: 3 });
    for (let k = 0; k < 120; k++) {
        if (k % 2 === 0) { plain.paint(SAND, 32, 2, 2); tinted.paint(SAND_BASE + (k % 32), 32, 2, 2); }
        plain.step(); tinted.step();
    }
    const collapsed = tinted.grid.map((m) => (isSand(m) ? SAND : m));
    ok(sameBytes(plain.grid, collapsed), "tints have exactly SAND's physics (same shape, same rng use)");
    ok(new Set(tinted.grid).size > 8, 'the tinted pile holds many distinct ids');

    // nudge: a settled pile goes un-quiet and re-settles, identically on both.
    const ref = createSandReference({ width: 64, height: 48, seed: 9 });
    const wasm = await createWasm({ width: 64, height: 48, seed: 9 });
    for (let k = 0; k < 80; k++) { ref.paint(SAND_BASE + 2, 32, 2, 2); wasm.paint(SAND_BASE + 2, 32, 2, 2); ref.step(); wasm.step(); }
    let n = 0; while (!ref.quiet() && n < 200) { ref.step(); wasm.step(); n++; }
    ok(ref.quiet() && wasm.quiet(), 'pile settled before the nudge');
    const before = fnv1a(ref.grid);
    // Shove the SURFACE of the pile: deep inside, every destination is
    // occupied and R12 correctly moves nothing. Find the top of the column
    // under the pour point and centre the stick a little below it.
    let top = 0; while (ref.get(32, top) === EMPTY) top++;
    ref.nudge(32, top + 2, 4, 3, -4); wasm.nudge(32, top + 2, 4, 3, -4);
    ok(!ref.quiet() && !wasm.quiet(), 'nudge() wakes the sim on both');
    ok(fnv1a(ref.grid) !== before && sameBytes(ref.grid, wasm.grid), 'nudge() moved cells, identically on both');
    n = 0; while (!ref.quiet() && n < 300) { ref.step(); wasm.step(); n++; }
    ok(ref.quiet() && wasm.quiet() && sameBytes(ref.grid, wasm.grid), `nudged pile re-settles identically (${n} steps)`);
    ok(ref.grid.filter(isSand).length === wasm.grid.filter(isSand).length, 'nudge() conserves grains');
    const cnt = ref.grid.filter(isSand).length;
    ref.nudge(32, 44, 6, 0, 0); ok(ref.quiet(), 'nudge(…, 0, 0) is a no-op');
    ref.nudge(0, 0, 3, -5, -5); ok(ref.quiet(), 'nudge() at an empty corner is a no-op');

    // stir: deterministic, conserves grains, identical on both.
    ref.stir(32, 44, 5); wasm.stir(32, 44, 5);
    ok(sameBytes(ref.grid, wasm.grid) && ref.grid.filter(isSand).length === cnt, 'stir() is identical on both and conserves grains');
    n = 0; while (!ref.quiet() && n < 300) { ref.step(); wasm.step(); n++; }
    ok(ref.quiet() && sameBytes(ref.grid, wasm.grid), 'stirred pile re-settles identically');

    // setPalette: pixels change, grid does not, both agree.
    const gridBefore = fnv1a(ref.grid), pixBefore = fnv1a(ref.pixels);
    ref.setPalette(SAND_BASE + 2, 1, 2, 3); wasm.setPalette(SAND_BASE + 2, 1, 2, 3);
    ok(fnv1a(ref.grid) === gridBefore, 'setPalette() leaves the grid alone');
    ok(fnv1a(ref.pixels) !== pixBefore && sameBytes(ref.pixels, wasm.pixels), 'setPalette() repaints, identically on both');
    const i = ref.grid.findIndex((m) => m === SAND_BASE + 2);
    ok(i >= 0 && ref.pixels[i * 4] === 1 && ref.pixels[i * 4 + 1] === 2 && ref.pixels[i * 4 + 2] === 3 && ref.pixels[i * 4 + 3] === 255,
        'a tinted cell now shows the new colour (alpha defaults to 255)');
    ok(ref.quiet() && wasm.quiet(), 'setPalette() does not wake the sim');
    ok(sameBytes(PALETTE.subarray(SAND * 4, SAND * 4 + 4), PALETTE.subarray(SAND_BASE * 4, SAND_BASE * 4 + 4)), 'SAND and tint 0 share a default colour');

    // clear: instantly quiet, stream kept; reseed restarts it.
    ref.clear(); wasm.clear();
    ok(ref.quiet() && wasm.quiet() && ref.activeCells() === 0 && wasm.activeCells() === 0, 'clear() is instantly quiet');
    ok(ref.grid.every((m) => m === EMPTY) && wasm.grid.every((m) => m === EMPTY), 'clear() empties the grid');
    ok(ref.pixels.every((v, k) => v === ref.palette[k & 3]) && sameBytes(ref.pixels, wasm.pixels), 'clear() repaints EMPTY through the (possibly changed) palette');
    const a = createSandReference({ width: 32, height: 32, seed: 5 });
    const b = createSandReference({ width: 32, height: 32, seed: 5 });
    for (let k = 0; k < 40; k++) { a.paint(SAND, 16, 2, 2); a.step(); }
    a.clear();
    for (let k = 0; k < 60; k++) { a.paint(SAND, 10 + (k % 9), 1, 1); b.paint(SAND, 10 + (k % 9), 1, 1); a.step(); b.step(); }
    ok(fnv1a(a.grid) !== fnv1a(b.grid), 'clear() keeps the rng stream (a cleared sim differs from a fresh one with the same seed)');
    a.clear(); a.reseed(5);
    const c = createSandReference({ width: 32, height: 32, seed: 5 });
    for (let k = 0; k < 60; k++) { a.paint(SAND, 10 + (k % 9), 1, 1); c.paint(SAND, 10 + (k % 9), 1, 1); a.step(); c.step(); }
    ok(fnv1a(a.grid) === fnv1a(c.grid), 'clear() + reseed(s) is indistinguishable from a fresh sim with seed s');
    const w2 = await createWasm({ width: 32, height: 32, seed: 1 });
    w2.paint(SAND, 5, 5, 3); w2.clear(); w2.reseed(5);
    for (let k = 0; k < 60; k++) { w2.paint(SAND, 10 + (k % 9), 1, 1); w2.step(); }
    ok(sameBytes(w2.grid, c.grid), 'WASM clear()+reseed() agrees with the reference');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
