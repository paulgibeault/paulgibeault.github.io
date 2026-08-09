# Framework issues

Open work on **this repo** — the SDK, the launcher, and the tooling. Each app in
the catalog tracks its own integration work in its own issue tracker; that is
where per-app remediation plans now live (`docs/arcade-remediation.md` in each
repo, moved out of `plans/` on 2026-07-28 so this repo stops carrying work
addressed to other maintainers).

| Issue | Theme | Severity |
| ----- | ----- | -------- |
| [#137 — sync-acceptance fails on CI runners when the launcher's starfield re-arms its ambience window](https://github.com/paulgibeault/paulgibeault.github.io/issues/137) | CI reliability | MED |
| [#39 — SDK pattern-lift batch (tween/fx, canvas.autosize, SW template, guide, fmt, undo, …)](https://github.com/paulgibeault/paulgibeault.github.io/issues/39) | SDK ergonomics | LOW |

**#137 is the one to read before trusting a red `sync-acceptance`.** A
correlation with no mechanism: six CI runs carrying the launcher's starfield
re-arm block failed and five without it passed, always opening on the same 20s
convergence wait, while boot time, star count and running-animation count are
identical either way. The block is not shipped, so `main` is unaffected. Two
things on it outlive the starfield — that suite fails on *unmodified* `main`
under CPU contention, and its failures point nowhere near their cause, because
`tools/lib/p2p-test-harness.mjs` boots every device context on the real
launcher page.

(Closed since the last revision of this table: #114, #128, #129 — the
power-saver contract follow-up, landed as one stack. #129 retired the
launcher's last seven infinite animations, so it meets the §6d bar it asks
games to meet, with no exemptions. #128 turned §5/§6d into
`tools/contract-gates.mjs`, which `fleet-ci.yml` runs **enforcing** against
every caller, replacing three drifting per-repo copies. #114 shipped
`tools/render-smoke.mjs` **warn-only**; all nine apps pass it with the default
declaration, so no app ships a `tools/smoke.mjs` yet. The flip to enforcing is
dropping `--warn` and `continue-on-error` from one step in `fleet-ci.yml`, and
wants a track record first.

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
