/* render-smoke-acceptance.mjs — proves the render smoke check both fires and
 * doesn't.
 *
 * Named `-acceptance.mjs` so run-ci.mjs discovers it: this needs a real
 * browser, so it belongs in the acceptance tier rather than the no-browser
 * unit tier.
 *
 * The check it exercises runs against nine other repos' artifacts, in warn
 * mode to begin with. Warn mode is the risk: a check nobody has to obey is a
 * check nobody notices has stopped working, so the fixtures matter more here
 * than they would for a gate that fails builds. What is pinned:
 *
 *   · a planted blank app FAILS — the assertion actually detects nothing-drawn
 *   · the same app under --warn exits 0 — warn mode is warn, not off
 *   · the starter-app fixture PASSES — no false positive on a real app
 *   · a gated app FAILS by default and PASSES with its declaration — the
 *     per-app hint mechanism works before any app in the fleet needs it
 *
 * That last pair is the one worth having. No fleet app needs a declaration
 * today, so without a fixture the whole opt-in path would ship untested and
 * rot until the first app that needed it found out the hard way.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOLS, '..');
const SMOKE = path.join(TOOLS, 'render-smoke.mjs');
const FIXTURES = path.join(TOOLS, 'fixtures');

let failures = 0;
const ok = (cond, label, detail = '') => {
    console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
    if (!cond) failures++;
};

// Ports clear of the other suites, which sit in the 47xx range.
let port = 4861;
function run(fixture, extra = []) {
    const res = spawnSync(process.execPath,
        [SMOKE, path.join(FIXTURES, fixture), '--label', fixture,
            '--port', String(port++), '--sdk', ROOT, ...extra],
        { cwd: ROOT, encoding: 'utf8' });
    return { status: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

console.log('\nrender smoke — the checker itself\n');

// A planted blank: every other gate in the fleet is green on this file.
const blank = run('blank-app');
ok(blank.status === 1, 'a blank app fails', `exit ${blank.status}`);
ok(/distinct colours/.test(blank.out) && /1 distinct colours/.test(blank.out),
    'and it says what it measured, so a threshold can be argued with');

// Warn mode must still SAY it, or it is just off.
const blankWarn = run('blank-app', ['--warn']);
ok(blankWarn.status === 0, 'warn mode does not fail the run', `exit ${blankWarn.status}`);
ok(/::warning title=render smoke::/.test(blankWarn.out),
    'warn mode emits a workflow annotation rather than passing silently');

// A real app must not trip it. This one loads the version-pinned SDK path,
// which is the reason the overlay covers sdk/ and not just the repo root.
const starter = run('starter-app');
ok(starter.status === 0, 'the starter-app fixture passes', `exit ${starter.status}`);
ok(!/ReferenceError: Arcade is not defined/.test(starter.out),
    'and it reaches a real SDK, not a 404 — the app boots the path a player takes');

// The per-app declaration mechanism, both ways round.
const gatedDefault = run('gated-app');
ok(gatedDefault.status === 1, 'an app behind a gate fails the default run',
    `exit ${gatedDefault.status}`);
const gatedHinted = run('gated-app', ['--hints', path.join(FIXTURES, 'gated-app', 'smoke.mjs')]);
ok(gatedHinted.status === 0, 'and passes once its tools/smoke.mjs dismisses the gate',
    `exit ${gatedHinted.status}`);

// A missing artifact is an error, not a blank app — the two want different
// fixes, and conflating them sends someone hunting a rendering bug that is
// really a staging bug.
const missing = spawnSync(process.execPath,
    [SMOKE, path.join(FIXTURES, 'no-such-app'), '--port', String(port++)],
    { cwd: ROOT, encoding: 'utf8' });
ok(missing.status === 2, 'a missing artifact exits 2, distinct from a blank one',
    `exit ${missing.status}`);

console.log(failures
    ? `\n✗ ${failures} render-smoke check(s) failed`
    : '\n✓ render smoke: detects a blank, warns without failing, passes real apps, honours declarations');
process.exit(failures ? 1 : 0);
