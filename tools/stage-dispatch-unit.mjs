/* stage-dispatch-unit.mjs — the artifact dispatcher picks the right route and
 * fails loudly on the ways a staging step can be green but wrong.
 *
 * This logic used to be two mirrored shell blocks in fleet-ci.yml, which meant
 * it could not be tested at all and could only be checked by reading both and
 * comparing. It runs against every repo in the fleet, so the cases below are
 * the ones where a wrong answer is someone else's broken deploy: an empty
 * artifact published as if it were a site, and a repo with no staging route
 * treated as success.
 *
 * Named `-unit.mjs` so run-units.mjs discovers it; no browser, no network.
 */
import { dispatch, stagingRoute } from './stage-dispatch.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (cond, label) => {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
};

const scratches = [];
/** A throwaway repo root. `files` maps relative path -> contents. */
function scratch(files) {
    const dir = mkdtempSync(join(tmpdir(), 'stage-dispatch-'));
    scratches.push(dir);
    for (const [name, body] of Object.entries(files)) {
        const full = join(dir, name);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, body);
    }
    return dir;
}

/** A stand-in for an app's tools/stage.mjs. Real staging is verify-artifact's
 *  subject; what is under test here is only which route gets taken. */
const fakeStage = (body) => `import fs from 'node:fs';\nimport path from 'node:path';\n`
    + `const out = path.resolve(process.argv[2]);\n${body}\n`;
const STAGE_OK = fakeStage(
    `fs.mkdirSync(out, { recursive: true });\n`
    + `fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html>');`);
const STAGE_EMPTY = fakeStage(`fs.mkdirSync(out, { recursive: true });`);
const STAGE_NOTHING = fakeStage(`// exits 0 having produced nothing at all`);
const STAGE_FAILS = fakeStage(`process.exit(1);`);

try {
    console.log('\n── route detection ' + '─'.repeat(40));

    ok(stagingRoute(scratch({
        'package.json': '{"scripts":{"build":"true"}}',
        'tools/stage.mjs': STAGE_OK,
    })) === 'build', 'a declared build script wins over tools/stage.mjs');

    ok(stagingRoute(scratch({ 'tools/stage.mjs': STAGE_OK })) === 'stage',
        'tools/stage.mjs alone is the stage route');

    ok(stagingRoute(scratch({ 'package.json': '{"name":"x"}' })) === 'none',
        'a package.json with no build script does not take the build route');

    ok(stagingRoute(scratch({ 'README.md': '# nothing' })) === 'none',
        'neither one is no route at all');

    ok(stagingRoute(scratch({
        'package.json': '{ not json',
        'tools/stage.mjs': STAGE_OK,
    })) === 'stage', 'an unparseable package.json falls through, it does not throw');

    // The launcher is a fleet caller like any other and must keep meeting the
    // §13a default. If this repo ever grows a build script, that is a decision
    // to make deliberately — not to discover from a deploy.
    ok(stagingRoute(ROOT) === 'stage', 'this repo stages via tools/stage.mjs');

    console.log('\n── the deploy contract ' + '─'.repeat(36));

    let r = dispatch('dist', { root: scratch({ 'tools/stage.mjs': STAGE_OK }) });
    ok(r.ok && r.route === 'stage', 'a working stage.mjs produces the artifact');

    const emptyRoot = scratch({ 'tools/stage.mjs': STAGE_EMPTY });
    r = dispatch('dist', { root: emptyRoot });
    ok(!r.ok, 'an EMPTY dist/ is a failure, not a deploy of an empty site');
    ok(existsSync(join(emptyRoot, 'dist')), '  (and the empty dir really was created)');

    r = dispatch('dist', { root: scratch({ 'tools/stage.mjs': STAGE_NOTHING }) });
    ok(!r.ok, 'a stage that exits 0 without producing dist/ is a failure');

    r = dispatch('dist', { root: scratch({ 'tools/stage.mjs': STAGE_FAILS }) });
    ok(!r.ok, 'a stage that exits non-zero is a failure');

    console.log('\n── optional mode (smoke) ' + '─'.repeat(34));

    r = dispatch('dist', { root: scratch({ 'README.md': '# no staging here' }) });
    ok(!r.ok && r.route === 'none',
        'no staging route fails the DEPLOY — §13a is not optional there');

    r = dispatch('dist', { root: scratch({ 'README.md': '# x' }), optional: true });
    ok(r.ok && r.route === 'none',
        'no staging route SKIPS the smoke — an advisory check does not fail a repo');

    // --optional forgives "you have nothing to stage". It must not forgive
    // "your staging is broken", or the advisory job silently stops covering
    // the apps whose artifacts are worst.
    r = dispatch('dist', { root: scratch({ 'tools/stage.mjs': STAGE_FAILS }), optional: true });
    ok(!r.ok, 'optional mode still reports a stage that FAILED');
} finally {
    for (const d of scratches) rmSync(d, { recursive: true, force: true });
}

console.log(`\n${fail ? '✗' : '✓'} stage-dispatch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
