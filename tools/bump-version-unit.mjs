/* bump-version-unit.mjs — the deploy's version rewrite, including the two ways
 * it used to be able to go wrong silently.
 *
 * This logic ran for years as inline sed and node inside fleet-ci.yml, against
 * ten repos, with nothing testing it. The cases that matter most here are not
 * "does it add one to the patch number" but:
 *
 *   · the badge rewrite must not touch version-shaped strings it was never
 *     asked to touch (the old `sed …/g` did, and only luck kept the blast
 *     radius at zero);
 *   · a push that races a commit onto main must rebase and land, not fail the
 *     deploy after the gate has already gone green.
 *
 * Named `-unit.mjs` so run-units.mjs discovers it. Uses git against throwaway
 * repos with a real bare remote — the push path is the fragile one, so it is
 * exercised for real rather than mocked.
 */
import {
    nextPatch, rewriteBadge, rewriteStartUrl, rewriteAppVersion,
    applyBump, commitAndPush, BADGE_ID,
} from './bump-version.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
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
    const dir = mkdtempSync(join(tmpdir(), 'bump-version-'));
    scratches.push(dir);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
}
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });

try {
    section('nextPatch');
    ok(nextPatch('1.2.32') === '1.2.33', '1.2.32 → 1.2.33');
    ok(nextPatch('0.0.9') === '0.0.10', '0.0.9 → 0.0.10 (no string sort)');
    ok(nextPatch('1.9.99') === '1.9.100', 'the patch field is not capped at two digits');
    for (const bad of ['1.2', 'v1.2.3', '1.2.3-rc1', '', null, undefined]) {
        let threw = false;
        try { nextPatch(bad); } catch { threw = true; }
        ok(threw, `refuses ${JSON.stringify(bad)} rather than inventing a version`);
    }

    section('the index.html badge — the old sed bug');
    // The real shape in the fleet: a small absolutely-positioned tracker div.
    const withBadge = '<html><body>\n'
        + `  <div id="${BADGE_ID}" style="position:absolute">\n    v1.2.32\n  </div>\n`
        + '</body></html>';
    let r = rewriteBadge(withBadge, '1.2.32', '1.2.33');
    ok(r.changed && r.html.includes('v1.2.33'), 'the declared badge is bumped');
    ok(!r.warning, 'and says nothing, because there is nothing to report');

    // The regression the extraction exists to prevent. Under the old
    // `sed -e "s/v[0-9]\+\.[0-9]\+\.[0-9]\+/vNEW/g"` every one of these moved.
    const noisy = '<html><body>\n'
        + '  <!-- changelog: v1.0.0 first cut, v1.1.0 added sound -->\n'
        + '  <p>Requires the arcade SDK v3.13.0 or newer.</p>\n'
        + '  <script src="./vendor/thing-v2.4.1.js"></script>\n'
        + `  <div id="${BADGE_ID}">v1.2.32</div>\n`
        + '</body></html>';
    r = rewriteBadge(noisy, '1.2.32', '1.2.33');
    ok(r.changed, 'the badge in a noisy file still moves');
    ok(r.html.includes('v1.0.0') && r.html.includes('v1.1.0'),
        'changelog versions are untouched');
    ok(r.html.includes('SDK v3.13.0'), 'a documented dependency version is untouched');
    ok(r.html.includes('thing-v2.4.1.js'), 'a vendored filename is untouched');
    ok((r.html.match(/v1\.2\.33/g) || []).length === 1, 'exactly one version moved');

    r = rewriteBadge('<p>running v1.2.32 today</p>', '1.2.32', '1.2.33');
    ok(!r.changed, 'an undeclared badge is NOT rewritten by pattern-matching');
    ok(/declares no id=/.test(r.warning || ''), 'and that is reported, not silent');

    r = rewriteBadge('<p>nothing versioned here</p>', '1.2.32', '1.2.33');
    ok(!r.changed && !r.warning, 'a file with no version at all is quietly left alone');

    r = rewriteBadge(`<span id="${BADGE_ID}">beta</span>`, '1.2.32', '1.2.33');
    ok(!r.changed && /holds no X.Y.Z/.test(r.warning || ''),
        'a badge with no version in it warns');

    r = rewriteBadge(`<div id='${BADGE_ID}' class="x">1.2.32</div>`, '1.2.32', '1.2.33');
    ok(r.changed && r.html.includes('>1.2.33<'),
        "single quotes, extra attributes, and a bare (no 'v') version all work");

    section('manifest start_url');
    ok(rewriteStartUrl('./index.html?v=1.2.32', '1.2.33') === './index.html?v=1.2.33',
        'the cache-buster moves');
    ok(rewriteStartUrl('./play.html?v=1.0.0', '1.2.33') === './play.html?v=1.2.33',
        'a non-index entry point keeps its path');
    ok(rewriteStartUrl('/some-app/', '1.2.33') === '/some-app/',
        'a root-absolute start_url is the arcade path, and is left alone');
    ok(rewriteStartUrl('./index.html', '1.2.33') === './index.html?v=1.2.33',
        'a start_url with no query gains one');
    ok(rewriteStartUrl(undefined, '1.2.33') === './index.html?v=1.2.33',
        'a manifest with no start_url gets the fleet default');

    section('sw.js APP_VERSION');
    let s = rewriteAppVersion("const APP_VERSION = '1.2.32';\nconst C = 1;\n", '1.2.33');
    ok(s.changed && s.src.includes("const APP_VERSION = '1.2.33';"), 'the anchored line moves');
    // Gate D asserts the line keeps this exact shape precisely because the
    // rewrite is anchored; if it drifts, the bump silently stops happening.
    s = rewriteAppVersion("  const APP_VERSION = '1.2.32';\n", '1.2.33');
    ok(!s.changed, 'an indented declaration does NOT match (Gate D guards this)');
    s = rewriteAppVersion("// mentions const APP_VERSION = '1.2.32'; in prose\n", '1.2.33');
    ok(!s.changed, 'the line quoted inside a comment is not the declaration');

    section('applyBump, end to end');
    const root = scratch({
        'package.json': JSON.stringify({ name: 'x', version: '0.0.9' }, null, 2),
        'manifest.json': JSON.stringify({ start_url: './index.html?v=0.0.9' }, null, 2),
        'index.html': `<div id="${BADGE_ID}">v0.0.9</div>`,
        'sw.js': "const APP_VERSION = '0.0.9';\n",
    });
    const res = applyBump(root);
    ok(res.next === '0.0.10', 'reports the new version');
    ok(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version === '0.0.10',
        'package.json');
    ok(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).start_url
        === './index.html?v=0.0.10', 'manifest.json');
    ok(readFileSync(join(root, 'index.html'), 'utf8').includes('v0.0.10'), 'index.html');
    ok(readFileSync(join(root, 'sw.js'), 'utf8').includes("'0.0.10'"), 'sw.js');
    ok(res.changed.length === 4, 'and stages exactly the four files it rewrote');

    // The point of the guards: an app adopts the standard one piece at a time.
    const minimal = scratch({ 'package.json': '{"name":"y","version":"2.0.0"}' });
    const min = applyBump(minimal);
    ok(min.next === '2.0.1', 'an app with only a package.json bumps and does not crash');
    ok(min.changed.length === 1, 'and stages only package.json');

    const noSwLine = scratch({
        'package.json': '{"name":"z","version":"1.0.0"}',
        'sw.js': "const CACHE = 'hand-numbered-v4';\n",
    });
    ok(applyBump(noSwLine).warnings.some((w) => /cache identity will NOT advance/.test(w)),
        'an sw.js that dropped the APP_VERSION line warns loudly');

    section('the push race — rebase and land');
    const bare = scratch();
    git(['init', '--bare', '-q'], bare);
    // Pin the remote's HEAD too, or a clone of it comes up on the local git's
    // default branch name instead of main and checks out nothing.
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
    const ident = ['-c', 'user.email=t@example.com', '-c', 'user.name=T'];

    const a = scratch();
    git(['clone', '-q', bare, '.'], a);
    // An empty clone leaves HEAD unborn on whatever the local git calls its
    // default branch. Name it outright rather than depending on that default.
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], a);
    writeFileSync(join(a, 'package.json'), '{"name":"a","version":"1.0.0"}\n');
    writeFileSync(join(a, 'sw.js'), "const APP_VERSION = '1.0.0';\n");
    git(['add', '-A'], a);
    git([...ident, 'commit', '-q', '-m', 'initial'], a);
    git(['push', '-q', '-u', 'origin', 'main'], a);

    // Someone else's commit lands on main while our gate is still running.
    const b = scratch();
    git(['clone', '-q', bare, '.'], b);
    writeFileSync(join(b, 'NOTES.md'), 'a real change from another PR\n');
    git(['add', '-A'], b);
    git([...ident, 'commit', '-q', '-m', 'feat: someone else got there first'], b);
    git(['push', '-q', 'origin', 'main'], b);

    const bumped = applyBump(a);
    const push = commitAndPush(a, bumped.next, bumped.changed);
    ok(push.pushed, 'the bump lands despite the race');
    ok(push.attempts === 2, 'after exactly one rebase retry');

    const log = git(['log', '--oneline', 'main'], bare);
    ok(/auto-bump to v1\.0\.1/.test(log), 'the bump commit is on the remote');
    ok(/someone else got there first/.test(log), 'and the racing commit was NOT clobbered');
    ok(/\[skip ci\]/.test(git(['log', '-1', '--format=%s', 'main'], bare)),
        'the bump commit carries [skip ci], so it does not trigger another deploy');

    // Nothing to do must be a no-op, not an empty commit: a re-run of a deploy
    // whose bump already landed should not add a second commit.
    const c = scratch();
    git(['clone', '-q', bare, '.'], c);
    const noop = commitAndPush(c, '9.9.9', ['package.json']);
    ok(!noop.committed, 'an unchanged tree produces no commit');
} finally {
    for (const d of scratches) rmSync(d, { recursive: true, force: true });
}

console.log(`\n${fail ? '✗' : '✓'} bump-version: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
