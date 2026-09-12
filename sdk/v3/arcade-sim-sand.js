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
            // Replace one palette entry and repaint the whole framebuffer
            // (R11) — O(cells); a theme change, not a per-frame call.
            setPalette: function (index, r, g, b, a) {
                alive();
                index |= 0;
                if (index < 0 || index >= PALETTE_SIZE) throw new RangeError('setPalette: index ' + index + ' is not in [0, ' + PALETTE_SIZE + ')');
                ex.setPalette(index, r | 0, g | 0, b | 0, a === undefined ? 255 : a | 0);
            },
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
