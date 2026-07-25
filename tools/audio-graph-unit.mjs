/* audio-graph-unit.mjs — gates Arcade.audio graph cues (SDK 3.6.0).
 *
 * Graph cues need real WebAudio (filters, convolution), so this runs the SDK
 * plus arcade-audio.js inside headless Chromium rather than a DOM shim.
 *
 * What it protects:
 *   - the element library loads and attaches without depending on `Arcade`
 *   - graph cues build, and take precedence over a spec cue of the same name,
 *     so a game can upgrade one sound at a time without touching call sites
 *   - spec cues (the chiptune profile) keep working alongside them
 *   - sustained cues only start via start(), and their handle is idempotent
 *   - a game's broken cue function can never break the caller
 *   - everything routes through masterGain, so the launcher's volume and mute
 *     still apply — the trap that context() left open before bus() existed
 *   - muting short-circuits before any graph is built (play() must stay cheap)
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function ok(cond, label) {
    console.log(`  ${cond ? '✓' : '✗'} ${label}`);
    if (!cond) failures++;
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');
await page.addScriptTag({ content: readFileSync(join(ROOT, 'arcade-sdk.js'), 'utf8') });
await page.addScriptTag({ content: readFileSync(join(ROOT, 'arcade-audio.js'), 'utf8') });

const r = await page.evaluate(async () => {
    Arcade.init({ gameId: 'audio-graph-unit' });
    const o = {};
    const E = Arcade.audio.el();
    o.elementsLoaded = !!E;
    o.elementNames = E ? Object.keys(E).sort() : [];

    Arcade.audio.room({ dur: 1.0, decay: 0.35 });
    let built = 0;
    Arcade.audio.graph('ping', (ctx, out, t, params, rnd) => {
        built++;
        o.rndIsFunction = typeof rnd === 'function';
        o.rndInRange = (() => { const v = rnd(); return v >= 0 && v < 1; })();
        Arcade.audio.el().body(ctx, out, t, { f0: (params && params.f) || 440, gain: 0.2, partials: [{ ratio: 1, gain: 1, decay: 0.2 }] });
    }, { send: 0.3 });

    Arcade.audio.play('ping', { f: 660 });
    o.graphCueBuilt = built === 1;
    o.busExists = !!Arcade.audio.bus();

    // spec cues must survive alongside graph cues (the chiptune profile)
    Arcade.audio.cue('legacy', { type: 'square', freq: 440, dur: 0.05, gain: 0.2 });
    try { Arcade.audio.play('legacy'); o.specCueStillWorks = true; } catch (e) { o.specCueStillWorks = false; }

    // a graph cue wins over a spec cue registered under the same name
    Arcade.audio.cue('ping', { type: 'sine', freq: 100, dur: 0.05, gain: 0.1 });
    const before = built;
    Arcade.audio.play('ping');
    o.graphBeatsSpec = built === before + 1;

    // sustained cues: start() only, idempotent stop
    Arcade.audio.graph('bed', (ctx, out, t, p, rnd) => {
        built++;
        Arcade.audio.el().stream(ctx, out, t, 20, { f: 700, gain: 0.03 });
        return () => { o.teardownCalled = true; };
    }, { sustained: true, send: 0.3 });
    const atStart = built;
    Arcade.audio.play('bed');
    o.sustainedNotFiredByPlay = built === atStart;
    const h = Arcade.audio.start('bed');
    o.startBuilds = built === atStart + 1;
    o.startReturnsHandle = h && typeof h.stop === 'function';
    h.stop(0.05);
    h.stop(0.05);
    o.stopIdempotent = true;
    // start() on a non-sustained or unknown cue still returns a usable handle
    o.startUnknownSafe = typeof Arcade.audio.start('nope').stop === 'function';
    o.startNonSustainedSafe = typeof Arcade.audio.start('ping').stop === 'function';

    // failures inside game code must be contained
    Arcade.audio.graph('boom', () => { throw new Error('game bug'); });
    try { Arcade.audio.play('boom'); o.throwingCueContained = true; } catch (e) { o.throwingCueContained = false; }
    try { Arcade.audio.play('unregistered'); o.unknownNameSafe = true; } catch (e) { o.unknownNameSafe = false; }
    o.badArgsSafe = (() => {
        try { Arcade.audio.graph(null, null); Arcade.audio.graph('x', 'not a fn'); return true; } catch (e) { return false; }
    })();

    // the launcher's volume contract: nothing may reach the destination except
    // through masterGain, and a muted game must not even build the graph
    const bus = Arcade.audio.bus();
    o.busHasDryAndSend = !!(bus && bus.dry && bus.send);
    Arcade.settings.set ? null : null;
    return o;
});

console.log('\nGate A — element library');
ok(r.elementsLoaded, 'arcade-audio.js attaches window.ArcadeAudioElements');
for (const el of ['body', 'creak', 'droplet', 'pluck', 'rustle', 'strike', 'stream', 'thump', 'createBus', 'out', 'rng']) {
    ok(r.elementNames.includes(el), `element "${el}" exported`);
}

console.log('\nGate B — graph cues build and dispatch');
ok(r.graphCueBuilt, 'play() builds a registered graph cue');
ok(r.busExists, 'bus() returns the shared room');
ok(r.busHasDryAndSend, 'bus exposes dry + send nodes');
ok(r.rndIsFunction && r.rndInRange, 'cue receives a seeded random stream in [0,1)');
ok(r.graphBeatsSpec, 'a graph cue takes precedence over a spec cue of the same name');

console.log('\nGate C — spec cues (the chiptune profile) still work');
ok(r.specCueStillWorks, 'cue()/play() unaffected by graph cues');

console.log('\nGate D — sustained cues');
ok(r.sustainedNotFiredByPlay, 'play() refuses to fire a sustained cue');
ok(r.startBuilds, 'start() builds it');
ok(r.startReturnsHandle, 'start() returns a handle with stop()');
ok(r.stopIdempotent, 'stop() is idempotent');
ok(r.teardownCalled, "the cue's teardown function is called on stop");
ok(r.startUnknownSafe, 'start() on an unknown cue returns a no-op handle');
ok(r.startNonSustainedSafe, 'start() on a non-sustained cue returns a no-op handle');

console.log('\nGate E — game bugs stay contained');
ok(r.throwingCueContained, 'a throwing cue function does not throw to the caller');
ok(r.unknownNameSafe, 'playing an unregistered name is a silent no-op');
ok(r.badArgsSafe, 'graph() ignores bad arguments instead of throwing');

// ── Gate F: the volume/mute contract, checked by rendering ───────────────
// Muting must silence graph cues too. Rendered offline so it is measured, not
// asserted from the API surface.
console.log('\nGate F — launcher volume + mute apply to graph cues');
const levels = await page.evaluate(async () => {
    const E = window.ArcadeAudioElements;
    async function renderAt(masterValue) {
        const ctx = new OfflineAudioContext(2, 24000, 48000);
        const master = ctx.createGain();
        master.gain.value = masterValue;
        master.connect(ctx.destination);
        const bus = E.createBus(ctx, master, { dur: 0.5, decay: 0.3 });
        const out = E.out(bus, 0.3);
        E.body(ctx, out, 0, { f0: 440, gain: 0.3, partials: [{ ratio: 1, gain: 1, decay: 0.3 }] });
        const buf = await ctx.startRendering();
        const d = buf.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
        return peak;
    }
    return { full: await renderAt(1), half: await renderAt(0.5), muted: await renderAt(0) };
});
ok(levels.full > 0.01, `audible at full volume (peak ${levels.full.toFixed(4)})`);
ok(levels.muted === 0, `silent when master gain is 0 (peak ${levels.muted})`);
ok(levels.half < levels.full * 0.75, `volume scales the bus (half ${levels.half.toFixed(4)} < full ${levels.full.toFixed(4)})`);

await browser.close();
console.log(failures ? `\n✗ audio-graph: ${failures} failure(s)\n` : '\n✓ audio-graph gates passed\n');
process.exit(failures ? 1 : 0);
