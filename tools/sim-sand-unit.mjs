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
 *   Gate F — the tools a picture-making host uses: tints share sand's physics,
 *            nudge() wakes a settled pile and it re-settles, stir() advances
 *            the stream deterministically, clear() is instantly quiet and
 *            keeps the stream, setPalette() changes pixels on both.
 *   Gate G — save/restore and stencils: load() round-trips grid+pixels and
 *            settles a floating pile, rejects bad input before touching
 *            memory; replace() erases and recolours; batch setPalette()
 *            equals the sequential form with one repaint.
 *   Gate I — lean (R18): the 'lean' script rides Gates A–D; here the edges,
 *            that a pile always comes to rest, that the rest slope is the
 *            one the wrapper's leanPlan() promises, and that the heap's
 *            shift grows smoothly with the angle — the whole point.
 *   Gate H — tilt (R17): the 'tilt' script above rides Gates A–D like any
 *            other (parity under every gravity, settles, pinned); here the
 *            edges: bad directions, the same direction twice, a settled
 *            pile leaning to a wall and rising to the ceiling, identically.
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
        setPaletteEntry: (i, r, g, b, a = 255) => ex.setPaletteEntry(i, r, g, b, a),
        repaint: () => ex.repaint(),
        load(bytes) { this.grid.set(bytes); ex.commitLoad(); },   // validation is the wrapper's; the twin trusts its caller
        replace: (f, t, x, y, r) => ex.replace(f, t, x, y, r),
        get: (x, y) => ex.get(x, y),
        tilt: (gx, gy) => ex.tilt(gx, gy),
        gravity: () => [ex.gravityX(), ex.gravityY()],
        lean: (side, reach, p, drift) => ex.lean(side, reach, p, drift),
        leaning: () => [ex.leanSideOf(), ex.leanReachOf(), ex.leanPOf(), ex.leanDriftOf()],
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
    // A picture-making session: every tint, water, a wall, two stick shoves, a
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
    // R17: a pour, then the jar tilted down-right, left, up, and upright
    // again with water in between — every rule under every kind of gravity
    // (a sideways part, none, both), and a settle at the end under (0,1).
    'tilt': {
        pourUntil: 300, steps: 400, settleWithin: 400,
        paint(sim, k) {
            if (k < 100 && k % 3 === 0) sim.paint(SAND_BASE + 3, 64, 4, 2);
            if (k === 100) sim.tilt(1, 1);
            if (k >= 100 && k < 200 && k % 3 === 0) sim.paint(SAND_BASE + 9, 20, 4, 2);
            if (k === 200) sim.tilt(-1, 0);
            if (k >= 200 && k < 260 && k % 2 === 0) sim.paint(WATER, 64, 48, 2);
            if (k === 260) sim.tilt(0, -1);
            if (k === 300) sim.tilt(0, 1);
        },
    },
    // R18: a pour into a jar leaning right (drift + the longer look), then
    // leaning hard left, then onto its side with a lean back, water in the
    // middle of it, and upright with no lean to settle.
    'lean': {
        pourUntil: 300, steps: 400, settleWithin: 600,
        paint(sim, k) {
            if (k === 0) sim.lean(-1, 1, 139, 45);                       // ≈ 12° to the right
            if (k < 120 && k % 2 === 0) sim.paint(SAND_BASE + 5, 50, 4, 2);
            if (k === 120) sim.lean(1, 3, 200, 148);                     // ≈ 30° to the left
            if (k >= 120 && k < 220 && k % 3 === 0) sim.paint(SAND_BASE + 11, 90, 4, 2);
            if (k === 220) { sim.tilt(1, 0); sim.lean(1, 2, 49, 93); }   // on its side, leaning back
            if (k >= 230 && k < 300 && k % 2 === 0) sim.paint(WATER, 30, 40, 2);
            if (k === 300) { sim.tilt(0, 1); sim.lean(0, 1, 0, 0); }
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
    'tilt': { 1: 4020397336, 7: 637478940, 3735928559: 3189969290, 42: 3687178696 },
    'lean': { 1: 4002531875, 7: 1242730287, 3735928559: 1647381476, 42: 2249066899 },
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

console.log('\nGate G — load, replace, batch setPalette');
{
    // Round trip: a busy scene → bytes → load() on a FRESH sim of each kind.
    const src = createSandReference({ width: 64, height: 48, seed: 21 });
    for (let k = 0; k < 90; k++) {
        src.paint(SAND_BASE + (k % 32), 20 + (k % 7), 2, 2);
        if (k > 30) src.paint(WATER, 50, 2, 2);
        if (k === 10) src.paint(WALL, 32, 30, 4);
        src.step();
    }
    const bytes = src.grid.slice();
    const ref = createSandReference({ width: 64, height: 48, seed: 1 });
    const wasm = await createWasm({ width: 64, height: 48, seed: 1 });
    ref.load(bytes); wasm.load(bytes);
    ok(sameBytes(ref.grid, bytes) && sameBytes(wasm.grid, bytes), 'load() round-trips the grid on both');
    ok(sameBytes(ref.pixels, src.pixels) && sameBytes(wasm.pixels, src.pixels), 'load() repaints the framebuffer to match the source');
    ok(!ref.quiet() && !wasm.quiet() && ref.activeCells() === 0, 'load() wakes every chunk and reports 0 moved');
    ok(bytes !== ref.grid && (bytes[0] = 99, ref.grid[0] !== 99), 'load() copies its input, never aliases it');
    bytes[0] = 0;

    // A floating pile: paint mid-air with no step, save, load into fresh sims, settle.
    const air = createSandReference({ width: 40, height: 40, seed: 2 });
    air.paint(SAND_BASE + 9, 20, 10, 5); air.paint(WATER, 8, 6, 3);
    const floating = air.grid.slice();
    const r2 = createSandReference({ width: 40, height: 40, seed: 77 });
    const w2 = await createWasm({ width: 40, height: 40, seed: 77 });
    r2.load(floating); w2.load(floating);
    let n = 0; while (!r2.quiet() && n < 300) { r2.step(); w2.step(); n++; }
    ok(r2.quiet() && w2.quiet() && sameBytes(r2.grid, w2.grid), `a loaded floating pile settles to quiet identically (${n} steps)`);
    ok(r2.get(20, 39) !== EMPTY && !sameBytes(r2.grid, floating), 'the pile actually fell');
    ok(r2.grid.filter(isSand).length === floating.filter(isSand).length, 'load() + settling conserves grains');

    // Rejections happen before memory is touched.
    const before = fnv1a(ref.grid);
    let threw = 0;
    try { ref.load(new Uint8Array(10)); } catch (e) { if (e instanceof RangeError) threw++; }
    const badId = ref.grid.slice(); badId[123] = 9;
    try { ref.load(badId); } catch (e) { if (e instanceof RangeError) threw++; }
    try { ref.load([0, 1, 2]); } catch (e) { if (e instanceof RangeError) threw++; }
    ok(threw === 3 && fnv1a(ref.grid) === before, 'load() rejects wrong length / invalid id / non-Uint8Array with RangeError, grid untouched');

    // replace: stencil erase and recolour, on both, chunk activation.
    const scene = src.grid.slice();
    ref.load(scene); wasm.load(scene);
    let s = 0; while (!ref.quiet() && s < 300) { ref.step(); wasm.step(); s++; }
    const waterBefore = ref.grid.filter((m) => m === WATER).length;
    ref.replace(WATER, EMPTY, 50, 40, 12); wasm.replace(WATER, EMPTY, 50, 40, 12);
    ok(sameBytes(ref.grid, wasm.grid) && ref.grid.filter((m) => m === WATER).length < waterBefore, 'replace(WATER, EMPTY) erases only water, identically on both');
    ok(!ref.quiet() && !wasm.quiet(), 'replace() wakes the touched chunks');
    const tintA = SAND_BASE + 3, tintB = SAND_BASE + 30;
    const aBefore = ref.grid.filter((m) => m === tintA).length;
    ref.replace(tintA, tintB, 32, 24, 100); wasm.replace(tintA, tintB, 32, 24, 100);
    ok(aBefore > 0 && ref.grid.filter((m) => m === tintA).length === 0 && sameBytes(ref.grid, wasm.grid) && sameBytes(ref.pixels, wasm.pixels),
        'replace(tint a, tint b) recolours every grain in reach, identically on both');
    const h0 = fnv1a(ref.grid);
    ref.replace(WALL, WALL, 32, 24, 100); ref.replace(SAND, WALL, 0, 0, -1);
    ok(fnv1a(ref.grid) === h0, 'replace() with from == to or r < 0 is a no-op');
    let bad = false; try { ref.replace(5, EMPTY, 1, 1, 1); } catch (e) { bad = e instanceof RangeError; }
    ok(bad, 'replace() rejects an invalid material with RangeError');
    wasm.replace(5, EMPTY, 1, 1, 1);
    ok(sameBytes(ref.grid, wasm.grid), 'WASM replace() with an invalid material is a no-op');

    // batch setPalette == sequential entries + one repaint, on both.
    const seqRef = createSandReference({ width: 64, height: 48, seed: 1 }); seqRef.load(scene);
    const entries = [[SAND_BASE + 30, 9, 8, 7], [WATER, 1, 2, 3, 200], [EMPTY, 0, 0, 0, 255]];
    seqRef.setPaletteEntry(SAND_BASE + 30, 9, 8, 7); seqRef.setPaletteEntry(WATER, 1, 2, 3, 200); seqRef.setPaletteEntry(EMPTY, 0, 0, 0, 255); seqRef.repaint();
    ref.setPalette(entries);
    for (const e of entries) wasm.setPaletteEntry(e[0], e[1], e[2], e[3], e.length > 4 ? e[4] : 255);
    wasm.repaint();
    ok(sameBytes(ref.palette, seqRef.palette) && sameBytes(ref.palette, wasm.palette), 'batch setPalette writes every entry (alpha defaults to 255)');
    ok(sameBytes(ref.pixels, wasm.pixels) && ref.pixels.every((v, k) => v === ref.palette[ref.grid[k >> 2] * 4 + (k & 3)]),
        'one repaint after the batch maps every cell through the new palette, identically on both');
    ref.setPaletteEntry(WALL, 5, 5, 5);
    ok(ref.pixels[ref.grid.indexOf(WALL) * 4] !== 5, 'setPaletteEntry() alone does not repaint');
    ref.repaint();
    ok(ref.pixels[ref.grid.indexOf(WALL) * 4] === 5, 'repaint() applies it');
}

console.log('\nGate H — tilt');
{
    const ref = createSandReference({ width: 64, height: 48, seed: 5 });
    const wasm = await createWasm({ width: 64, height: 48, seed: 5 });
    for (const sim of [ref, wasm]) { for (let k = 0; k < 60; k++) { if (k % 2 === 0) sim.paint(SAND, 32, 2, 2); sim.step(); } for (let k = 0; k < 300 && !sim.quiet(); k++) sim.step(); }
    ok(ref.quiet() && wasm.quiet() && sameBytes(ref.grid, wasm.grid), 'a pile settled upright, identically');
    ok(ref.gravity()[0] === 0 && ref.gravity()[1] === 1 && wasm.gravity()[0] === 0 && wasm.gravity()[1] === 1, 'gravity() starts upright (0,1)');
    let threw = 0;
    for (const [gx, gy] of [[0, 0], [2, 0], [0, -2], [1, 3]]) { try { ref.tilt(gx, gy); } catch (e) { if (e instanceof RangeError) threw++; } }
    const before = fnv1a(wasm.grid);
    for (const [gx, gy] of [[0, 0], [2, 0], [0, -2], [1, 3]]) wasm.tilt(gx, gy);
    ok(threw === 4 && ref.quiet(), 'reference tilt() rejects (0,0) and anything off the ring with RangeError, and stays quiet');
    ok(wasm.quiet() && fnv1a(wasm.grid) === before && wasm.gravity()[1] === 1, 'WASM tilt() with a bad direction is a no-op');
    ref.tilt(0, 1); wasm.tilt(0, 1);
    ok(ref.quiet() && wasm.quiet(), 'tilt() to the gravity already set is a no-op: nothing wakes');
    const grains = ref.grid.filter(isSand).length;
    const centroidX = (g) => { let sx = 0, n = 0; for (let i = 0; i < g.length; i++) if (isSand(g[i])) { sx += i % 64; n++; } return sx / n; };
    const cx0 = centroidX(ref.grid);
    ref.tilt(1, 0); wasm.tilt(1, 0);
    ok(!ref.quiet() && !wasm.quiet(), 'tilt() to a new gravity wakes every chunk');
    let n = 0;
    while (n < 2000 && !(ref.quiet() && wasm.quiet())) { ref.step(); wasm.step(); n++; }
    ok(ref.quiet() && wasm.quiet() && sameBytes(ref.grid, wasm.grid), `the pile re-settles under (1,0) identically (${n} steps)`);
    ok(centroidX(ref.grid) > cx0 + 10 && ref.get(63, 47) !== EMPTY, 'under gravity (1,0) the sand lies against the right wall');
    ok(ref.grid.filter(isSand).length === grains, 'tilting conserves grains');
    ref.tilt(0, -1); wasm.tilt(0, -1);
    n = 0;
    while (n < 2000 && !(ref.quiet() && wasm.quiet())) { ref.step(); wasm.step(); n++; }
    let topRow = 0; for (let x = 0; x < 64; x++) if (isSand(ref.get(x, 0))) topRow++;
    ok(ref.quiet() && wasm.quiet() && sameBytes(ref.grid, wasm.grid) && topRow > 0, `under gravity (0,-1) the sand rises to the ceiling, identically (${n} steps)`);
    ref.tilt(-1, 1); wasm.tilt(-1, 1);
    n = 0;
    while (n < 2000 && !(ref.quiet() && wasm.quiet())) { ref.step(); wasm.step(); n++; }
    ok(ref.quiet() && wasm.quiet() && sameBytes(ref.grid, wasm.grid) && ref.get(0, 47) !== EMPTY, `under gravity (-1,1) it gathers in the bottom-left corner, identically (${n} steps)`);
    ok(ref.gravity()[0] === -1 && wasm.gravity()[0] === -1, 'gravity() reports the tilt');
    // water under a sideways gravity still spreads across it, and settles
    const rw = createSandReference({ width: 64, height: 48, seed: 9 });
    const ww = await createWasm({ width: 64, height: 48, seed: 9 });
    for (const sim of [rw, ww]) { sim.tilt(1, 0); for (let k = 0; k < 80; k++) { if (k % 2 === 0) sim.paint(WATER, 10, 24, 2); sim.step(); } }
    n = 0;
    while (n < 3000 && !(rw.quiet() && ww.quiet())) { rw.step(); ww.step(); n++; }
    let wet = 0, wetRows = new Set(); for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) if (rw.get(x, y) === WATER) { wet++; wetRows.add(y); }
    ok(rw.quiet() && ww.quiet() && sameBytes(rw.grid, ww.grid), `water settles under gravity (1,0) identically (${n} steps)`);
    ok(wet > 0 && wetRows.size > 8, `water spreads across gravity (${wetRows.size} rows wet)`);
}

console.log('\nGate I — lean');
{
    // The browser wrapper, evaluated here for its pure half (leanPlan).
    globalThis.location = globalThis.location || { href: 'http://localhost/' };
    new Function(readFileSync(join(ROOT, 'arcade-sim-sand.js'), 'utf8'))();
    const leanPlan = globalThis.ArcadeSimSand.leanPlan;

    const p0 = leanPlan(0), p10 = leanPlan(10), m10 = leanPlan(-10), p45 = leanPlan(44.9), p60 = leanPlan(60), p90 = leanPlan(90), p180 = leanPlan(180);
    ok(p0.side === 0 && p0.gx === 0 && p0.gy === 1 && p0.reach === 1 && p0.p === 0 && p0.drift === 0, 'leanPlan(0) is upright with no lean');
    ok(p10.gx === 0 && p10.gy === 1 && p10.side === -1 && p10.reach === 1 && p10.p === 116 && p10.drift === 45,
        'leanPlan(10): still gravity (0,1), leaning to the a side (+x), reach 1 + 116/256, drift 45', JSON.stringify(p10));
    ok(m10.side === 1 && m10.p === p10.p && m10.drift === p10.drift, 'leanPlan(−10) mirrors it');
    ok(p45.gx === 0 && p45.gy === 1 && p45.reach >= 15, 'just under 45° is still the down axis, with the longest look');
    ok(p60.gx === 1 && p60.gy === 0 && p60.side === 1 && p60.reach === leanPlan(30).reach && p60.p === leanPlan(30).p,
        'leanPlan(60): the right wall is the floor now, leaning back 30°');
    ok(p90.gx === 1 && p90.gy === 0 && p90.side === 0 && p180.gx === 0 && p180.gy === -1 && leanPlan(-180).gy === -1 && leanPlan(540).gy === -1,
        '90 is tilt(1,0); ±180 and 540 are upside down');
    let mono = true, last = -1;
    for (let d = 0; d <= 44; d += 0.5) { const q = leanPlan(d); const v = q.reach * 256 + q.p; if (v < last) mono = false; last = v; }
    ok(mono, 'the look only lengthens as the lean grows (0 → 44°, every half degree)');
    let threwPlan = 0; for (const bad of [NaN, Infinity, 'x']) { try { leanPlan(bad); } catch (e) { if (e instanceof RangeError) threwPlan++; } }
    ok(threwPlan === 3, 'leanPlan rejects what is not a finite number');

    // edges
    const ref = createSandReference({ width: 96, height: 64, seed: 5 });
    const wasm = await createWasm({ width: 96, height: 64, seed: 5 });
    ok(String(ref.leaning()) === '0,1,0,0' && String(wasm.leaning()) === '0,1,0,0', 'leaning() starts [0,1,0,0]');
    let threw = 0;
    const BAD = [[2, 1, 0, 0], [-2, 1, 0, 0], [1, 0, 0, 0], [1, 17, 0, 0], [1, 1, 257, 0], [1, 1, -1, 0], [1, 1, 0, 257], [1, 1.5, 0, 0]];
    for (const b of BAD) { try { ref.lean(...b); } catch (e) { if (e instanceof RangeError) threw++; } }
    for (const b of BAD) wasm.lean(...b);
    ok(threw === BAD.length && String(ref.leaning()) === '0,1,0,0', 'reference lean() rejects every out-of-range value with RangeError');
    ok(String(wasm.leaning()) === '0,1,0,0' || String(wasm.leaning()) === '1,1,0,0', 'WASM lean() ignores them');
    wasm.lean(0, 1, 0, 0);
    for (const sim of [ref, wasm]) { for (let i = 0; i < 30; i++) for (let x = 40 - i; x <= 40 + i; x++) sim.paint(SAND, x, 34 + i, 0); for (let k = 0; k < 50 && !sim.quiet(); k++) sim.step(); }
    ok(ref.quiet() && wasm.quiet() && sameBytes(ref.grid, wasm.grid), 'a 45° heap is at rest with no lean');
    ref.lean(0, 1, 0, 0); wasm.lean(0, 1, 0, 0);
    ok(ref.quiet() && wasm.quiet(), 'lean() to the values already set is a no-op: nothing wakes');
    const grains = ref.grid.filter(isSand).length;
    ref.lean(-1, 2, 0, 0); wasm.lean(-1, 2, 0, 0);
    ok(!ref.quiet() && !wasm.quiet(), 'a new lean wakes every chunk');
    let n = 0;
    while (n < 5000 && !(ref.quiet() && wasm.quiet())) { ref.step(); wasm.step(); n++; }
    ok(ref.quiet() && wasm.quiet() && sameBytes(ref.grid, wasm.grid), `the heap re-settles under the lean, identically (${n} steps)`);
    ok(ref.grid.filter(isSand).length === grains, 'leaning conserves grains');
    ref.tilt(1, 1); wasm.tilt(1, 1);
    n = 0;
    while (n < 5000 && !(ref.quiet() && wasm.quiet())) { ref.step(); wasm.step(); n++; }
    ok(ref.quiet() && wasm.quiet() && sameBytes(ref.grid, wasm.grid) && String(ref.leaning()) === '-1,2,0,0',
        `under a DIAGONAL gravity the lean is kept but ignored, and the pile still rests (${n} steps)`);

    // the rest slope is the one leanPlan() promises; the shift is smooth
    const FW = 320, FH = 112;
    function settle(deg, make) {
        const sim = make({ width: FW, height: FH, seed: 3 });
        for (let i = 0; i < 50; i++) for (let x = 80 - i; x <= 80 + i; x++) sim.paint(SAND, x, FH - 50 + i, 0);
        const q = leanPlan(deg);
        sim.tilt(q.gx, q.gy); sim.lean(q.side, q.reach, q.p, q.drift);
        let k = 0; while (k < 20000 && !sim.quiet()) { sim.step(); k++; }
        const hs = []; let sx = 0, cnt = 0;
        for (let x = 0; x < FW; x++) { let y = 0; while (y < FH && sim.get(x, y) === EMPTY) y++; hs.push(y); sx += x * (FH - y); cnt += FH - y; }
        const peak = hs.indexOf(Math.min(...hs));
        const xs = []; for (let x = peak + 4; x < FW; x++) if (hs[x] < FH) xs.push(x);
        const core = xs.slice(4, -4);
        const mx = core.reduce((a, b) => a + b, 0) / core.length, my = core.reduce((a, x) => a + hs[x], 0) / core.length;
        let nu = 0, de = 0; core.forEach((x) => { nu += (x - mx) * (hs[x] - my); de += (x - mx) ** 2; });
        return { rested: k < 20000, face: Math.atan(Math.abs(nu / de)) * 180 / Math.PI, com: sx / cnt, grid: sim.grid };
    }
    const makeRef = (o) => createSandReference(o);
    let worst = 0, allRest = true, shifts = [];
    const faces = [];
    const base = settle(0, makeRef).com;
    for (const deg of [5, 10, 15, 20, 25, 30, 35, 40]) {
        const r = settle(deg, makeRef);
        allRest = allRest && r.rested;
        worst = Math.max(worst, Math.abs(r.face - (45 - deg))); faces.push(`${deg}°→${r.face.toFixed(1)}`);
        shifts.push(r.com - base);
    }
    ok(allRest, 'a heap comes to rest at every lean from 5° to 40°');
    ok(worst < 3, `its downhill face rests at 45° less the lean (worst error ${worst.toFixed(2)}°: ${faces.join(' ')})`);
    ok(shifts.every((v, i) => v > (i ? shifts[i - 1] : 0)) && shifts[0] < 3 && shifts[1] < 6,
        `the heap's shift grows smoothly with the angle — no cliff (${shifts.map((v) => v.toFixed(1)).join(', ')})`);
    const w20 = await (async () => { const sims = []; const r = settle(20, (o) => { const s = createSandReference(o); sims.push(s); return s; }); return r; })();
    const wasmSims = [];
    const mk = await createWasm({ width: FW, height: FH, seed: 3 });
    const rW = settle(20, () => mk);
    ok(sameBytes(w20.grid, rW.grid), 'WASM settles the same heap to the same grid at 20°');

    // drift: what is poured falls at the lean
    const dr = createSandReference({ width: 128, height: 96, seed: 2 });
    const q30 = leanPlan(30);
    dr.lean(q30.side, q30.reach, q30.p, q30.drift);
    dr.paint(SAND, 20, 2, 0);
    let fx = 20, fy = 2, steps = 0;
    while (steps < 60) { dr.step(); steps++; let found = false; for (let y = 0; y < 96 && !found; y++) for (let x = 0; x < 128; x++) if (dr.get(x, y) !== EMPTY) { fx = x; fy = y; found = true; break; } }
    const fallDeg = Math.atan((fx - 20) / (fy - 2)) * 180 / Math.PI;
    ok(Math.abs(fallDeg - 30) < 8, `a single grain falls at about the lean (${fallDeg.toFixed(1)}° for 30°)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
