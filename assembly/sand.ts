// assembly/sand.ts — the falling-sand kernel, compiled to
// sdk/v3/arcade-sim-sand.wasm by `npm run build:sim-sand`.
//
// This is a PORT, not a design: tools/sim/sand-reference.mjs is the
// specification, its rule numbers (R1–R14) are cited below, and
// tools/sim-sand-unit.mjs asserts the two grids are byte-identical after every
// checkpoint of every known-answer script. Change the rules there first, mirror
// them here, and let the gate prove the mirror. The compiled binary is checked
// in and tools/sim-sand-build-unit.mjs rebuilds and byte-compares it, so a
// source edit without a rebuild fails CI too.
//
// Why AssemblyScript: TypeScript syntax, an npm devDependency, no toolchain
// action in fleet CI, and `--runtime stub` gives a binary in the low tens of
// KB with no GC and no imports (plan §3). The arena below is laid out by hand
// from __heap_base rather than through `new Uint8Array` so that init() is
// idempotent — a second init() reuses the same offsets instead of leaking an
// arena the stub runtime can never free.
//
// Memory layout after init(w, h, seed), all offsets 16-byte aligned:
//
//   palettePtr 48*4 bytes  RGBA per material id (R11), defaults copied in
//   gridPtr    w*h bytes   Uint8 material per cell (R1)
//   movedPtr   w*h bytes   moved-this-step flag (R3)
//   changedPtr cw*ch bytes chunk written this step (R8)
//   activePtr  cw*ch bytes chunk scanned next step (R8)
//   pixelsPtr  w*h*4 bytes RGBA framebuffer (R11)
//
// The host reads grid, palette and pixels straight out of exported memory;
// nothing is ever copied out of the module.

const EMPTY: u8 = 0;
const SAND: u8 = 1;
const WATER: u8 = 2;
const WALL: u8 = 3;
const SAND_BASE: u8 = 16;
const SAND_COUNT: u8 = 32;
const PALETTE_SIZE: i32 = 48;
const CHUNK: i32 = 16;
const FLOW: i32 = 8;

// R11 — the default palette, 4 bytes per id for ids 0..47. Static data lives
// below __heap_base, so it never collides with the arena; init() copies it
// into the per-instance palette so setPalette() has something to overwrite.
const PALETTE_DEFAULT = memory.data<u8>([
  16, 16, 24, 255,      // 0 EMPTY
  214, 178, 92, 255,    // 1 SAND (== tint 0)
  52, 120, 220, 255,    // 2 WATER
  110, 110, 110, 255,   // 3 WALL
  16, 16, 24, 255, 16, 16, 24, 255, 16, 16, 24, 255, 16, 16, 24, 255,   // 4..7 unused → EMPTY
  16, 16, 24, 255, 16, 16, 24, 255, 16, 16, 24, 255, 16, 16, 24, 255,   // 8..11
  16, 16, 24, 255, 16, 16, 24, 255, 16, 16, 24, 255, 16, 16, 24, 255,   // 12..15
  214, 178, 92, 255,    // 16 tint 0 == SAND
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
  212, 117, 73, 255,    // 47 tint 31
]);

let w: i32 = 0;
let h: i32 = 0;
let n: i32 = 0;
let cw: i32 = 0;
let ch: i32 = 0;
let nc: i32 = 0;
let palette: usize = 0;
let grid: usize = 0;
let moved: usize = 0;
let changed: usize = 0;
let active: usize = 0;
let pixels: usize = 0;
let rng: u32 = 1;
let stepIndex: i32 = 0;
let lastMoves: i32 = 0;

function align16(p: usize): usize {
  return (p + 15) & ~<usize>15;
}

@inline
function isSand(m: u8): bool {
  return m == SAND || (m >= SAND_BASE && m < SAND_BASE + SAND_COUNT);
}

