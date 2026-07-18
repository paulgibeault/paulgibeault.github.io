/* sdk-version-unit.mjs — gates the SDK versioned-publish scheme (C6).
 *
 * The scheme: /arcade-sdk.js (repo root) is the canonical source AND the
 * evergreen alias; sdk/v<major>/arcade-sdk.js is the major-pinned URL games
 * load, byte-identical while that major is current; older sdk/v<N>/ dirs are
 * frozen forever. sdk/CHANGELOG.md carries the release log. None of that is
 * enforced by any build step (Pages deploys the tree verbatim), so this gate
 * is what keeps the copies and numbers from drifting:
 *
 *   Gate A — SDK_SEMVER parses as semver and its major equals VERSION.
 *   Gate B — sdk/v<major>/arcade-sdk.js is byte-identical to /arcade-sdk.js.
 *   Gate C — the newest sdk/CHANGELOG.md entry is exactly SDK_SEMVER.
 *   Gate D — every sdk/v<N>/ dir: N never exceeds the current major, and a
 *            frozen dir's copy still declares VERSION = N (catches a frozen
 *            major being clobbered by a newer file).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function ok(cond, label) {
    console.log(`  ${cond ? '✓' : '✗'} ${label}`);
    if (!cond) failures++;
}

function parseConst(src, re, what) {
    const m = re.exec(src);
    if (!m) throw new Error(`could not find ${what}`);
    return m[1];
}

const rootSdk = readFileSync(join(ROOT, 'arcade-sdk.js'), 'utf8');
const semver = parseConst(rootSdk, /var SDK_SEMVER = '([^']+)';/, 'SDK_SEMVER');
const wireVersion = Number(parseConst(rootSdk, /var VERSION = (\d+);/, 'VERSION'));

console.log('\nGate A — SDK_SEMVER well-formed, major == VERSION');
const semMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(semver);
ok(!!semMatch, `SDK_SEMVER '${semver}' is MAJOR.MINOR.PATCH`);
const major = semMatch ? Number(semMatch[1]) : NaN;
ok(major === wireVersion, `semver major (${major}) == VERSION (${wireVersion})`);

console.log('\nGate B — pinned copy in sync with canonical source');
const pinnedPath = join('sdk', `v${major}`, 'arcade-sdk.js');
ok(existsSync(join(ROOT, pinnedPath)), `${pinnedPath} exists`);
if (existsSync(join(ROOT, pinnedPath))) {
    const inSync = readFileSync(join(ROOT, pinnedPath), 'utf8') === rootSdk;
    ok(inSync, `${pinnedPath} byte-identical to arcade-sdk.js`);
    if (!inSync) console.log(`      fix: cp arcade-sdk.js ${pinnedPath}   (and add a sdk/CHANGELOG.md entry)`);
}

console.log('\nGate C — newest CHANGELOG entry matches SDK_SEMVER');
const changelog = readFileSync(join(ROOT, 'sdk', 'CHANGELOG.md'), 'utf8');
const newest = /^## (\d+\.\d+\.\d+)/m.exec(changelog);
ok(!!newest, 'sdk/CHANGELOG.md has a "## X.Y.Z" release entry');
ok(!!newest && newest[1] === semver, `newest entry (${newest && newest[1]}) == SDK_SEMVER (${semver})`);

console.log('\nGate D — sdk/v* directories: no future majors, frozen majors intact');
const dirs = readdirSync(join(ROOT, 'sdk'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^v\d+$/.test(d.name));
ok(dirs.length > 0, 'at least one sdk/v<N>/ directory exists');
for (const d of dirs) {
    const n = Number(d.name.slice(1));
    ok(n <= major, `sdk/${d.name} does not exceed current major ${major}`);
    const file = join(ROOT, 'sdk', d.name, 'arcade-sdk.js');
    ok(existsSync(file), `sdk/${d.name}/arcade-sdk.js exists`);
    if (n < major && existsSync(file)) {
        const frozenVersion = Number(parseConst(readFileSync(file, 'utf8'), /var VERSION = (\d+);/, `VERSION in sdk/${d.name}`));
        ok(frozenVersion === n, `frozen sdk/${d.name} still declares VERSION = ${n} (found ${frozenVersion})`);
    }
}

if (failures) {
    console.log(`\n✗ sdk-version gates: ${failures} failure(s)`);
    process.exit(1);
}
console.log('\n✓ sdk-version gates passed');
