/* tools/sim/sand-reference.mjs — the falling-sand kernel, in plain JS.
 *
 * THIS FILE IS THE SPECIFICATION. The shipped kernel is assembly/sand.ts
 * compiled to sdk/v3/arcade-sim-sand.wasm, and tools/sim-sand-unit.mjs asserts
 * that for a set of seeds and paint scripts the two grids are byte-identical
 * after every checkpoint. The reference is not shipped and is not a fallback:
 * it exists so a kernel change that alters behaviour fails a test instead of
 * silently forking every player's daily challenge and share code
 * (plans/compiled-kernels-2026-09.md §3). Same posture as arcade-rng.js.
 *
 * So: small, boring, no cleverness that the AssemblyScript port cannot mirror
 * line for line. Typed arrays only, no DOM, runs under node. Every rule below
 * is numbered so a port can be checked against it. Every operation is a pure
 * function of (grid, rng state, arguments) — nothing reads a clock, a setting
 * or Math.random — which is what makes a replayed paint script a share code.
 *
 * ── Rules, v0 ──────────────────────────────────────────────────────────────
 *
 *  R1  Materials: EMPTY=0, SAND=1, WATER=2, WALL=3, and 32 sand TINTS at
 *      SAND_BASE..SAND_BASE+31 = 16..47. Every tint has exactly SAND's
 *      physics; only its palette entry differs. Id 1 is kept as "sand, tint
 *      0" for compatibility and shares tint 0's default colour — but it is a
 *      distinct id in the grid (1 ≠ 16), so a script that mixes them gets two
 *      colours that behave the same. Ids 4..15 and 48..255 are invalid: the
 *      reference throws, the kernel ignores, the wrapper throws before
 *      calling — so no grid ever holds one. The grid is a Uint8Array of
 *      width×height, row-major, y down: index = y*width + x.
 *
 *  R2  A step scans rows bottom-to-top (y = height-1 … 0). Within a row the
 *      horizontal direction alternates: left-to-right when (stepIndex + y)
 *      is even, right-to-left when odd, where stepIndex counts completed
 *      steps from 0. Alternating per step AND per row parity means neither a
 *      pile nor a puddle grows a lean in one direction, and adjacent rows
 *      never sweep the same way in the same step.
 *
 *  R3  A cell moves at most once per step: `moved[j]` is set on the cell a
 *      grain arrives at (and on the cell it left, which matters only when
 *      the thing it displaced was water). WATER is the only material that can
 *      be revisited by the scan after moving (a sideways spread lands on a
 *      cell later in the same row), which is what the flag exists for.
 *
 *  R4  SAND (any tint): if the cell below is EMPTY, or is WATER that has not
 *      moved this step, swap with it (sand sinks through water). Else draw
 *      one rng bit and try the two diagonals below in that order (bit=1 →
 *      right first), each with the same enter rule. Else stay.
 *
 *  R5  WATER: if the cell below is EMPTY, swap. Else draw one rng bit and try
 *      the two diagonals below (EMPTY only). Else draw one more bit and FLOW:
 *      walk along the row in that direction through EMPTY cells, at most
 *      FLOW (8) of them, and move to the first one whose cell below is
 *      EMPTY; if the walk hits a non-EMPTY cell, the edge, or runs out of
 *      reach, walk the other way. Else stay. A sideways move is allowed only
 *      when it leads to a drop: a neutral sideways move (same height, no
 *      drop) would let the surface of a puddle slosh forever, and a kernel
 *      that never goes quiet is a battery bug of the first order (plan §6).
 *      The price is that a puddle on a floor settles into a mesa whose
 *      steps are up to FLOW wide instead of a perfectly flat sheet.
 *      FLOW must stay ≤ CHUNK so R8's neighbourhood argument holds.
 *
 *  R6  WALL and EMPTY never move. Out-of-bounds is never enterable.
 *
 *  R7  The rng is xorshift32 seeded with `seed >>> 0`, or 0x9E3779B9 when
 *      that is zero (xorshift has a fixed point at 0). A draw is one
 *      xorshift round; R4/R5 use the low bit of the new state, R13 the whole
 *      state. Draws happen ONLY where R4/R5/R13 say, so the stream depends
 *      on the scan, and the scan skips inactive chunks (R8): skipping is
 *      deliberately part of the spec, not an optimisation layered over it.
 *
 *  R8  Active chunks: the grid is tiled in 16×16 chunks (partial at the
 *      edges). A chunk is CHANGED in a step if any cell in it was written by
 *      a move or a paint. A chunk is ACTIVE for the next step if it or any of
 *      its 8 neighbours was changed. The scan visits only active chunks; a
 *      cell in an inactive chunk has no legal move (every cell that can move
 *      does move, so "nothing changed near me" implies "I still cannot"),
 *      which is why skipping preserves the physics. quiet() is true when no
 *      chunk is active. Before the first step every chunk is active.
 *
 *  R9  paint(material, x, y, r) writes `material` into every in-bounds cell
 *      with dx²+dy² ≤ r², marks their chunks changed, and clears nothing
 *      else. It does not consume rng. Erasing is paint(EMPTY, …).
 *
 *  R10 activeCells() is the number of cells written by moves in the last
 *      step (2 per swap into EMPTY or WATER — both endpoints change). It is
 *      0 whenever quiet() is true. Hosts use it to notice a source that
 *      never lets the sim settle.
 *
 *  R11 pixels is an RGBA Uint8ClampedArray of width×height×4, mapped from
 *      the grid through a 48-entry palette (4 bytes per material id, ids
 *      0..47; the unused ids 4..15 hold EMPTY's colour) and updated only for
 *      the cells a move or paint wrote. Defaults: EMPTY (16,16,24), SAND and
 *      tint 0 (214,178,92), WATER (52,120,220), WALL (110,110,110), tints
 *      1..31 a hue sweep; alpha 255. setPalette(index, r, g, b, a) replaces
 *      one entry and then REPAINTS THE WHOLE FRAMEBUFFER — O(cells), the
 *      simple honest way to make a palette change visible without a dirty
 *      bit per cell. Call it on a theme change, not per frame. It touches
 *      neither the grid nor the chunks. The batch form
 *      setPalette([[index, r, g, b, a], …]) writes every entry and repaints
 *      once; the kernel exposes the two halves (setPaletteEntry, repaint)
 *      and the wrapper composes them.
 *
 *  R12 nudge(x, y, r, dx, dy) — the stick. Every movable cell (sand tints,
 *      water; never wall) with dx²+dy² ≤ r² of (x,y) moves by the integer
 *      offset (dx,dy) if its destination is in bounds and EMPTY. Cells are
 *      visited FRONT FIRST — rows from the (dy) end of the disc toward the
 *      other, columns from the (dx) end — so the cell ahead has already
 *      vacated before the cell behind tries to follow it, and no cell is
 *      visited again at its own destination. Touched chunks are marked
 *      changed and active is recomputed so the pile re-settles. No rng.
 *      (0,0) is a no-op.
 *
 *  R13 stir(x, y, r) — every non-WALL cell in the disc, in row-major order,
 *      draws two rng values a, b and picks the partner
 *      (x - r + a mod (2r+1), y - r + b mod (2r+1)); if the partner is in
 *      the disc, in bounds, not WALL and holds a different material, the
 *      two swap. Chunks are marked and active recomputed. The draws happen
 *      whether or not the swap does, so the stream advances by exactly
 *      2 × (disc cells that are not WALL).
 *
 *  R14 clear() — every cell EMPTY, every chunk quiet (quiet() is true
 *      immediately), framebuffer repainted, activeCells() 0. The rng stream
 *      and stepIndex are NOT reset: a clear mid-session is a new picture on
 *      the same stream. reseed(seed) resets both, so clear() + reseed(s) is
 *      indistinguishable from a fresh sim with seed s.
 *
 *  R15 load(bytes) — replace the whole grid from a width×height byte array.
 *      A wrong length or any invalid id is a RangeError thrown BEFORE the
 *      grid is touched. Then: moved cleared, EVERY chunk active (so the next
 *      step settles whatever the picture left unsupported), activeCells() 0,
 *      framebuffer repainted. The rng stream and stepIndex are untouched —
 *      a replay that wants a known stream calls reseed() too. Pure function
 *      of its input; the byte array is copied, never aliased.
 *
 *  R16 replace(from, to, x, y, r) — every cell in the disc whose material
 *      is `from` becomes `to`; both must be valid ids (reference throws,
 *      kernel ignores, wrapper throws). to=EMPTY is a stencil erase,
 *      from=tint(a) to=tint(b) a recolour. Touched chunks are marked and
 *      active recomputed. No rng.
 */