@inline
function isMaterial(m: i32): bool {
  return (m >= <i32>EMPTY && m <= <i32>WALL) || (m >= <i32>SAND_BASE && m < <i32>SAND_BASE + <i32>SAND_COUNT);
}

@inline
function isMovable(m: u8): bool {
  return m == WATER || isSand(m);
}

@inline
function setPixel(i: i32, m: u8): void {
  store<u32>(pixels + (<usize>i << 2), load<u32>(palette + (<usize>m << 2)));
}

// R7 — one xorshift32 round; returns the whole new state.
@inline
function next(): u32 {
  let x = rng;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  rng = x;
  return x;
}

@inline
function bit(): u32 {
  return next() & 1;
}

@inline
function touch(x: i32, y: i32): void {
  store<u8>(changed + <usize>((y / CHUNK) * cw + (x / CHUNK)), 1);
}

// Move the grain at i into j (which holds EMPTY or WATER): a swap. Both
// endpoints are written, so both are marked moved and both chunks touched.
function swap(i: i32, j: i32, xi: i32, yi: i32, xj: i32, yj: i32): void {
  const a = load<u8>(grid + <usize>i);
  const b = load<u8>(grid + <usize>j);
  store<u8>(grid + <usize>j, a);
  store<u8>(grid + <usize>i, b);
  store<u8>(moved + <usize>j, 1);
  store<u8>(moved + <usize>i, 1);
  setPixel(i, b);
  setPixel(j, a);
  touch(xi, yi);
  touch(xj, yj);
  lastMoves += 2;
}

// R4 enter rule for sand; R5's is `== EMPTY` inline.
@inline
function sandCanEnter(j: i32): bool {
  const m = load<u8>(grid + <usize>j);
  return m == EMPTY || (m == WATER && load<u8>(moved + <usize>j) == 0);
}

// R5 FLOW — the x of the first EMPTY cell within FLOW of (x,y) in direction
// `side` that has an EMPTY cell below it, or -1.
function flowTarget(x: i32, y: i32, side: i32): i32 {
  if (y + 1 >= h) return -1;
  const row = y * w;
  for (let d = 1; d <= FLOW; d++) {
    const xx = x + side * d;
    if (xx < 0 || xx >= w) return -1;
    if (load<u8>(grid + <usize>(row + xx)) != EMPTY) return -1;
    if (load<u8>(grid + <usize>(row + w + xx)) == EMPTY) return xx;
  }
  return -1;
}

// R8 — active = changed dilated by one chunk in every direction.
function recomputeActive(): void {
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let a: u8 = 0;
      for (let ny = cy - 1; ny <= cy + 1 && !a; ny++) {
        if (ny < 0 || ny >= ch) continue;
        for (let nx = cx - 1; nx <= cx + 1; nx++) {
          if (nx < 0 || nx >= cw) continue;
          if (load<u8>(changed + <usize>(ny * cw + nx))) { a = 1; break; }
        }
      }
      store<u8>(active + <usize>(cy * cw + cx), a);
    }
  }
}

// Write material m at (x,y) outside a step: grid, pixel, chunk.
@inline
function put(x: i32, y: i32, m: u8): void {
  const i = y * w + x;
  store<u8>(grid + <usize>i, m);
  setPixel(i, m);
  touch(x, y);
}

