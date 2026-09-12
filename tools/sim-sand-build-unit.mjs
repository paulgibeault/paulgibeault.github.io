/* sim-sand-build-unit.mjs — the checked-in kernel binary is what its source
 * builds to, and the root aliases are the pinned files.
 *
 * The launcher deploy stages tracked files verbatim, so the .wasm is checked
 * in rather than built in CI (plans/compiled-kernels-2026-09.md §3). That
 * makes every published byte auditable — and makes "edited assembly/sand.ts,
 * forgot to rebuild" a drift that nothing else would catch: sim-sand-unit
 * would still pass, because it tests the STALE binary against the reference.
 * So this gate rebuilds with exactly the command `npm run build:sim-sand`
 * uses (imported from the build script, not retyped) and byte-compares.
 *
 *   Gate A — a fresh build of assembly/sand.ts == sdk/v3/arcade-sim-sand.wasm
 *   Gate B — /arcade-sim-sand.wasm (root alias) == sdk/v3 copy
 *   Gate C — /arcade-sim-sand.js (root alias) == sdk/v3/arcade-sim-sand.js
 *
 * Gates B and C need no compiler and always run. Gate A is skipped — exit 0,
 * said out loud — only when assemblyscript is not installed (a checkout with
 * no `npm ci`); `npm ci` in CI always installs it, so CI never skips.
 *
 * Run: `node tools/sim-sand-build-unit.mjs`
 */
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, ASC, ASC_ARGS, PINNED, ROOT_ALIAS, ROOT } from './sim/build-sand.mjs';

let pass = 0, fail = 0;
function ok(cond, label, detail) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label + (detail ? `\n      ${detail}` : '')); }
}

console.log('\nGate A — fresh build of assembly/sand.ts matches the checked-in binary');
if (!existsSync(ASC)) {
    console.log('  – SKIPPED: assemblyscript is not installed (node_modules/assemblyscript missing).');
    console.log('    Run `npm ci` to enable this gate; CI always has it.');
} else {
    const dir = mkdtempSync(join(tmpdir(), 'sim-sand-build-'));
    try {
        const out = join(dir, 'sand.wasm');
        let err = null;
        try { build(out); } catch (e) { err = e.message; }
        ok(!err, 'asc compiles assembly/sand.ts', err);
        if (!err) {
            const fresh = readFileSync(out), pinned = readFileSync(PINNED);
            ok(fresh.equals(pinned),
                `fresh build (${fresh.length} bytes) is byte-identical to sdk/v3/arcade-sim-sand.wasm (${pinned.length} bytes)`,
                'fix: npm run build:sim-sand   (and commit both .wasm files)');
            ok(fresh.length < 16 * 1024, `binary is small (${fresh.length} bytes < 16 KB)`);
        }
        ok(ASC_ARGS(out).includes('--runtime') && ASC_ARGS(out)[ASC_ARGS(out).indexOf('--runtime') + 1] === 'stub',
            'build uses --runtime stub');
        ok(!ASC_ARGS(out).some((a) => /simd/.test(a)), 'build does not enable SIMD (plan WP4 decides that)');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

console.log('\nGate B — root .wasm alias mirrors the pinned binary');
ok(existsSync(ROOT_ALIAS), 'arcade-sim-sand.wasm exists at the repo root');
ok(existsSync(PINNED), 'sdk/v3/arcade-sim-sand.wasm exists');
if (existsSync(ROOT_ALIAS) && existsSync(PINNED)) {
    ok(readFileSync(ROOT_ALIAS).equals(readFileSync(PINNED)), 'arcade-sim-sand.wasm == sdk/v3/arcade-sim-sand.wasm',
        'fix: cp sdk/v3/arcade-sim-sand.wasm arcade-sim-sand.wasm');
}

console.log('\nGate C — root .js alias mirrors the pinned wrapper');
const rootJs = join(ROOT, 'arcade-sim-sand.js'), pinnedJs = join(ROOT, 'sdk', 'v3', 'arcade-sim-sand.js');
ok(existsSync(rootJs), 'arcade-sim-sand.js exists at the repo root');
ok(existsSync(pinnedJs), 'sdk/v3/arcade-sim-sand.js exists');
if (existsSync(rootJs) && existsSync(pinnedJs)) {
    ok(readFileSync(rootJs).equals(readFileSync(pinnedJs)), 'arcade-sim-sand.js == sdk/v3/arcade-sim-sand.js',
        'fix: cp arcade-sim-sand.js sdk/v3/arcade-sim-sand.js');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
