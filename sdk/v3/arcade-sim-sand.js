/* Paul's Arcade — sand simulation kernel (companion to arcade-sdk.js)
 *
 * A falling-sand cellular automaton compiled to WebAssembly: hundreds of
 * thousands of cells, each an integer material, stepped every frame with
 * neighbour reads and swaps. The grid and a palette-mapped RGBA framebuffer
 * both live in the module's linear memory, so a host's whole render is one
 * `putImageData` of a view over that memory — nothing is ever copied out.
 * Integer-only stepping with a seeded xorshift inside the kernel makes the
 * sim bit-identical across devices: the same seed and paint script give the
 * same grid everywhere, which is what share codes, daily challenges and,
 * later, lockstep multiplayer need (plans/compiled-kernels-2026-09.md).
 *
 * Load AFTER arcade-sdk.js, from the same path the SDK came from:
 *
 *   <script src="/arcade-sdk.js"></script>
 *   <script src="/arcade-sim-sand.js"></script>
 *
 * The binary (arcade-sim-sand.wasm) is fetched from beside THIS script, so
 * `/sdk/v3/` and the root alias both work and a game never vendors it.
 *
 *   const sand = Arcade.sim.sand;
 *   const sim = await sand.create({ width: 256, height: 384, seed });
 *   sim.paint(sand.tint(5), x, y, 3);   // coloured sand; sand.materials.WATER, .WALL, .EMPTY
 *   sim.nudge(x, y, 6, 0, -4);          // the stick: shove what is under it
 *   sim.tilt(1, 1);                     // tilt the jar: gravity down-right; (0, 1) is upright
 *   sim.lean(12.5);                     // …or lean it by any angle (degrees from upright, + to the right)
 *   saved = sim.grid.slice();           // … later: sim.load(saved) — share codes, replays
 *   sim.step();                         // inside your Arcade.loop tick
 *   ctx.putImageData(new ImageData(sim.pixels, sim.width, sim.height), 0, 0);
 *   if (sim.quiet()) rest();            // GAME_INTEGRATION §6d — let the screen rest
 *
 * What this file deliberately does NOT do: read `Arcade.settings`. Power saver
 * and reduced motion are the host's door to keep, as they are in every game;
 * the kernel reports quietness and the host decides whether to run a frame.
 * It also never caches the `pixels` view for you: WebAssembly memory can be
 * re-allocated when it grows, which detaches every view over the old buffer,
 * so `sim.pixels` is a getter that re-creates the view when the buffer
 * identity changes. Read it each frame; do not hold it.
 *
 * The rules are specified by tools/sim/sand-reference.mjs and pinned by
 * tools/sim-sand-unit.mjs; this wrapper adds nothing to them.
 */
