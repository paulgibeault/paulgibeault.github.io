/* verify-origin-unit.mjs — the post-deploy check catches a stale origin, and
 * does not cry wolf at a CDN that is merely slow.
 *
 * Both halves matter. A check that cannot tell "stale forever" from "stale for
 * another eight seconds" is either useless or a fleet-wide false alarm, and
 * this one runs on every deploy in ten repos.
 *
 * Named `-unit.mjs` so run-units.mjs discovers it. The fetch is injected, so
 * there is no network and no server to bind — the retry/propagation behaviour
 * is the subject, not HTTP itself.
 */
import { verifyOrigin, parseVersion, artifactVersion } from './verify-origin.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (cond, label) => {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
};
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(1, 52 - t.length))}`);

const scratches = [];
function scratch(files = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'verify-origin-'));
    scratches.push(dir);
    for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b);
    return dir;
}

const sw = (v) => `const CACHE_PREFIX = 'x-';\nconst APP_VERSION = '${v}';\n`;
const quiet = () => {};
/** A fake origin. `versions` is the sequence it serves, one per attempt. */
const serving = (versions, status = 200) => {
    const calls = [];
    const impl = async (url, attempt) => {
        calls.push(url);
        const v = versions[Math.min(attempt - 1, versions.length - 1)];
        return { status, body: v === null ? '' : sw(v) };
    };
    impl.calls = calls;
    return impl;
};

try {
    section('reading the expected version');
    ok(artifactVersion(scratch({ 'sw.js': sw('1.2.33') })) === '1.2.33',
        "the artifact's own sw.js is the source of truth");
    ok(artifactVersion(scratch({})) === null, 'an artifact with no sw.js has no version');
    ok(artifactVersion(scratch({ 'sw.js': "const CACHE = 'hand-numbered';\n" })) === null,
        'an sw.js with no APP_VERSION line has no version');
    ok(parseVersion("  const APP_VERSION = '9.9.9';") === null,
        'the parse is anchored, exactly like the rewrite it verifies');

    section('the happy path');
    let r = await verifyOrigin('https://x.test/app', {
        expected: '1.2.33', fetchImpl: serving(['1.2.33']), log: quiet,
    });
    ok(r.ok && r.saw === '1.2.33', 'a fresh origin passes on the first attempt');

    const impl = serving(['1.2.33']);
    await verifyOrigin('https://x.test/app', { expected: '1.2.33', fetchImpl: impl, log: quiet });
    ok(impl.calls[0].startsWith('https://x.test/app/sw.js'),
        'a page url with no trailing slash still resolves sw.js correctly');
    ok(/[?&]__ci=/.test(impl.calls[0]),
        'the request is cache-busted — a CDN echoing our own stale copy back is '
        + 'the one answer this check must never accept');

    section('propagation vs. an actually stale origin');
    // The CDN is a beat behind, then catches up. This MUST pass: a fleet-wide
    // check that fails on normal propagation gets switched off within a week.
    r = await verifyOrigin('https://x.test/app', {
        expected: '1.2.33', delayMs: 1,
        fetchImpl: serving(['1.2.32', '1.2.32', '1.2.33']), log: quiet,
    });
    ok(r.ok, 'an origin that catches up on the third attempt passes');
    ok(/after 3 attempts/.test(r.reason), 'and says how long it took');

    // The real bug: the origin keeps serving the old worker forever.
    r = await verifyOrigin('https://x.test/app', {
        expected: '1.2.33', attempts: 3, delayMs: 1,
        fetchImpl: serving(['1.2.32']), log: quiet,
    });
    ok(!r.ok, 'an origin stuck on the old version FAILS');
    ok(r.saw === '1.2.32' && /still serves 1\.2\.32/.test(r.reason),
        'and reports what it actually saw, not just that it failed');

    r = await verifyOrigin('https://x.test/app', {
        expected: '1.2.33', attempts: 2, delayMs: 1,
        fetchImpl: serving(['x'], 404), log: quiet,
    });
    ok(!r.ok && /HTTP 404/.test(r.reason),
        'a 404 fails — this is what a Pages source reset to "deploy from branch" looks like');

    r = await verifyOrigin('https://x.test/app', {
        expected: '1.2.33', attempts: 2, delayMs: 1, log: quiet,
        fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    ok(!r.ok && /ECONNREFUSED/.test(r.reason), 'a network error is reported, not swallowed');

    section('apps with no service worker');
    r = await verifyOrigin('https://x.test/app/', {
        expected: null, fetchImpl: async () => ({ status: 200, body: '<html>hi</html>' }),
        log: quiet,
    });
    ok(r.ok, 'a non-empty page is the floor check when there is no sw.js');

    r = await verifyOrigin('https://x.test/app/', {
        expected: null, attempts: 2, delayMs: 1, log: quiet,
        fetchImpl: async () => ({ status: 200, body: '   ' }),
    });
    ok(!r.ok && /EMPTY/.test(r.reason), 'an empty body fails even with nothing to version');

    // Regression guard on the floor check's target: with no sw.js to ask about,
    // it must request the page itself, not a sw.js that was never deployed.
    const rootImpl = serving(['1.0.0']);
    await verifyOrigin('https://x.test/app', {
        expected: null, fetchImpl: rootImpl, log: quiet,
    });
    ok(!rootImpl.calls[0].includes('sw.js'), 'and it asks for the page, not for sw.js');
} finally {
    for (const d of scratches) rmSync(d, { recursive: true, force: true });
}

console.log(`\n${fail ? '✗' : '✓'} verify-origin: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