export const EMPTY = 0, SAND = 1, WATER = 2, WALL = 3;
export const SAND_BASE = 16, SAND_COUNT = 32;
export const PALETTE_SIZE = 48;
export const CHUNK = 16;
export const FLOW = 8;

export function isSand(m) { return m === SAND || (m >= SAND_BASE && m < SAND_BASE + SAND_COUNT); }
export function isMaterial(m) { return (m >= EMPTY && m <= WALL) || (m >= SAND_BASE && m < SAND_BASE + SAND_COUNT); }
// Movable = takes part in R4/R5/R12/R13: sand tints and water.
function isMovable(m) { return m === WATER || isSand(m); }

// R11 — the default palette, 4 bytes per id for ids 0..47.
export const PALETTE = new Uint8Array(PALETTE_SIZE * 4);
{
    const base = [
        16, 16, 24, 255,      // EMPTY
        214, 178, 92, 255,    // SAND (== tint 0)
        52, 120, 220, 255,    // WATER
        110, 110, 110, 255,   // WALL
    ];
    const tints = [
        214, 178, 92, 255,    // tint 0 == SAND
        212, 169, 73, 255,
        212, 195, 73, 255,
        204, 212, 73, 255,
        178, 212, 73, 255,
        151, 212, 73, 255,
        125, 212, 73, 255,
        99, 212, 73, 255,
        73, 212, 73, 255,
        73, 212, 99, 255,
        73, 212, 125, 255,
        73, 212, 151, 255,
        73, 212, 178, 255,
        73, 212, 204, 255,
        73, 195, 212, 255,
        73, 169, 212, 255,
        73, 143, 212, 255,
        73, 117, 212, 255,
        73, 91, 212, 255,
        82, 73, 212, 255,
        108, 73, 212, 255,
        134, 73, 212, 255,
        160, 73, 212, 255,
        186, 73, 212, 255,
        212, 73, 212, 255,
        212, 73, 186, 255,
        212, 73, 160, 255,
        212, 73, 134, 255,
        212, 73, 108, 255,
        212, 73, 82, 255,
        212, 91, 73, 255,
        212, 117, 73, 255,
    ];
    PALETTE.set(base, 0);
    for (let i = 4; i < SAND_BASE; i++) PALETTE.set(base.slice(0, 4), i * 4); // unused ids read as EMPTY
    PALETTE.set(tints, SAND_BASE * 4);
}