(function (global) {
    'use strict';

    // R1 of the reference — the material ids paint() takes and get() returns.
    // Sand is a RANGE: SAND_BASE + t for tint t in [0, SAND_COUNT), every tint
    // with identical physics; SAND (1) is kept as a plain-sand id that shares
    // tint 0's default colour. tint(t) below spells the arithmetic out.
    var materials = Object.freeze({ EMPTY: 0, SAND: 1, WATER: 2, WALL: 3, SAND_BASE: 16, SAND_COUNT: 32 });
    var PALETTE_SIZE = 48;
    function isMaterial(m) {
        return (m >= 0 && m <= materials.WALL) || (m >= materials.SAND_BASE && m < materials.SAND_BASE + materials.SAND_COUNT);
    }
    // R18 — degrees of lean → an axis gravity and the kernel's integers.
    // REPOSE[n] is the slope (degrees) a pile's downhill face rests at when
    // every cell allows a tread of n: atan(1/n), which is also what the
    // reference kernel measures (tools/sim-sand-unit.mjs Gate I re-measures
    // it, so a rule change that moves the curve is loud). Between two treads
    // the share p of cells allowing the longer one interpolates. Plain
    // arithmetic only — no Math.tan / Math.atan — so two engines agree on
    // the integers.
    var REPOSE = [0, 45, 26.565, 18.435, 14.036, 11.310, 9.462, 8.130, 7.125, 6.340, 5.711,
        5.194, 4.764, 4.399, 4.086, 3.814, 3.576, 3.366];
    var MID = { 1: [45, 40, 33.82, 30.18, 26.565], 2: [26.565, 23.06, 21.97, 19.65, 18.435], 3: [18.435, 16.9, 16.26, 14.84, 14.036] };
    function leanPlan(degrees) {
        degrees = Number(degrees);
        if (!isFinite(degrees)) throw new RangeError('lean: degrees must be a finite number');
        degrees = ((degrees + 180) % 360 + 360) % 360 - 180;          // −180 ≤ d < 180
        var phi = 90 - degrees;                                        // gravity as atan2(y, x), y down
        var k = Math.round(phi / 90);                                  // the nearest AXIS gravity
        var tau = phi - k * 90;                                        // −45 … 45, + is towards the next ring direction
        k = ((k % 4) + 4) % 4;
        var g = [[1, 0], [0, 1], [-1, 0], [0, -1]][k];
        var off = Math.abs(tau);
        var plan = { degrees: degrees, gx: g[0], gy: g[1], side: 0, reach: 1, p: 0, drift: 0 };
        if (off < 0.5) return plan;                                    // on the axis: R17 alone
        var want = 45 - off, n = 16, share = 256;
        for (var r = 1; r <= 16; r++) {
            if (want > REPOSE[r + 1]) {
                n = r;
                // Within a tread the slope is not quite linear in the share;
                // MID holds the measured quarter points for the first three
                // treads (where a degree is visible), linear beyond.
                var m = MID[r] || [REPOSE[r], 0, 0, 0, REPOSE[r + 1]];
                if (!MID[r]) { for (var t = 1; t < 4; t++) m[t] = REPOSE[r] + (REPOSE[r + 1] - REPOSE[r]) * t / 4; }
                for (var i = 1; i < 5; i++) {
                    if (want >= m[i] || i === 4) {
                        share = Math.round(((i - 1) + (m[i - 1] - want) / (m[i - 1] - m[i])) * 64);
                        break;
                    }
                }
                break;
            }
        }
        var x = off * 0.017453292519943295, x2 = x * x;                // tan(off), by its series: off ≤ 45°
        var tan = x * (1 + x2 * (1 / 3 + x2 * (2 / 15 + x2 * (17 / 315 + x2 * 62 / 2835))));
        plan.side = tau > 0 ? 1 : -1;
        plan.reach = n;
        plan.p = Math.max(0, Math.min(256, share));
        plan.drift = Math.max(0, Math.min(256, Math.round(tan * 256)));
        return plan;
    }

    function tint(t) {
        t |= 0;
        if (t < 0 || t >= materials.SAND_COUNT) throw new RangeError('tint: ' + t + ' is not in [0, ' + materials.SAND_COUNT + ')');
        return materials.SAND_BASE + t;
    }

    // Resolve the binary beside this script, whichever path it was served
    // from. document.currentScript is null when a script is injected after
    // load or evaluated in a worker; falling back to the page URL keeps the
    // root alias working in those cases (the binary is a root file too).
    var here = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src)
        || (typeof location !== 'undefined' ? location.href : '');
    var binaryUrl = new URL('arcade-sim-sand.wasm', here).href;

    // FNV-1a, the same derivation Arcade.rng.hash uses, so a string seed here
    // and a string seed there mean the same number.
    function hashU32(str) {
        var h = 2166136261 >>> 0;
        for (var i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
        return h >>> 0;
    }
    function coerceSeed(seed) {
        if (typeof seed === 'number' && isFinite(seed)) return seed >>> 0;
        if (seed == null) return 1;
        return hashU32(String(seed));
    }

    // One compile per page, however many sims are created; each create()
    // instantiates its own instance and therefore its own memory.
    var modulePromise = null;
    function loadModule() {
        if (modulePromise) return modulePromise;
        modulePromise = (async function () {
            var res = await fetch(binaryUrl);
            if (!res.ok) throw new Error('arcade-sim-sand: ' + res.status + ' fetching ' + binaryUrl);
            // Streaming compilation needs the server to say application/wasm.
            // GitHub Pages does; a mis-typed dev server falls through to the
            // bytes path, which works everywhere (plan §6). The body is cloned
            // because a failed streaming attempt has consumed it.
            if (typeof WebAssembly.instantiateStreaming === 'function') {
                try {
                    var streamed = await WebAssembly.instantiateStreaming(res.clone());
                    return streamed.module;
                } catch (e) { /* fall through to bytes */ }
            }
            var bytes = await res.arrayBuffer();
            return (await WebAssembly.instantiate(bytes)).module;
        })();
        modulePromise.catch(function () { modulePromise = null; }); // let a retry refetch
        return modulePromise;
    }

    function wrap(instance, width, height) {
        var ex = instance.exports;
        var memory = ex.memory;
        var n = width * height;
        var gridView = null, pixelView = null;
        var live = true;
        var leanDegrees = 0;
        function alive() {
            if (!live) throw new Error('arcade-sim-sand: sim was disposed');
        }
        var sim = {
            width: width,
            height: height,
            step: function (count) {
                alive();
                count = count === undefined ? 1 : count | 0;
                if (count > 0) ex.step(count);
            },
            paint: function (material, x, y, r) {
                alive();
                material |= 0;
                if (!isMaterial(material)) throw new RangeError('paint: unknown material ' + material);
                ex.paint(material, x | 0, y | 0, r | 0);
            },
            // The stick (reference R12): shove every movable cell within r
            // of (x, y) by (dx, dy) where the destination is empty.
            nudge: function (x, y, r, dx, dy) { alive(); ex.nudge(x | 0, y | 0, r | 0, dx | 0, dy | 0); },
            // Seeded shuffle within a disc (R13) — advances the rng stream.
            stir: function (x, y, r) { alive(); ex.stir(x | 0, y | 0, r | 0); },
            // A new picture on the same rng stream (R14); reseed() restarts it.
            clear: function () { alive(); ex.clear(); },
            reseed: function (seed) { alive(); ex.reseed(coerceSeed(seed)); },
            // Replace palette entries and repaint the whole framebuffer ONCE
            // (R11) — O(cells); a theme change, not a per-frame call. Either
            // (index, r, g, b, a=255) or ([[index, r, g, b, a], ...]).
            setPalette: function (index, r, g, b, a) {
                alive();
                var entries = Array.isArray(index) ? index : [[index, r, g, b, a]];
                for (var k = 0; k < entries.length; k++) {
                    var e = entries[k];
                    var i = e[0] | 0;
                    if (i < 0 || i >= PALETTE_SIZE) throw new RangeError('setPalette: index ' + i + ' is not in [0, ' + PALETTE_SIZE + ')');
                    ex.setPaletteEntry(i, e[1] | 0, e[2] | 0, e[3] | 0, e[4] === undefined ? 255 : e[4] | 0);
                }
                ex.repaint();
            },
            // Replace the whole grid (R15): save/restore, share codes, replays.
            // Validated in full before a byte of module memory is written.
            load: function (bytes) {
                alive();
                if (!(bytes instanceof Uint8Array) || bytes.length !== n) {
                    throw new RangeError('load: expected a Uint8Array of ' + n + ' bytes');
                }
                for (var k = 0; k < n; k++) {
                    if (!isMaterial(bytes[k])) throw new RangeError('load: invalid material ' + bytes[k] + ' at index ' + k);
                }
                sim.grid.set(bytes);
                ex.commitLoad();
            },
            // Stencil (R16): every `from` cell in the disc becomes `to`.
            replace: function (from, to, x, y, r) {
                alive();
                from |= 0; to |= 0;
                if (!isMaterial(from) || !isMaterial(to)) throw new RangeError('replace: unknown material ' + (isMaterial(from) ? to : from));
                ex.replace(from, to, x | 0, y | 0, r | 0);
            },
            // Tilt the jar (R17): gravity becomes (gx, gy), each -1, 0 or 1
            // and not both 0 — the eight directions of the ring, (0, 1)
            // being upright. A change wakes every chunk so the picture
            // re-settles; the same gravity again is a no-op. init() starts
            // upright; clear() and load() leave it, so a host that saves a
            // tilted jar saves the tilt beside the grid.
            tilt: function (gx, gy) {
                alive();
                gx |= 0; gy |= 0;
                if (gx < -1 || gx > 1 || gy < -1 || gy > 1 || (gx === 0 && gy === 0)) {
                    throw new RangeError('tilt: gravity must be one of the eight ring directions, got ' + gx + ',' + gy);
                }
                ex.tilt(gx, gy);
            },
            gravity: function () { alive(); return [ex.gravityX(), ex.gravityY()]; },
            // Lean the jar (R18): gravity at ANY angle, not only the ring's
            // eight. `degrees` is how far gravity swings from straight down,
            // positive towards +x (the jar's right): 0 upright, 90 is
            // tilt(1, 0), ±180 upside down. The downhill face of a pile
            // comes to rest at 45° less the lean, and what is poured falls at
            // the lean — so ten degrees of tilt is ten degrees of slope,
            // where tilt() alone gives nothing until 45 and then everything.
            // It sets tilt() for you (the nearest AXIS direction; the lean
            // does the rest, up to 45° either side) and the kernel's integer
            // lean — leanPlan() is the whole mapping. A change wakes every
            // chunk; the same angle again is a no-op, so calling it per
            // sample from a sensor is free while the hand is still. WATER
            // still lies across the axis gravity. Feature-detect with
            // `typeof sim.lean === 'function'` (SDK 3.18.0+).
            lean: function (degrees) {
                alive();
                var plan = leanPlan(degrees);
                ex.tilt(plan.gx, plan.gy);
                ex.lean(plan.side, plan.reach, plan.p, plan.drift);
                leanDegrees = plan.degrees;
            },
            // The integer form (R18), for a host that must be bit-identical
            // across devices and would rather send four integers than trust
            // two engines to round one float alike.
            leanRaw: function (side, reach, p, drift) {
                alive();
                var int = function (v, lo, hi) { return v === (v | 0) && v >= lo && v <= hi; };
                if (!int(side, -1, 1) || !int(reach, 1, 16) || !int(p, 0, 256) || !int(drift, 0, 256)) {
                    throw new RangeError('leanRaw: side -1..1, reach 1..16, p and drift 0..256');
                }
                ex.lean(side, reach, p, drift);
            },
            // The angle last given to lean() (0 after create(); tilt() and
            // leanRaw() do not move it), and the kernel's four integers.
            leaning: function () { alive(); return leanDegrees; },
            leaningRaw: function () { alive(); return [ex.leanSideOf(), ex.leanReachOf(), ex.leanPOf(), ex.leanDriftOf()]; },
            get: function (x, y) { alive(); return ex.get(x | 0, y | 0); },
            quiet: function () { alive(); return ex.quiet() !== 0; },
            activeCells: function () { alive(); return ex.activeCells(); },
            dispose: function () {
                // Nothing to free in a stub-runtime module — the instance and
                // its memory are collected once no view references them —
                // but dropping the views here is what makes a stale `pixels`
                // held by the host fail loudly instead of drawing a frozen
                // frame forever.
                live = false;
                gridView = pixelView = null;
                ex = null;
            },
        };
        // Views over module memory. WebAssembly memory grows by replacing
        // its ArrayBuffer, and every view over the old buffer becomes a
        // zero-length husk; the kernel only grows in init(), but the wrapper
        // does not rely on that.
        Object.defineProperty(sim, 'pixels', {
            enumerable: true,
            get: function () {
                alive();
                if (!pixelView || pixelView.buffer !== memory.buffer) {
                    pixelView = new Uint8ClampedArray(memory.buffer, ex.pixelsPtr(), n * 4);
                }
                return pixelView;
            },
        });
        // Read-only by contract: writing here bypasses the framebuffer, the
        // moved flags and the chunk tracking. Use paint().
        Object.defineProperty(sim, 'grid', {
            enumerable: true,
            get: function () {
                alive();
                if (!gridView || gridView.buffer !== memory.buffer) {
                    gridView = new Uint8Array(memory.buffer, ex.gridPtr(), n);
                }
                return gridView;
            },
        });
        return sim;
    }

    // create({ width, height, seed }) → Promise<sim>
    //   width, height  positive integers (cells)
    //   seed           number (used as u32) or string (FNV-1a hashed);
    //                  omitted → 1. The same seed + paint script reproduces
    //                  the same grid on every device.
    function create(opts) {
        opts = opts || {};
        var width = opts.width | 0, height = opts.height | 0;
        if (!(width > 0 && height > 0)) {
            return Promise.reject(new RangeError('arcade-sim-sand: width and height must be positive integers'));
        }
        var seed = coerceSeed(opts.seed);
        return loadModule().then(function (module) {
            return WebAssembly.instantiate(module);
        }).then(function (instance) {
            if (!instance.exports.init(width, height, seed)) {
                throw new RangeError('arcade-sim-sand: grid ' + width + '×' + height + ' could not be allocated');
            }
            return wrap(instance, width, height);
        });
    }

    var api = {
        create: create,
        // Warm the binary during a menu so the first create() is instant.
        preload: function () { return loadModule().then(function () { }); },
        materials: materials,
        tint: tint,
        leanPlan: leanPlan,   // R18: degrees → { degrees, gx, gy, side, reach, p, drift }, pure
        binaryUrl: binaryUrl,
    };

    global.ArcadeSimSand = api;
    // Attach to the SDK namespace when the SDK is present; the standalone
    // global above is the whole API otherwise (tooling, tests, a page that
    // loads this before the SDK).
    if (global.Arcade && typeof global.Arcade === 'object') {
        var sim = global.Arcade.sim;
        if (!sim || typeof sim !== 'object') {
            sim = {};
            try { global.Arcade.sim = sim; } catch (e) { /* frozen SDK object: ArcadeSimSand still works */ }
        }
        sim.sand = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
