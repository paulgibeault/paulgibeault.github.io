# Compiled simulation kernels — design and work packages

*2026-09-12. Exploration prompted by "compiled libraries for processing gameplay
elements, starting with a particle system, for Shui Guo Tan and a sand game."
Companion to `framework-evolution.md` Workstream D (item 5, `Arcade.tween` +
`Arcade.fx.burst`) which this plan does NOT replace — see §7.*

Design stance, in one paragraph: a compiled kernel is worth shipping when a
game's per-frame work is a large, regular, integer-or-float array walk that
must be deterministic. A falling-sand cellular automaton is exactly that.
Decorative particles are not, and Shui Guo Tan's are already closed-form.
So the first kernel is **sand**, shipped as an SDK companion module the way
`arcade-audio.js` already is, with a JS reference implementation as its
specification and a node-only build that fits the fleet CI as it stands.
Battery is won by **frames not run**, not by faster frames: every kernel must
report quietness so the host can let the loop reach 0 fps (GAME_INTEGRATION
§6d). Compilation buys CPU per frame; that is the second prize, not the first.

## 0. The verdict on Shui Guo Tan

Read before assuming the fruit game benefits. It does not, from a particle
kernel.

- `js/effects.js` is analytic: each droplet stores birth time and initial
  velocity, and its position is a formula of elapsed time. No per-frame
  integration exists to compile. Bursts are 6–20 droplets; a chain of
  merges puts perhaps 40 on screen. Under power saver the host's `rest()`
  already stops the loop the moment `isQuiet(fx)` and `isSettled(g)` agree.
- The real per-frame costs are (a) `js/physics.js` — an all-pairs circle
  solver run `PHYS.substeps × PHYS.solverIters` = 24 times per frame, and
  (b) `js/fruit-art.js` — every fruit repainted procedurally with gradients
  every frame. At Suika-scale body counts (a) is sub-millisecond in a JIT;
  (b) is the likely dominant cost and its remedy is sprite caching per radius
  bucket in JS, not WASM.

**WP0 (below) is a measurement, not an implementation.** No solver kernel is
planned for Shui Guo Tan unless the trace says the solver is the cost.

## 1. What the sandbox permits — verified 2026-09-12

Game frames mount `sandbox="allow-scripts allow-downloads"`
(`arcade-pool.js:130`), so games run at an **opaque origin**. Probed with
Playwright Chromium against a local static server with an iframe carrying
exactly those flags:

| Capability | Result | Design consequence |
|---|---|---|
| `WebAssembly.instantiate` (bytes) | works | baseline load path |
| `WebAssembly.instantiateStreaming(fetch(...))` | works | needs `application/wasm`; fall back to bytes if a host mis-types it |
| WASM SIMD (`v128`) | validates | available for a later pass; do not design around it |
| `new Worker('/g/w.js')` | **throws** — "cannot be accessed from origin 'null'" | a URL worker is impossible from a game frame |
| Worker from a blob URL | works | fetch the script, wrap in a Blob, construct — one self-contained file, no relative `import` |
| WASM inside a blob worker | works | worker-hosted sims are possible |
| `OffscreenCanvas` transferred to a worker | works, draws | a worker can own the canvas |
| `SharedArrayBuffer` / `crossOriginIsolated` | **absent** | GitHub Pages sends no COOP/COEP: no shared memory, no wasm threads; worker↔main is `postMessage` + transferables |

No CSP is served by GitHub Pages (none is set in `index.html` either), so no
`wasm-unsafe-eval` question arises.

**Default placement is the main thread inside `Arcade.loop`.** That gives
suspend/resume, `kick()`, and the "suspended time never appears in a delta"
guarantee for free, and the sand grid renders with one `putImageData` from a
view over WASM memory with zero copies. A blob-URL worker is the escape hatch
for a sim that measurably starves input, and it pays a transfer per frame.

## 2. Where a kernel earns its keep

A falling-sand automaton: hundreds of thousands of cells, each an integer
material id, stepped every frame with neighbour reads and swaps. Memory-bound,
branchy, embarrassingly regular. It maps onto WASM linear memory directly:

- the cell grid lives in WASM memory (`Uint8` material + `Uint8` flags or a
  packed `Uint32`), JS never copies it;
- the kernel also maintains an RGBA framebuffer in the same memory, palette
  mapped, so the host's whole render is `putImageData` of a
  `Uint8ClampedArray` view over `memory.buffer` (re-created only when memory
  grows);
- integer-only stepping with a seeded xorshift inside the kernel makes the sim
  **bit-identical across devices**. Seeded from `Arcade.rng` this gives share
  codes, daily challenges and, later, P2P lockstep for free. Shui Guo Tan
  explicitly does not want physics determinism; the sand game should want
  nothing else.

## 3. Framework fit — the shape

**Companion module, not SDK core.** Exactly the `arcade-audio.js` pattern:

```
/sdk/v3/arcade-sim-sand.js      public API, loads and wraps the binary
/sdk/v3/arcade-sim-sand.wasm    implementation detail behind it
/arcade-sim-sand.js             evergreen alias (root copy, byte-identical)
```

- `sw.js` already precaches everything under the `sdk/` prefix (`sw.js:153`);
  the root alias joins the explicit list. Bump `CACHE_NAME` per the SDK
  release procedure in `sdk/CHANGELOG.md`.
- A game loads it with one root-relative `<script>` after the SDK, as the
  audio module is loaded today. Its own `stage.mjs` precache walk needs
  nothing new — the binary is a launcher-origin asset.
- **No wire caps.** Nothing here crosses `welcome.caps`; semver in the
  changelog is the only version.
