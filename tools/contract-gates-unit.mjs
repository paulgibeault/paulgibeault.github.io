/* contract-gates-unit.mjs — proves the fleet contract gate both fires and
 * doesn't, and that this repo passes its own rule.
 *
 * Named `-unit.mjs` so run-units.mjs discovers it: the gate is checked by
 * `npm test` here, on a laptop, exactly as fleet-ci checks it for every caller.
 * That matters more for this gate than for most — it runs against nine other
 * repos' checkouts, where a false positive is someone else's red build on a
 * change that has nothing to do with it.
 *
 * Two halves:
 *   1. the fixture corpus (tools/fixtures/contract-gates), via --self-test
 *   2. this repo, which must pass with zero exemptions — there is no exemption
 *      mechanism to use. The launcher owning the rule and not meeting it is
 *      the state issue #129 existed to end.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOLS, '..');
const GATE = join(TOOLS, 'contract-gates.mjs');

let failed = 0;
const stage = (label, argv, wantStatus = 0) => {
    console.log(`\n── ${label} ${'─'.repeat(Math.max(1, 52 - label.length))}`);
    const res = spawnSync(process.execPath, [GATE, ...argv], { cwd: ROOT, stdio: 'inherit' });
    if (res.status === wantStatus) return;
    failed++;
    console.log(`  ✗ expected exit ${wantStatus}, got ${res.status}`);
};

/** A throwaway git checkout, so the end-to-end stages exercise the real
 *  `git ls-files` enumeration path the pipeline uses against other repos —
 *  not just the in-process gate functions. */
function scratchRepo(files) {
    const dir = mkdtempSync(join(tmpdir(), 'contract-gates-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    for (const [name, body] of Object.entries(files)) {
        const full = join(dir, name);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, body);
    }
    execFileSync('git', ['add', '-A'], { cwd: dir });
    return dir;
}

stage('fixtures — every real idiom passes, every planted violation fails',
    ['--self-test']);
stage('this repo passes its own gate', [ROOT]);

// The self-test above checks each fixture in process. These three drive the
// real CLI, because the exit code is what the pipeline reads — a gate whose
// findings are correct but whose exit path is broken is green everywhere.
const scratches = [];
try {
    const violating = scratchRepo({
        'index.html': '<style>.a { animation: spin 1s linear infinite; }</style>\n',
    });
    scratches.push(violating);
    stage('the CLI exits 1 on a violating checkout', [violating], 1);

    const clean = scratchRepo({
        'style.css': '.a { animation-name: spin; animation-iteration-count: 1; }\n',
        'app.js': 'const s = A.settings.powerSaver ? A.settings.powerSaver() : false;\n',
    });
    scratches.push(clean);
    stage('the CLI exits 0 on a clean checkout', [clean], 0);

    // Nothing to scan must not read as three green gates. This is the shape a
    // silently-failed checkout takes, and it would otherwise pass for every
    // caller at once without anyone noticing the gate had stopped running.
    const empty = scratchRepo({ 'README.md': '# nothing to scan here\n' });
    scratches.push(empty);
    stage('the CLI refuses to pass a checkout with nothing to scan', [empty], 2);
} finally {
    for (const d of scratches) rmSync(d, { recursive: true, force: true });
}

console.log(failed
    ? `\n✗ ${failed} contract-gate stage(s) FAILED`
    : '\n✓ contract gates: fixtures green, this repo clean, CLI fails loudly');
process.exit(failed ? 1 : 0);
