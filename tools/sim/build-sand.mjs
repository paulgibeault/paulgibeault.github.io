#!/usr/bin/env node
//
// tools/sim/build-sand.mjs — compile assembly/sand.ts to the checked-in
// sdk/v3/arcade-sim-sand.wasm and its root alias.
//
//   npm run build:sim-sand            # writes sdk/v3/arcade-sim-sand.wasm + /arcade-sim-sand.wasm
//   node tools/sim/build-sand.mjs --out /tmp/x.wasm   # anywhere else (the build gate)
//
// The command line lives here and nowhere else: tools/sim-sand-build-unit.mjs
// imports `ASC_ARGS` and rebuilds with exactly these flags before byte-
// comparing to the checked-in binary, so "the gate rebuilt it differently"
// is not a way for the two to disagree. The launcher deploy stages tracked
// files verbatim (tools/stage.mjs), which is why the binary is checked in
// rather than built in CI — every published byte is a written-down decision.
//
// Flags, and why:
//   --runtime stub   no GC, no allocator beyond a bump pointer; the kernel
//                    lays out its own arena and never frees.
//   -O3 --noAssert   release codegen; there are no assertions to keep.
//   --converge       re-run the optimiser to a fixed point so the output is
//                    the same size no matter how the source was reached.
//   SIMD stays OFF (asc's default) until plan WP4 measures it.
//   bulk-memory stays ON (asc's default): memory.fill for the per-step flag
//   clear. Universal since 2020 (Safari 15), older than the SDK's floor.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SOURCE = path.join(ROOT, 'assembly', 'sand.ts');
export const PINNED = path.join(ROOT, 'sdk', 'v3', 'arcade-sim-sand.wasm');
export const ROOT_ALIAS = path.join(ROOT, 'arcade-sim-sand.wasm');
export const ASC = path.join(ROOT, 'node_modules', 'assemblyscript', 'bin', 'asc.js');

export function ASC_ARGS(outFile) {
    return [
        SOURCE,
        '--outFile', outFile,
        '--runtime', 'stub',
        '--optimizeLevel', '3',
        '--shrinkLevel', '0',
        '--converge',
        '--noAssert',
    ];
}

// Compile to `outFile`. Throws on a compiler failure with asc's own message.
export function build(outFile) {
    mkdirSync(path.dirname(outFile), { recursive: true });
    const r = spawnSync(process.execPath, [ASC, ...ASC_ARGS(outFile)], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error(`asc failed (exit ${r.status}):\n${r.stdout}${r.stderr}`);
    }
    return outFile;
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
    const i = process.argv.indexOf('--out');
    const out = i >= 0 ? path.resolve(process.argv[i + 1]) : PINNED;
    build(out);
    const size = statSync(out).size;
    if (out === PINNED) {
        copyFileSync(PINNED, ROOT_ALIAS);
        console.log(`built ${path.relative(ROOT, PINNED)} (${size} bytes) and copied to ${path.relative(ROOT, ROOT_ALIAS)}`);
    } else {
        console.log(`built ${out} (${size} bytes)`);
    }
}
