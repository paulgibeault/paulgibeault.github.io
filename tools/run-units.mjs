/* run-units.mjs — the aggregate no-browser unit tier: discovers and runs
 * every tools/*-unit.mjs suite sequentially, one summary, one exit code.
 *
 * Discovery over enumeration on purpose: the unit-suite list previously
 * lived in BOTH package.json (26 hand-listed scripts) and pages.yml (one
 * step per suite), and the two had to be edited in lockstep — the same
 * hand-maintained-list drift class the repo-gates suite exists to catch.
 * A new suite now only has to be named `tools/<thing>-unit.mjs` to run
 * locally (`npm test`) and in CI.
 *
 * Browser/Playwright acceptance suites are deliberately NOT run here — they
 * need installed browsers, bind ports, and must run one at a time; CI keeps
 * them as explicit workflow steps.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(TOOLS).filter((f) => f.endsWith('-unit.mjs')).sort();

if (!suites.length) {
    console.error('run-units: no tools/*-unit.mjs suites found');
    process.exit(1);
}

console.log(`Unit tier — ${suites.length} suites (tools/*-unit.mjs, discovered)\n`);
const failed = [];
for (const suite of suites) {
    console.log(`── ${suite} ${'─'.repeat(Math.max(1, 60 - suite.length))}`);
    const res = spawnSync(process.execPath, [join(TOOLS, suite)], { stdio: 'inherit' });
    if (res.status !== 0) failed.push(suite);
    console.log('');
}

if (failed.length) {
    console.log(`✗ ${failed.length}/${suites.length} unit suites FAILED: ${failed.join(', ')}`);
    process.exit(1);
}
console.log(`✓ all ${suites.length} unit suites passed`);
