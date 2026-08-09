/* bump-version.mjs — advance the patch version everywhere it is declared.
 *
 * Launcher-owned, run by fleet-ci.yml's deploy job for any caller that passes
 * `version_bump: true`. This was ~50 lines of inline node and sed in the
 * workflow: the last real logic in the fleet's YAML, and the only part of the
 * pipeline with no test behind it, in a repo whose whole tooling convention is
 * that logic lives in scripts a laptop can run (see run-ci.mjs). It also ran
 * against nine other repos, where being wrong is someone else's bad deploy.
 *
 *   node bump-version.mjs [--root <dir>] [--no-commit] [--no-push]
 *
 * WHY THE VERSION MATTERS AT ALL. A service worker only reinstalls when its
 * BYTES change. sw.js derives its cache name from APP_VERSION, so rewriting
 * that line is what makes install → activate → drop-the-stale-cache happen on
 * a deploy. Left to a hand-maintained constant it once shipped a fix to the
 * origin that no returning player ever executed — the incident that put CI in
 * charge of the version. Every file below is optional and guarded, because an
 * app adopts the standard one piece at a time; the exception is package.json,
 * which every app has.
 *
 * ── The index.html badge, and why it is no longer a global sed ──────────────
 *
 * The old step ran `sed -i "s/v[0-9]\+\.[0-9]\+\.[0-9]\+/vNEW/g" index.html`.
 * The `g` is the bug: it rewrites EVERY version-shaped string in the file. One
 * app in the fleet renders a badge, and it happens to be the only `vX.Y.Z` in
 * its index.html — so the blast radius was zero by luck, not by design. A
 * changelog line, an "requires v2.0.0" note, a vendored library's version in a
 * comment, a CDN URL with a version in the path: any of those would have been
 * silently rewritten to the app's own version on the next deploy, and nothing
 * would have failed.
 *
 * So the badge is DECLARED, not guessed: the element carrying
 * id="version-tracker" is the badge, and only the version inside it moves.
 * When an index.html shows the current version but declares no badge, that is
 * reported as a warning rather than repaired by pattern-matching — a rewrite
 * this script cannot do precisely is one it should not do at all.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const BADGE_ID = 'version-tracker';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** '1.2.32' -> '1.2.33'. Throws on anything that is not a plain X.Y.Z. */
