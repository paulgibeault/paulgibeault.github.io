# Framework issues

Open work on **this repo** — the SDK, the launcher, and the tooling. Each app in
the catalog tracks its own integration work in its own issue tracker; that is
where per-app remediation plans now live (`docs/arcade-remediation.md` in each
repo, moved out of `plans/` on 2026-07-28 so this repo stops carrying work
addressed to other maintainers).

| Issue | Theme | Severity |
| ----- | ----- | -------- |
| [#141 — three acceptance suites crash instead of reporting when a wait times out](https://github.com/paulgibeault/paulgibeault.github.io/issues/141) | CI diagnostics | MED |
| [#39 — SDK pattern-lift batch (tween/fx, canvas.autosize, SW template, guide, fmt, undo, …)](https://github.com/paulgibeault/paulgibeault.github.io/issues/39) | SDK ergonomics | LOW |

**#141 is why a red run in the acceptance tier is often unreadable.** Three
suites wrap their body in `try { … } finally { … }` with no `catch`, so a
Playwright `TimeoutError` kills the process before their own `check()`
reporting runs — the output is a line number and a stack from `node:internal`,
with no check name and no page state. `tools/records-acceptance.mjs:174`
already carries the one-line fix. Fix the reporting before reaching for a
bigger timeout: a hit ceiling is meant to send someone to a debugger, and
today it hands them nothing to debug.

**Runner weather has a documented workaround now, not an open issue.**
#137 spent real effort chasing a *mechanism* for the acceptance tier's
timing-sensitive failures — a correlation with the launcher's (now-retired)
starfield re-arm block, six failures carrying it against five passes without,
Fisher's exact ≈ 0.002. Landing #139 falsified the necessary-condition version
of that: the same failure, same opening assertion, reproduced 3/3 on a branch
touching no `index.html` and no launcher runtime at all, on a tree
byte-identical to one that had just passed and which passed again on a plain
rerun. Same bytes, three outcomes, fifteen minutes — which points at ordinary
CPU-contention flakiness on shared runners, not a mechanism this repo's code
controls. `run-ci.mjs`'s three retries run back-to-back inside one job and
mostly sample the same bad window, so "3/3 failed" was never as strong a
signal as it read.

Closed rather than left open indefinitely chasing a cause that may not exist to
find: **the workaround — confirm same commit, rerun the job, escalate only if
the rerun is also red — is now documented in [TESTING.md](TESTING.md), "Runner
weather"**, which is where anyone hitting this belongs, whether or not the
mechanism is ever pinned down. If a *new* correlation surfaces with the same
reproducibility #137 had (a real hypothesis, not "it failed again"), it gets a
fresh issue with that evidence, rather than reopening a thread whose original
hypothesis a later counterexample already falsified.

(Closed since the last revision of this table: #114, #128, #129 — the
power-saver contract follow-up, landed as one stack. #129 retired the
launcher's last seven infinite animations, so it meets the §6d bar it asks
games to meet, with no exemptions. #128 turned §5/§6d into
`tools/contract-gates.mjs`, which `fleet-ci.yml` runs **enforcing** against
every caller, replacing three drifting per-repo copies. #114 shipped
`tools/render-smoke.mjs` **warn-only**; all nine apps pass it with the default
declaration, so no app ships a `tools/smoke.mjs` yet. The flip to enforcing is
dropping `--warn` from the smoke step and `continue-on-error` from the `smoke`
job in `fleet-ci.yml`, and wants a track record first.

#139 reworked the pipeline itself. `test` still gates `deploy`, but the render
smoke moved to its **own job running in parallel** — advisory work had been
sitting in the deploy's critical path, because `deploy` needs the whole `test`
job — and npm/Playwright caching landed (browser installs 46s → 24s warm). The
last logic left in the workflow YAML moved into three launcher-owned scripts
with unit suites: `tools/stage-dispatch.mjs` (one build-or-stage implementation,
called by both the deploy and smoke jobs, replacing two mirrored shell blocks),
`tools/bump-version.mjs` (fixing a global `sed` that rewrote every
version-shaped string in an `index.html`, and a `git push` with no rebase
retry), and `tools/verify-origin.mjs` — a new **enforcing** post-deploy check
that asks the live origin whether it serves the version just published. Callers
now cancel in-progress runs for pull requests only. Note `toolchain_ref`: the
`.launcher-gates` checkout defaults to this repo's default branch, so pinning a
caller to a ref pins only the YAML unless that input is passed too — there is
no context variable exposing a reusable workflow's own revision
(`job_workflow_sha` and `job_workflow_ref` are both empty inside one).

Earlier: #17, #106, #107, #108, #113,
#120 — the security batch, the t=0 root-cause + fleet re-audition, the WP2
graph packs, the spec-cue seam, the acceptance-tier coverage gap, and the docs
finalization all landed.
The t=0 cause was Chromium's DynamicsCompressorNode warm-up, the renderer's
0.25 s section lead-in is the complete offline fix, documented on `createBus`
in `arcade-audio.js`. #113 closed by deriving retry policy from the harness
import rather than a hand-kept list, which switched all five suites on. #108
closed without an SDK v4 cut: nothing queued needs a major, and what the work
package was really holding — the cache-turnover criterion — is now the standing
expand/migrate/contract playbook in GAME_INTEGRATION.md §2.)

Historical context for all of the above: the eight-part platform review of
2026-07-06, indexed in [plans/README.md](plans/README.md).

## Seams — framework work blocked on an app, or vice versa

These are the only cross-repo entries that belong here, because the *framework
side* is what is blocked. Each names the condition, not a schedule: under the
closed-fleet policy the framework side is deleted as soon as the app side merges
and its acceptance passes, with no deprecation window.

*(No open seams.)*

The last entry here — "retire the spec-cue (chiptune) audio engine" — is gone
rather than updated, because the condition it was waiting on stopped existing.
It tracked framework code (`Arcade.audio.cue()` and the spec form of `play()`)
blocked on apps migrating off it. Two things ended that: the fallback paths
that were the last incidental consumers were deleted fleet-wide, and one app
adopted the chiptune voice as its deliberate sound identity rather than as
degraded mode. So the spec-cue engine has a real, permanent consumer and is not
pending removal — there is nothing blocked, which is the only thing this
section tracks.

What remained of the work package was the pinning posture (decided: evergreen,
§2) and the cache-turnover criterion, which is not a seam either — it is the
standing playbook for cutting any major, now written down in
GAME_INTEGRATION.md §2 rather than held open as a pending decision.

## Standing policy

No deprecated-but-supported code. The catalog apps are the entire dependency on
this framework — there is no unknown consumer to keep a legacy path alive for,
so a superseded path is deleted the week its last consumer migrates. The only
compatibility that gets a window at all is **player data at rest**, and that
window is one active-migration release, scoped in `sdk/CHANGELOG.md` with its
deletion already planned. See
[plans/decouple-game-names-2026-07.md](plans/decouple-game-names-2026-07.md).