- The wrapper exposes a plain object; sketch, to be settled in WP1:
  `create({ width, height, seed })` → `{ step(n), paint(material, x, y, r),
  quiet(), activeCells(), pixels, dispose() }`. `quiet()` is the §6d hook and
  is non-negotiable: the kernel tracks active chunks (dirty bits per 16×16
  region) and answers "nothing moved last step" in O(chunks). The host
  pattern is Shui Guo Tan's `wake()`/`rest()` verbatim.
- Reduced motion and power saver are the host's door to keep, as they are in
  every game: the kernel never reads settings.

**JS reference implementation is the spec.** Same posture as `arcade-rng.js`:
`tools/sim/sand-reference.mjs` is a plain typed-array implementation of the
identical rules, and `tools/sim-sand-unit.mjs` asserts that for a set of seeds
and paint scripts the WASM grid is **byte-identical** to the reference after N
steps (known-answer tests, run under `node --test`; node 24 instantiates WASM
natively so the existing `run-units.mjs` covers it). The reference is not
shipped and is not a fallback; it exists so a kernel change that alters
behaviour fails a test instead of silently forking every player's daily.

**Toolchain that fits node-only CI.** `fleet-ci.yml` installs node 24 and
nothing else, and the launcher deploy stages tracked files. Decision:

- source in **AssemblyScript** (`assemblyscript` as a devDependency; TypeScript
  syntax, no runtime needed for a typed-array kernel, `--runtime stub`,
  output in the tens of KB). Zig from npm is the alternative if AssemblyScript's
  codegen disappoints on the inner loop; Rust is the nicer language but drags
  a toolchain action into the pipeline and is not worth it for one kernel.
- the **binary is checked in** next to its source, and a unit gate
  (`tools/sim-sand-build-unit.mjs`) rebuilds it and byte-compares. A drift
  fails CI. This keeps the launcher's "tracked files are the artifact" deploy
  path untouched and makes the binary auditable — every published file is a
  written-down decision, per `inject-precache.mjs`.
- SIMD stays off in the shipped build until WP3 measures it.

## 4. Work packages

**WP0 — Measure Shui Guo Tan (½ day, shuiguo repo).** A DevTools Performance
trace of a busy board on a phone-class throttle: time in `step()` vs
`R.draw()`. Expected: painting dominates. If so, file a shuiguo issue for
sprite caching in `fruit-art.js` (offscreen canvas per fruit level, redrawn
only on theme or DPR change) and close this WP. Only if `step()` dominates
does a circle-solver kernel become a candidate, as its own plan.

**WP1 — Sand kernel v0 (2–3 days, launcher repo).** Reference implementation
plus AssemblyScript port: materials `empty / sand / water / wall`, gravity,
diagonal slide, liquid spread, alternating scan direction per row to avoid
bias, active-chunk tracking, palette framebuffer. Known-answer suite, build
gate, changelog entry, `sw.js` precache. Acceptance: a fixture page under
`tools/fixtures/` that loads the module in a sandboxed frame and asserts (a)
the grid matches the reference, (b) `quiet()` goes true after a poured pile
settles, (c) `render-smoke.mjs` sees pixels.

**WP2 — Host contract and docs (1 day).** GAME_INTEGRATION.md §5/§6d gain a
short "compiled kernels" note: kernels are loaded from the launcher origin,
never vendored; the host owns `wake()`/`rest()` and the powerSaver gate; the
worker route is blob-URL only, single file. Starter-app README links it.

**WP3 — First consumer: the sand game (separate repo, sized when designed).**
Boots the module, paints with touch, seeds from `Arcade.daily`, ships a share
code that replays the paint script. This is where the API in §3 gets its
final shape; do not gold-plate it in WP1.

**WP4 — Measure again, then decide (½ day).** With WP3 on a phone: CPU per
step at 256×384 and 512×768; time to `quiet()`; battery over a 10-minute
session against a JS-only build of the same reference. Only then: SIMD, a
worker, or a second kernel.

## 5. Sequencing

WP0 runs first and independently; it is a trace, not code. WP1 → WP2 → WP3
in order; WP4 closes the loop. Nothing here blocks or is blocked by the open
audio/sound-pack track.

## 6. Risks and the answers

- **`instantiateStreaming` MIME.** GitHub Pages serves `application/wasm`;
  `verify-origin.mjs` should assert the header on the published URL so a
  hosting change fails the deploy rather than the player. Fallback to
  `instantiate(await res.arrayBuffer())` in the wrapper regardless.
- **Memory growth invalidates views.** The wrapper owns the `pixels` view and
  re-creates it when `memory.buffer` changes identity; hosts must read
  `sim.pixels` each frame, never cache it.
- **A kernel that never goes quiet** (a leaking water source) is a battery
  bug of the first order. `activeCells()` is exposed so the host can cap
  sources and the acceptance fixture asserts settle-to-quiet.
- **Two implementations to maintain.** Deliberate: the reference is the spec
  and the test oracle; the binary is the product. A change touches both or
  the gate fails.

## 7. Out of scope

- `Arcade.fx.burst` / `Arcade.tween` (Workstream D item 5). Still the right
  answer for the fleet's decorative particles, still a **JS** lift, still a
  separate track. Do not compile it.
- A physics kernel for Shui Guo Tan. Contingent on WP0's trace.
- Shared-memory or threaded WASM. Impossible without COOP/COEP on Pages and
  not needed at these grid sizes.
- WebGL/WebGPU rendering. Canvas 2D `putImageData` of a palette framebuffer is
  enough and keeps the render-smoke gate and fleet conventions intact.