function stepOnce(): void {
  memory.fill(moved, 0, <usize>n);
  memory.fill(changed, 0, <usize>nc);
  lastMoves = 0;
  for (let y = h - 1; y >= 0; y--) {
    const below = y + 1 < h;
    const crow = (y / CHUNK) * cw;
    const ltr = ((stepIndex + y) & 1) == 0;                // R2
    let x = ltr ? 0 : w - 1;
    const dx = ltr ? 1 : -1;
    while (x >= 0 && x < w) {
      // R8 — skip a whole inactive chunk in one hop.
      if (load<u8>(active + <usize>(crow + x / CHUNK)) == 0) {
        x = ltr ? (x / CHUNK + 1) * CHUNK : (x / CHUNK) * CHUNK - 1;
        continue;
      }
      const i = y * w + x;
      const m = load<u8>(grid + <usize>i);
      if (isSand(m) && load<u8>(moved + <usize>i) == 0) {
        if (below) {
          const j = i + w;
          if (sandCanEnter(j)) { swap(i, j, x, y, x, y + 1); x += dx; continue; }
          const first: i32 = bit() ? 1 : -1;
          const x1 = x + first, x2 = x - first;
          if (x1 >= 0 && x1 < w && sandCanEnter(j + first)) { swap(i, j + first, x, y, x1, y + 1); x += dx; continue; }
          if (x2 >= 0 && x2 < w && sandCanEnter(j - first)) { swap(i, j - first, x, y, x2, y + 1); x += dx; continue; }
        }
      } else if (m == WATER && load<u8>(moved + <usize>i) == 0) {
        if (below) {
          const j = i + w;
          if (load<u8>(grid + <usize>j) == EMPTY) { swap(i, j, x, y, x, y + 1); x += dx; continue; }
          const first: i32 = bit() ? 1 : -1;
          const x1 = x + first, x2 = x - first;
          if (x1 >= 0 && x1 < w && load<u8>(grid + <usize>(j + first)) == EMPTY) { swap(i, j + first, x, y, x1, y + 1); x += dx; continue; }
          if (x2 >= 0 && x2 < w && load<u8>(grid + <usize>(j - first)) == EMPTY) { swap(i, j - first, x, y, x2, y + 1); x += dx; continue; }
        }
        const side: i32 = bit() ? 1 : -1;
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

// ── exports ───────────────────────────────────────────────────────────────

// Lay out the arena, grow memory to fit, clear everything, paint EMPTY.
// Returns 1 on success, 0 if the dimensions are unusable. Calling it again
// re-initialises in place (palette included).
export function init(width: i32, height: i32, seed: u32): i32 {
  if (width <= 0 || height <= 0) return 0;
  w = width; h = height; n = w * h;
  cw = (w + CHUNK - 1) / CHUNK;
  ch = (h + CHUNK - 1) / CHUNK;
  nc = cw * ch;
  let p = align16(__heap_base);
  palette = p; p = align16(p + <usize>(PALETTE_SIZE << 2));
  grid = p; p = align16(p + <usize>n);
  moved = p; p = align16(p + <usize>n);
  changed = p; p = align16(p + <usize>nc);
  active = p; p = align16(p + <usize>nc);
  pixels = p; p = align16(p + <usize>(n << 2));
  const need = <i32>((p + 0xFFFF) >> 16) - memory.size();
  if (need > 0 && memory.grow(need) < 0) return 0;
  memory.copy(palette, PALETTE_DEFAULT, <usize>(PALETTE_SIZE << 2));
  memory.fill(grid, 0, <usize>n);
  memory.fill(moved, 0, <usize>n);
  memory.fill(changed, 0, <usize>nc);
  memory.fill(active, 1, <usize>nc);                     // R8: all active before step 0
  rng = seed != 0 ? seed : 0x9E3779B9;                   // R7
  stepIndex = 0;
  lastMoves = 0;
  for (let i = 0; i < n; i++) setPixel(i, EMPTY);
  return 1;
}

export function step(count: i32): void {
  for (let k = 0; k < count; k++) stepOnce();
}

// R9. An unknown material is a no-op here; the JS wrapper throws before
// calling, and the reference throws, so the two never disagree on a grid.
export function paint(material: i32, x: i32, y: i32, r: i32): void {
  if (!isMaterial(material)) return;
  if (r < 0) return;
  const m = <u8>material;
  const r2 = r * r;
  let any = false;
  for (let yy = y - r; yy <= y + r; yy++) {
    if (yy < 0 || yy >= h) continue;
    for (let xx = x - r; xx <= x + r; xx++) {
      if (xx < 0 || xx >= w) continue;
      const ddx = xx - x, ddy = yy - y;
      if (ddx * ddx + ddy * ddy > r2) continue;
      put(xx, yy, m);
      any = true;
    }
  }
  if (any) recomputeActive();
}

// R12 — the stick. Front-first disc scan; see the reference for why.
export function nudge(x: i32, y: i32, r: i32, dx: i32, dy: i32): void {
  if (r < 0 || (dx == 0 && dy == 0)) return;
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
      const m = load<u8>(grid + <usize>(yy * w + xx));
      if (!isMovable(m)) continue;
      const tx = xx + dx, ty = yy + dy;
      if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
      if (load<u8>(grid + <usize>(ty * w + tx)) != EMPTY) continue;
      put(tx, ty, m);
      put(xx, yy, EMPTY);
      any = true;
    }
  }
  if (any) recomputeActive();
}

// R13 — seeded shuffle within a disc.
export function stir(x: i32, y: i32, r: i32): void {
  if (r < 0) return;
  const r2 = r * r;
  const span: u32 = <u32>(2 * r + 1);
  let any = false;
  for (let yy = y - r; yy <= y + r; yy++) {
    if (yy < 0 || yy >= h) continue;
    for (let xx = x - r; xx <= x + r; xx++) {
      if (xx < 0 || xx >= w) continue;
      const ddx = xx - x, ddy = yy - y;
      if (ddx * ddx + ddy * ddy > r2) continue;
      const m = load<u8>(grid + <usize>(yy * w + xx));
      if (m == WALL) continue;
      const a = next(), b = next();
      const tx = x - r + <i32>(a % span), ty = y - r + <i32>(b % span);
      const tdx = tx - x, tdy = ty - y;
      if (tdx * tdx + tdy * tdy > r2) continue;
      if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
      const o = load<u8>(grid + <usize>(ty * w + tx));
      if (o == WALL || o == m) continue;
      put(tx, ty, m);
      put(xx, yy, o);
      any = true;
    }
  }
  if (any) recomputeActive();
}

// R14 — a new picture on the same rng stream.
export function clear(): void {
  memory.fill(grid, 0, <usize>n);
  memory.fill(moved, 0, <usize>n);
  memory.fill(changed, 0, <usize>nc);
  memory.fill(active, 0, <usize>nc);
  lastMoves = 0;
  for (let i = 0; i < n; i++) setPixel(i, EMPTY);
}

// R14 — restart the stream and the scan parity; clear()+reseed(s) ≡ fresh.
export function reseed(seed: u32): void {
  rng = seed != 0 ? seed : 0x9E3779B9;
  stepIndex = 0;
}

// R11 — replace one palette entry and repaint the whole framebuffer.
export function setPalette(index: i32, r: i32, g: i32, b: i32, a: i32): void {
  if (index < 0 || index >= PALETTE_SIZE) return;
  const q = palette + (<usize>index << 2);
  store<u8>(q, <u8>r);
  store<u8>(q + 1, <u8>g);
  store<u8>(q + 2, <u8>b);
  store<u8>(q + 3, <u8>a);
  for (let i = 0; i < n; i++) setPixel(i, load<u8>(grid + <usize>i));
}

export function get(x: i32, y: i32): i32 {
  if (x < 0 || y < 0 || x >= w || y >= h) return <i32>EMPTY;
  return <i32>load<u8>(grid + <usize>(y * w + x));
}

export function quiet(): i32 {
  for (let c = 0; c < nc; c++) if (load<u8>(active + <usize>c)) return 0;
  return 1;
}

export function activeCells(): i32 {
  return lastMoves;
}

export function gridPtr(): usize {
  return grid;
}

export function pixelsPtr(): usize {
  return pixels;
}

export function palettePtr(): usize {
  return palette;
}
