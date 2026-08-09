/* stage-dispatch.mjs — produce the deploy artifact, one implementation.
 *
 * Launcher-owned, run by fleet-ci.yml. Two jobs need the artifact: `deploy`,
 * which publishes it, and `smoke`, which checks it actually draws. They used
 * to carry the same build-or-stage dispatch as two mirrored shell blocks in
 * the workflow, kept in step by a "change one, change the other" comment on
 * each. That is the exact hand-maintained-mirror class this repo's gates
 * exist to catch, applied to the one thing whose drift is least visible: two
 * repos once shipped a placeholder sw.js that every test was happy with,
 * because the suite staged one way and the deploy another.
 *
 * So there is one dispatcher now, and it is a script rather than YAML for the
 * same reason run-ci.mjs is: a laptop can run exactly what CI runs, and a
 * unit suite can assert what it does.
 *
 *   node stage-dispatch.mjs <outDir> [--optional]
 *
 *     --optional   an app that declares no way to stage is not an error;
 *                  print why and exit 0 without producing <outDir>. This is
 *                  smoke's mode — advisory checks skip, they do not fail.
 *                  The deploy omits it, so the same case exits 1 there.
 *
 * Run from the app's repo root. The dispatch order is the fleet contract
 * (GAME_INTEGRATION §13a):
 *
 *   1. `npm run build`, if package.json declares one. The app owns its build.
 *   2. `node tools/stage.mjs <outDir>` — the fleet default, and the SAME
 *      module the app's own verify-artifact.mjs staged and asserted against
 *      in the gate. One implementation, so what CI publishes is exactly what
 *      the suite proved correct.
 *   3. Neither: the app has not met §13a.
 *
 * Note the asymmetry in installs. The build path may need dependencies, so it
 * installs when node_modules is absent; the stage.mjs path never does, because
 * stage.mjs and inject-precache.mjs are zero-dep by contract. That keeps the
 * common case — every app in the fleet today — free of an npm install the
 * artifact does not need.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

/** Which of the three §13a routes this repo takes. Exported for the suite. */
export function stagingRoute(root = process.cwd()) {
    const pkgPath = join(root, 'package.json');
    if (existsSync(pkgPath)) {
        let pkg;
        try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { pkg = null; }
        if (pkg?.scripts?.build) return 'build';
    }
    if (existsSync(join(root, 'tools/stage.mjs'))) return 'stage';
    return 'none';
}

function sh(cmd, argv, cwd) {
    console.log(`  $ ${cmd} ${argv.join(' ')}`);
    const r = spawnSync(cmd, argv, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    return r.status === 0;
}

/** Stage into outDir. Returns { route, ok, reason }. */
export function dispatch(outDir, { root = process.cwd(), optional = false } = {}) {
    const route = stagingRoute(root);
    const out = resolve(root, outDir);

    if (route === 'none') {
        const reason = optional
            ? 'no build script and no tools/stage.mjs — nothing staged to smoke'
            : 'no build script and no tools/stage.mjs — the app must produce '
              + `${outDir}/ (GAME_INTEGRATION §13a)`;
        return { route, ok: optional, reason };
    }

    if (route === 'build') {
        // Only the build route can need dependencies, and only when the
        // workspace has not already installed them (the deploy job is a fresh
        // checkout; a laptop usually is not).
        if (!existsSync(join(root, 'node_modules'))) {
            const install = existsSync(join(root, 'package-lock.json'))
                ? ['ci'] : ['install'];
            if (!sh('npm', install, root)) {
                return { route, ok: false, reason: `npm ${install[0]} failed` };
            }
        }
        if (!sh('npm', ['run', 'build'], root)) {
            return { route, ok: false, reason: 'npm run build failed' };
        }
    } else {
        if (!sh(process.execPath, ['tools/stage.mjs', outDir], root)) {
            return { route, ok: false, reason: 'tools/stage.mjs failed' };
        }
    }

    // A build that exits 0 having produced nothing is a green deploy of an
    // empty site, which is worse than a red one. Emptiness counts as nothing:
    // `rm -rf dist` followed by a bad file filter leaves the directory behind.
    if (!existsSync(out)) return { route, ok: false, reason: `nothing produced ${outDir}/` };
    if (readdirSync(out).length === 0) return { route, ok: false, reason: `${outDir}/ is empty` };

    return { route, ok: true, reason: `staged ${outDir}/ via ${route}` };
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
    const args = process.argv.slice(2);
    const optional = args.includes('--optional');
    const outDir = args.find((a) => !a.startsWith('--'));
    if (!outDir) {
        console.error('usage: node stage-dispatch.mjs <outDir> [--optional]');
        process.exit(1);
    }
    const r = dispatch(outDir, { optional });
    console.log(`stage-dispatch: ${r.reason}`);
    process.exit(r.ok ? 0 : 1);
}