export function nextPatch(version) {
    const m = SEMVER.exec(String(version ?? '').trim());
    if (!m) throw new Error(`not a plain X.Y.Z version: ${JSON.stringify(version)}`);
    return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** Rewrite the version inside the declared badge element only.
 *  Returns { html, changed, warning }. */
export function rewriteBadge(html, current, next) {
    const el = new RegExp(
        `(<([a-zA-Z][\\w-]*)\\b[^>]*\\bid=["']${BADGE_ID}["'][^>]*>)([\\s\\S]*?)(</\\2>)`);
    const m = el.exec(html);
    if (!m) {
        // Nothing to do is the common case (most apps render no badge). Only
        // say something when the file looks like it WANTS a badge — a version
        // string is sitting there and will now go stale.
        const stale = new RegExp(`\\bv?${current.replace(/\./g, '\\.')}\\b`).test(html);
        return {
            html, changed: false,
            warning: stale
                ? `index.html contains ${current} but declares no id="${BADGE_ID}" `
                  + 'element; leaving it alone rather than rewriting every '
                  + 'version-shaped string in the file. Add the id to the badge.'
                : null,
        };
    }
    const inner = m[3];
    const bumped = inner.replace(/\bv?(\d+\.\d+\.\d+)\b/,
        (hit) => (hit.startsWith('v') ? 'v' : '') + next);
    if (bumped === inner) {
        return {
            html, changed: false,
            warning: `the id="${BADGE_ID}" element holds no X.Y.Z version to bump`,
        };
    }
    return {
        html: html.slice(0, m.index) + m[1] + bumped + m[4]
            + html.slice(m.index + m[0].length),
        changed: true, warning: null,
    };
}

/** Move the cache-buster in a manifest start_url without touching its path.
 *  Root-absolute start_urls ("/gameId/") are the deployed arcade path, not a
 *  file this repo publishes — verify-artifact.mjs treats them that way too. */
export function rewriteStartUrl(startUrl, next) {
    if (typeof startUrl !== 'string' || !startUrl) return `./index.html?v=${next}`;
    if (startUrl.startsWith('/')) return startUrl;
    const [path, query = ''] = startUrl.split('?');
    const params = new URLSearchParams(query);
    params.set('v', next);
    return `${path}?${params}`;
}

/** Rewrite the anchored APP_VERSION declaration CI owns (§10, Gate D). */
export function rewriteAppVersion(src, next) {
    const line = /^const APP_VERSION = '[^']*';$/m;
    if (!line.test(src)) return { src, changed: false };
    return { src: src.replace(line, `const APP_VERSION = '${next}';`), changed: true };
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n');

/** Apply the bump to every file that declares a version.
 *  Returns { current, next, changed: [paths], warnings: [strings] }. */
export function applyBump(root = process.cwd()) {
    const pkgPath = join(root, 'package.json');
    if (!existsSync(pkgPath)) throw new Error(`no package.json in ${root}`);
    const pkg = readJson(pkgPath);
    const current = pkg.version;
    const next = nextPatch(current);
    const changed = [];
    const warnings = [];

    pkg.version = next;
    writeJson(pkgPath, pkg);
    changed.push('package.json');

    const manPath = join(root, 'manifest.json');
    if (existsSync(manPath)) {
        const man = readJson(manPath);
        const url = rewriteStartUrl(man.start_url, next);
        if (url !== man.start_url) {
            man.start_url = url;
            writeJson(manPath, man);
            changed.push('manifest.json');
        }
    }

    const idxPath = join(root, 'index.html');
    if (existsSync(idxPath)) {
        const r = rewriteBadge(readFileSync(idxPath, 'utf8'), current, next);
        if (r.warning) warnings.push(r.warning);
        if (r.changed) { writeFileSync(idxPath, r.html); changed.push('index.html'); }
    }

    const swPath = join(root, 'sw.js');
    if (existsSync(swPath)) {
        const r = rewriteAppVersion(readFileSync(swPath, 'utf8'), next);
        if (r.changed) { writeFileSync(swPath, r.src); changed.push('sw.js'); }
        else {
            // Not fatal here — Gate D in repo-gates-unit.mjs is what fails a
            // repo whose sw.js has drifted out of the shape CI rewrites. But
            // it must be loud: a silent no-op here is precisely the failure
            // where a green deploy reaches no returning player at all.
            warnings.push('sw.js declares no `const APP_VERSION = \'…\';` line — '
                + 'its cache identity will NOT advance on this deploy (§10, Gate D)');
        }
    }

    return { current, next, changed, warnings };
}

const git = (args, cwd) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Commit the staged bump and push it, rebasing onto whatever landed while the
 *  gate was running.
 *
 *  The old step was a bare `git push`. A commit landing on main during the
 *  test job — a plausible few minutes on this fleet — made it reject, and the
 *  deploy then failed AFTER a green gate, having already rewritten the files.
 *  Retrying is safe here in a way it usually is not: this commit touches only
 *  generated version declarations, so a rebase cannot produce a semantic
 *  conflict with someone's real change. */
export function commitAndPush(root, next, changed, { attempts = 3, push = true } = {}) {
    git(['config', 'user.name', 'github-actions[bot]'], root);
    git(['config', 'user.email',
        '41898282+github-actions[bot]@users.noreply.github.com'], root);
    // Only the files actually rewritten — naming index.html or manifest.json
    // unconditionally fails the deploy for an app that has neither.
    git(['add', '--', ...changed], root);
    if (spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: root }).status === 0) {
        return { committed: false, pushed: false };
    }
    git(['commit', '-m', `chore: auto-bump to v${next} [skip ci]`], root);
    if (!push) return { committed: true, pushed: false };

    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim();
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const r = spawnSync('git', ['push', 'origin', `HEAD:${branch}`],
            { cwd: root, encoding: 'utf8' });
        if (r.status === 0) return { committed: true, pushed: true, attempts: attempt };
        if (attempt === attempts) {
            throw new Error(`git push failed after ${attempts} attempts:\n${r.stderr}`);
        }
        console.log(`  push rejected (attempt ${attempt}); rebasing onto origin/${branch}`);
        git(['fetch', 'origin', branch], root);
        git(['rebase', `origin/${branch}`], root);
    }
    return { committed: true, pushed: false };
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
    const arg = (name) => {
        const i = process.argv.indexOf(name);
        return i === -1 ? null : process.argv[i + 1];
    };
    const root = resolve(arg('--root') || process.cwd());
    try {
        const { current, next, changed, warnings } = applyBump(root);
        for (const w of warnings) console.log(`  ! ${w}`);
        console.log(`  rewrote: ${changed.join(', ')}`);
        if (!process.argv.includes('--no-commit')) {
            const r = commitAndPush(root, next, changed,
                { push: !process.argv.includes('--no-push') });
            if (!r.committed) console.log('  nothing to commit');
        }
        console.log(`Bumped ${current} → ${next}`);
    } catch (e) {
        console.error(`bump-version: ${e.message || e}`);
        process.exit(1);
    }
}
