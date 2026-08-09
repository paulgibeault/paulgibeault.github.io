/* verify-origin.mjs — does the live origin actually serve what we just built?
 *
 * Launcher-owned, run by fleet-ci.yml as the last step of the deploy job.
 *
 * Everything upstream of this proves things about a WORKSPACE. The gate proves
 * the code is sound, verify-artifact.mjs proves the staged dist/ is complete,
 * render-smoke proves that dist/ draws. `actions/deploy-pages` succeeding
 * proves GitHub ACCEPTED an artifact. None of them proves a browser loading
 * the public URL gets those bytes — and that gap is not hypothetical. A green
 * deploy of a real fix once reached no returning player at all, because the
 * one thing that decides whether a player re-fetches anything — sw.js's cache
 * identity — had not moved.
 *
 *   node verify-origin.mjs <pageUrl> [--artifact dist] [--attempts 8] [--warn]
 *
 * WHAT IT COMPARES. The expected version is read from the STAGED ARTIFACT, not
 * passed in from the bump step. That keeps this check independent of how the
 * version got there: it is meaningful for a caller with `version_bump: false`
 * (whose sw.js is hand-numbered) exactly as it is for one with the bump on,
 * and it cannot be fooled by a bump that edited the workspace but never made
 * it into what deployed.
 *
 * WHY IT IS ENFORCING, where the render smoke is advisory. This is a plain HTTP
 * GET, not a browser on a shared runner — the flake surface is a CDN that has
 * not caught up yet, which retries cover. It also runs AFTER the deploy has
 * happened, so failing blocks nothing; it converts a silent bad deploy into a
 * red build. A warn-only version of this check would reproduce the very bug it
 * exists to catch: nobody reads an annotation on a green run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const APP_VERSION_RE = /^const APP_VERSION = '([^']*)';$/m;

/** The version the artifact we just uploaded declares, or null. */
export function artifactVersion(artifactDir) {
    const sw = join(artifactDir, 'sw.js');
    if (!existsSync(sw)) return null;
    return APP_VERSION_RE.exec(readFileSync(sw, 'utf8'))?.[1] ?? null;
}

/** The version an already-fetched sw.js body declares, or null. */
export function parseVersion(body) {
    return APP_VERSION_RE.exec(body)?.[1] ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch bypassing every cache that honours headers. The query-string half of
 *  the busting is built by the caller, so it is visible to the suite — a check
 *  that silently accepted a cached copy of the OLD worker would pass exactly
 *  when it most needs to fail. */
async function fetchFresh(url) {
    const res = await fetch(url, {
        headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
        redirect: 'follow',
    });
    return { status: res.status, body: res.ok ? await res.text() : '' };
}

/** A URL no cache between here and the origin has seen before. */
export function cacheBust(url, attempt) {
    return `${url}${url.includes('?') ? '&' : '?'}__ci=${attempt}-${process.pid}`;
}

/** Poll the origin until it serves `expected`, or attempts run out.
 *  Returns { ok, reason, saw }. */
export async function verifyOrigin(pageUrl, {
    expected = null, attempts = 8, delayMs = 10_000, fetchImpl = fetchFresh, log = console.log,
} = {}) {
    const base = pageUrl.endsWith('/') ? pageUrl : pageUrl + '/';
    const target = expected === null ? base : base + 'sw.js';
    let saw = null;
    let lastReason = 'no attempt was made';

    for (let attempt = 1; attempt <= attempts; attempt++) {
        let res;
        try {
            res = await fetchImpl(cacheBust(target, attempt), attempt);
        } catch (e) {
            lastReason = `request failed: ${e.message || e}`;
            res = null;
        }
        if (res) {
            if (res.status !== 200) {
                lastReason = `${target} returned HTTP ${res.status}`;
            } else if (expected === null) {
                // No service worker to check. Proving the origin serves a
                // non-empty page is a floor, not a version check — but it does
                // catch a Pages source misconfigured back to "deploy from
                // branch", which serves a 404 while the workflow stays green.
                if (res.body.trim().length > 0) {
                    return { ok: true, reason: `${target} serves a non-empty page`, saw: null };
                }
                lastReason = `${target} served an EMPTY body`;
            } else {
                saw = parseVersion(res.body);
                if (saw === expected) {
                    return {
                        ok: true, saw,
                        reason: `origin serves sw.js APP_VERSION ${saw}`
                            + (attempt > 1 ? ` (after ${attempt} attempts)` : ''),
                    };
                }
                lastReason = saw === null
                    ? 'the live sw.js declares no APP_VERSION line'
                    : `origin still serves ${saw}, expected ${expected}`;
            }
        }
        if (attempt < attempts) {
            log(`  ${lastReason} — retrying in ${delayMs / 1000}s `
                + `(${attempt}/${attempts})`);
            await sleep(delayMs);
        }
    }
    return { ok: false, reason: lastReason, saw };
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
    const argv = process.argv.slice(2);
    const flag = (name, fallback) => {
        const i = argv.indexOf(name);
        return i === -1 ? fallback : argv[i + 1];
    };
    const pageUrl = argv.find((a) => /^https?:\/\//.test(a));
    if (!pageUrl) {
        console.error('usage: node verify-origin.mjs <pageUrl> [--artifact dist] '
            + '[--attempts 8] [--warn]');
        process.exit(1);
    }
    const artifact = resolve(flag('--artifact', 'dist'));
    const warn = argv.includes('--warn');
    const expected = artifactVersion(artifact);

    if (expected === null) {
        console.log(existsSync(join(artifact, 'sw.js'))
            ? `The artifact's sw.js declares no APP_VERSION — checking only that the `
              + 'origin serves a page.'
            : 'The artifact ships no sw.js — checking only that the origin serves a page.');
    } else {
        console.log(`The artifact declares APP_VERSION ${expected}; asking ${pageUrl}`);
    }

    const r = await verifyOrigin(pageUrl, {
        expected, attempts: Number(flag('--attempts', 8)),
    });
    if (r.ok) {
        console.log(`✓ ${r.reason}`);
        process.exit(0);
    }
    console.error(`\n✗ the origin does not serve what this run deployed: ${r.reason}\n\n`
        + '  A deploy that GitHub accepted but the origin does not serve is the\n'
        + '  silent failure this check exists for. Two things worth looking at:\n'
        + '    · Pages source must be "GitHub Actions", not "deploy from branch"\n'
        + '      (Settings → Pages) — otherwise Jekyll races this workflow.\n'
        + '    · sw.js must declare the anchored APP_VERSION line CI rewrites,\n'
        + '      or its cache identity never advances (§10, repo-gates Gate D).');
    process.exit(warn ? 0 : 1);
}
