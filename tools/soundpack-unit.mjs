/* soundpack-unit.mjs — the soundpack toolchain's contract, without a browser.
 *
 * Rendering needs headless Chromium and lives in the acceptance tier. But the
 * three things that actually break are all checkable here, in milliseconds:
 *
 *   Gate A — the pack contract: a pack file, evaluated against the shipped
 *            element library, registers itself under the well-known handle.
 *            This is what lets every tool be app-agnostic; if it regresses,
 *            every audition breaks at once.
 *   Gate B — the archetype library: builders emit the item/section shapes the
 *            renderer consumes, generated sections are derived from the pack
 *            (so a new cue cannot be silently missed), and publish() rejects a
 *            cue name that does not exist — the typo that would otherwise
 *            render as silence and read as a design problem.
 *   Gate C — no app defaults: neither entry point may fall back to a specific
 *            app when invoked bare. A default app name is how this toolchain
 *            grew a dependency on its consumers the first time.
 *
 * The fixture pack under tools/fixtures/soundpack-test/ is the subject, so this
 * passes on a bare checkout with no app repo present.
 *
 * Run: `node tools/soundpack-unit.mjs`
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'tools', 'fixtures', 'soundpack-test');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label + (detail ? ` — ${detail}` : '')); }
}
function throws(fn, match, label) {
    let msg = null;
    try { fn(); } catch (e) { msg = e.message; }
    ok(msg !== null && (!match || msg.includes(match)), label, msg === null ? 'did not throw' : msg);
}

// The element library and the archetype library are plain scripts by design —
// the renderer injects them verbatim into a page. That also makes them
// evaluable here: nothing runs at load time except the global assignment.
const evalScript = (p) => (0, eval)(readFileSync(p, 'utf8'));

console.log('Soundpack toolchain — pack contract, archetypes, no app defaults\n');

// ---- Gate A: the pack contract ----
console.log('Gate A — registerPack publishes the well-known handle');

evalScript(join(ROOT, 'arcade-audio.js'));
ok(typeof globalThis.ArcadeAudioElements === 'object', 'arcade-audio.js evaluates and exports elements');
ok(typeof globalThis.ArcadeAudioElements.registerPack === 'function', 'registerPack is exported');

evalScript(join(FIXTURE, 'pack.js'));
const P = globalThis.ArcadeSoundPack;
ok(!!P, 'the fixture pack registered itself');
ok(P && P.name === 'soundpack-test', 'the pack carries its name');
ok(P && P.ROOM && P.SENDS && P.CUES, 'the pack carries ROOM, SENDS and CUES');
ok(P && Object.keys(P.CUES).every((n) => typeof P.CUES[n] === 'function'), 'every cue is a function');
ok(P && Object.keys(P.CUES).every((n) => typeof P.SENDS[n] === 'number'),
    'every cue declares a room send');

const S = globalThis.ArcadeAudioElements;
throws(() => S.registerPack(null), 'must be an object', 'registerPack rejects a non-object');
throws(() => S.registerPack({ name: 'x' }), 'pack.ROOM', 'registerPack rejects a pack with no ROOM');
S.registerPack(P); // restore — the throwing calls above must not have clobbered it
ok(globalThis.ArcadeSoundPack === P, 'a rejected registration leaves the previous pack in place');

// ---- Gate B: the archetype library ----
console.log('\nGate B — archetypes emit renderer-shaped timelines');

evalScript(join(ROOT, 'tools', 'soundpack', 'lib', 'audition.js'));
const A = globalThis.ArcadeAudition;
ok(typeof A === 'object', 'lib/audition.js evaluates and exports archetypes');

const cueNames = Object.keys(P.CUES);

const dryWet = A.everyCueDryWet();
ok(dryWet.items.length === cueNames.length * 2,
    `everyCueDryWet covers every cue twice (${dryWet.items.length} items for ${cueNames.length} cues)`);
ok(dryWet.items.filter((i) => i.send === 0).length === cueNames.length,
    'exactly half of them are dry (send 0)');
ok(dryWet.items.every((i) => P.CUES[i.cue]), 'every generated item names a real cue');

const rep = A.repeat(cueNames[0], { n: 4, spacing: 0.5 });
ok(typeof rep.build === 'function' && rep.dur > 0, 'repeat() emits a build item with a duration');

const sc = A.scene('s', 2, [{ cue: cueNames[0], at: 0 }]);
ok(sc.label === 's' && sc.dur === 2 && typeof sc.build === 'function', 'scene() emits a build item');

const cp = A.contrastPairs('t', 'n', [[cueNames[0], cueNames[1]]]);
ok(cp.items.length === 1 && typeof cp.items[0].build === 'function', 'contrastPairs() emits one item per pair');

const single = A.play(cueNames[0], { params: { freq: 880 } });
ok(single.cue === cueNames[0] && single.params.freq === 880, 'play() carries per-play params through to the item');

// publish() validation — the reason it exists
throws(() => A.publish({ sections: [] }), 'no sections', 'publish rejects an empty timeline');
throws(() => A.publish({ sections: [{ title: 'x', items: [{ label: 'l', cue: 'nope' }] }] }),
    "no cue named 'nope'", 'publish rejects an unknown cue name');
throws(() => A.publish({ sections: [{ title: 'x', items: [{ label: 'l' }] }] }),
    'cue name or a build', 'publish rejects an item that is neither a cue nor a build');

// The fixture audition is the worked example; it must publish cleanly.
evalScript(join(FIXTURE, 'audition.js'));
const plan = globalThis.PACK;
ok(!!plan && Array.isArray(plan.SECTIONS) && plan.SECTIONS.length > 0, 'the fixture audition publishes a timeline');
ok(plan && plan.name === P.name && plan.CUES === P.CUES, 'the published plan carries the pack through');
ok(plan && typeof plan.GAP === 'number' && typeof plan.TAIL === 'number', 'the plan carries GAP and TAIL');
const allItems = plan.SECTIONS.flatMap((s) => s.items);
ok(allItems.every((i) => i.cue === undefined || P.CUES[i.cue]),
    'every item in the fixture timeline resolves to a real cue');
ok(plan.SECTIONS.every((s) => typeof s.title === 'string' && Array.isArray(s.items)),
    'every section is renderer-shaped');

// ---- Gate C: no app defaults ----
console.log('\nGate C — entry points have no app-specific fallback');

for (const tool of ['render.mjs', 'analyze.mjs']) {
    const res = spawnSync(process.execPath, [join(ROOT, 'tools', 'soundpack', tool)], { encoding: 'utf8' });
    ok(res.status === 2, `${tool} bare invocation exits 2 (usage), not a guessed render`, `exit ${res.status}`);
    ok(/usage|node tools\/soundpack/i.test((res.stderr || '') + (res.stdout || '')),
        `${tool} prints usage instead of guessing`);
}

// The fixture config is the schema's worked example — keep it honest.
const cfg = JSON.parse(readFileSync(join(FIXTURE, 'soundpack.config.json'), 'utf8'));
ok(typeof cfg.name === 'string' && cfg.name.length > 0, 'fixture config declares a name');
ok(typeof cfg.pack === 'string', 'fixture config declares a pack path');
ok(cfg.auditions && Object.keys(cfg.auditions).length > 0, 'fixture config declares at least one audition');

console.log(`\n${fail ? `✗ soundpack-unit: ${fail} check(s) FAILED.` : `✓ soundpack-unit: all ${pass} checks passed`}`);
process.exit(fail ? 1 : 0);