export function createSandReference({ width, height, seed = 1 }) {
    if (!(width > 0 && height > 0) || width !== (width | 0) || height !== (height | 0)) {
        throw new RangeError('createSandReference: width and height must be positive integers');
    }
    const w = width | 0, h = height | 0, n = w * h;
    const grid = new Uint8Array(n);
    const moved = new Uint8Array(n);
    const pixels = new Uint8ClampedArray(n * 4);
    const palette = new Uint8Array(PALETTE);   // per-instance copy (R11)
    const cw = Math.ceil(w / CHUNK), ch = Math.ceil(h / CHUNK), nc = cw * ch;
    const changed = new Uint8Array(nc);  // written this step (R8)
    const active = new Uint8Array(nc);   // scanned next step (R8)
    active.fill(1);                      // R8: everything active before the first step
    let rng = (seed >>> 0) || 0x9E3779B9; // R7
    let stepIndex = 0;
    let lastMoves = 0;                    // R10

    for (let i = 0; i < n; i++) setPixel(i, EMPTY);

    function setPixel(i, m) {
        const p = i << 2, q = m << 2;
        pixels[p] = palette[q];
        pixels[p + 1] = palette[q + 1];
        pixels[p + 2] = palette[q + 2];
        pixels[p + 3] = palette[q + 3];
    }

    // R7 — one xorshift32 round; returns the whole new state.
    function next() {
        let x = rng;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        rng = x >>> 0;
        return rng;
    }
    function bit() { return next() & 1; }

    function touch(x, y) {
        changed[((y / CHUNK) | 0) * cw + ((x / CHUNK) | 0)] = 1;
    }

    // Move the grain at i into j (which holds EMPTY or WATER): a swap. Both
    // endpoints are written, so both are marked moved and both chunks touched.
    function swap(i, j, xi, yi, xj, yj) {
        const a = grid[i], b = grid[j];
        grid[j] = a; grid[i] = b;
        moved[j] = 1; moved[i] = 1;
        setPixel(i, b); setPixel(j, a);
        touch(xi, yi); touch(xj, yj);
        lastMoves += 2;
    }

    // R4 enter rule for sand; R5's is `grid[j] === EMPTY` inline.
    function sandCanEnter(j) {
        const m = grid[j];
        return m === EMPTY || (m === WATER && moved[j] === 0);
    }

    // R5 FLOW — the x of the first EMPTY cell within FLOW of (x,y) in
    // direction `side` that has an EMPTY cell below it, or -1. The walk stops
    // at the first non-EMPTY cell: water does not pass through anything.
    function flowTarget(x, y, side) {
        if (y + 1 >= h) return -1;
        const row = y * w;
        for (let d = 1; d <= FLOW; d++) {
            const xx = x + side * d;
            if (xx < 0 || xx >= w) return -1;
            if (grid[row + xx] !== EMPTY) return -1;
            if (grid[row + w + xx] === EMPTY) return xx;
        }
        return -1;
    }

    function stepOnce() {
        moved.fill(0);
        changed.fill(0);
        lastMoves = 0;
        for (let y = h - 1; y >= 0; y--) {
            const below = y + 1 < h;
            const crow = ((y / CHUNK) | 0) * cw;
            const ltr = ((stepIndex + y) & 1) === 0;          // R2
            let x = ltr ? 0 : w - 1;
            const dx = ltr ? 1 : -1;
            while (x >= 0 && x < w) {
                // R8 — skip a whole inactive chunk in one hop.
                if (active[crow + ((x / CHUNK) | 0)] === 0) {
                    x = ltr ? (((x / CHUNK) | 0) + 1) * CHUNK : ((x / CHUNK) | 0) * CHUNK - 1;
                    continue;
                }
                const i = y * w + x;
                const m = grid[i];
                if (isSand(m) && moved[i] === 0) {
                    if (below) {
                        const j = i + w;
                        if (sandCanEnter(j)) { swap(i, j, x, y, x, y + 1); x += dx; continue; }
                        const first = bit() ? 1 : -1;
                        const x1 = x + first, x2 = x - first;
                        if (x1 >= 0 && x1 < w && sandCanEnter(j + first)) { swap(i, j + first, x, y, x1, y + 1); x += dx; continue; }
                        if (x2 >= 0 && x2 < w && sandCanEnter(j - first)) { swap(i, j - first, x, y, x2, y + 1); x += dx; continue; }
                    }
                } else if (m === WATER && moved[i] === 0) {
                    if (below) {
                        const j = i + w;
                        if (grid[j] === EMPTY) { swap(i, j, x, y, x, y + 1); x += dx; continue; }
                        const first = bit() ? 1 : -1;
                        const x1 = x + first, x2 = x - first;
                        if (x1 >= 0 && x1 < w && grid[j + first] === EMPTY) { swap(i, j + first, x, y, x1, y + 1); x += dx; continue; }
                        if (x2 >= 0 && x2 < w && grid[j - first] === EMPTY) { swap(i, j - first, x, y, x2, y + 1); x += dx; continue; }
                    }
                    const side = bit() ? 1 : -1;
                    let t = flowTarget(x, y, side);
                    if (t < 0) t = flowTarget(x, y, -side);
                    if (t >= 0) { swap(i, y * w + t, x, y, t, y); x += dx; continue; }
                }
                x += dx;
            }
        }
        stepIndex++;
        recomputeActive();
    }

    // R8 — active = changed dilated by one chunk in every direction.
    function recomputeActive() {
        for (let cy = 0; cy < ch; cy++) {
            for (let cx = 0; cx < cw; cx++) {
                let a = 0;
                for (let ny = cy - 1; ny <= cy + 1 && !a; ny++) {
                    if (ny < 0 || ny >= ch) continue;
                    for (let nx = cx - 1; nx <= cx + 1; nx++) {
                        if (nx < 0 || nx >= cw) continue;
                        if (changed[ny * cw + nx]) { a = 1; break; }
                    }
                }
                active[cy * cw + cx] = a;
            }
        }
    }

    // Write material m at (x,y) outside a step: grid, pixel, chunk.
    function put(x, y, m) {
        const i = y * w + x;
        grid[i] = m;
        setPixel(i, m);
        touch(x, y);
    }

    return {
        width: w,
        height: h,
        grid,
        pixels,
        palette,
        step(count = 1) {
            for (let k = 0; k < count; k++) stepOnce();
        },
        // R9
        paint(material, x, y, r) {
            material |= 0; x |= 0; y |= 0; r |= 0;
            if (!isMaterial(material)) throw new RangeError('paint: unknown material ' + material);
            if (r < 0) return;
            const r2 = r * r;
            let any = false;
            for (let yy = y - r; yy <= y + r; yy++) {
                if (yy < 0 || yy >= h) continue;
                for (let xx = x - r; xx <= x + r; xx++) {
                    if (xx < 0 || xx >= w) continue;
                    const ddx = xx - x, ddy = yy - y;
                    if (ddx * ddx + ddy * ddy > r2) continue;
                    put(xx, yy, material);
                    any = true;
                }
            }
            // A paint between steps must wake its chunks for the NEXT scan;
            // active is otherwise only recomputed at the end of a step.
            if (any) recomputeActive();
        },
        // R12
        nudge(x, y, r, dx, dy) {
            x |= 0; y |= 0; r |= 0; dx |= 0; dy |= 0;
            if (r < 0 || (dx === 0 && dy === 0)) return;
            const r2 = r * r;
            const y0 = dy >= 0 ? y + r : y - r, ys = dy >= 0 ? -1 : 1;
            const x0 = dx >= 0 ? x + r : x - r, xs = dx >= 0 ? -1 : 1;
            let any = false;
            for (let k = 0, yy = y0; k <= 2 * r; k++, yy += ys) {
                if (yy < 0 || yy >= h) continue;
                for (let l = 0, xx = x0; l <= 2 * r; l++, xx += xs) {
                    if (xx < 0 || xx >= w) continue;
                    const ddx = xx - x, ddy = yy - y;
                    if (ddx * ddx + ddy * ddy > r2) continue;
                    const m = grid[yy * w + xx];
                    if (!isMovable(m)) continue;
                    const tx = xx + dx, ty = yy + dy;
                    if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
                    if (grid[ty * w + tx] !== EMPTY) continue;
                    put(tx, ty, m);
                    put(xx, yy, EMPTY);
                    any = true;
                }
            }
            if (any) recomputeActive();
        },
        // R13
        stir(x, y, r) {
            x |= 0; y |= 0; r |= 0;
            if (r < 0) return;
            const r2 = r * r, span = 2 * r + 1;
            let any = false;
            for (let yy = y - r; yy <= y + r; yy++) {
                if (yy < 0 || yy >= h) continue;
                for (let xx = x - r; xx <= x + r; xx++) {
                    if (xx < 0 || xx >= w) continue;
                    const ddx = xx - x, ddy = yy - y;
                    if (ddx * ddx + ddy * ddy > r2) continue;
                    const m = grid[yy * w + xx];
                    if (m === WALL) continue;
                    const a = next(), b = next();
                    const tx = x - r + (a % span), ty = y - r + (b % span);
                    const tdx = tx - x, tdy = ty - y;
                    if (tdx * tdx + tdy * tdy > r2) continue;
                    if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
                    const o = grid[ty * w + tx];
                    if (o === WALL || o === m) continue;
                    put(tx, ty, m);
                    put(xx, yy, o);
                    any = true;
                }
            }
            if (any) recomputeActive();
        },
        // R14
        clear() {
            grid.fill(EMPTY);
            moved.fill(0);
            changed.fill(0);
            active.fill(0);
            lastMoves = 0;
            for (let i = 0; i < n; i++) setPixel(i, EMPTY);
        },
        reseed(seed) {
            rng = (seed >>> 0) || 0x9E3779B9;
            stepIndex = 0;
        },
        // R11 — the two halves, and the composed forms.
        setPaletteEntry(index, r, g, b, a = 255) {
            index |= 0;
            if (index < 0 || index >= PALETTE_SIZE) return;
            const q = index << 2;
            palette[q] = r & 255; palette[q + 1] = g & 255; palette[q + 2] = b & 255; palette[q + 3] = a & 255;
        },
        repaint() {
            for (let i = 0; i < n; i++) setPixel(i, grid[i]);
        },
        setPalette(index, r, g, b, a = 255) {
            if (Array.isArray(index)) {
                for (const e of index) this.setPaletteEntry(e[0], e[1], e[2], e[3], e.length > 4 ? e[4] : 255);
            } else {
                this.setPaletteEntry(index, r, g, b, a);
            }
            this.repaint();
        },
        // R15
        load(bytes) {
            if (!(bytes instanceof Uint8Array) || bytes.length !== n) {
                throw new RangeError('load: expected a Uint8Array of ' + n + ' bytes');
            }
            for (let i = 0; i < n; i++) {
                if (!isMaterial(bytes[i])) throw new RangeError('load: invalid material ' + bytes[i] + ' at index ' + i);
            }
            grid.set(bytes);
            moved.fill(0);
            active.fill(1);
            lastMoves = 0;
            for (let i = 0; i < n; i++) setPixel(i, grid[i]);
        },
        // R16
        replace(from, to, x, y, r) {
            from |= 0; to |= 0; x |= 0; y |= 0; r |= 0;
            if (!isMaterial(from) || !isMaterial(to)) throw new RangeError('replace: unknown material ' + (isMaterial(from) ? to : from));
            if (r < 0 || from === to) return;
            const r2 = r * r;
            let any = false;
            for (let yy = y - r; yy <= y + r; yy++) {
                if (yy < 0 || yy >= h) continue;
                for (let xx = x - r; xx <= x + r; xx++) {
                    if (xx < 0 || xx >= w) continue;
                    const ddx = xx - x, ddy = yy - y;
                    if (ddx * ddx + ddy * ddy > r2) continue;
                    if (grid[yy * w + xx] !== from) continue;
                    put(xx, yy, to);
                    any = true;
                }
            }
            if (any) recomputeActive();
        },
        get(x, y) {
            x |= 0; y |= 0;
            if (x < 0 || y < 0 || x >= w || y >= h) return EMPTY;
            return grid[y * w + x];
        },
        quiet() {
            for (let c = 0; c < nc; c++) if (active[c]) return false;
            return true;
        },
        activeCells() { return lastMoves; },
    };
}

// FNV-1a over a byte array → u32. The known-answer suite pins a few of these
// so a rule change is loud; the acceptance fixture computes the same thing in
// the browser and compares against node.
export function fnv1a(bytes) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}
