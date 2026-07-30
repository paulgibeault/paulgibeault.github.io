# Framework issues

Open work on **this repo** — the SDK, the launcher, and the tooling. Each app in
the catalog tracks its own integration work in its own issue tracker; that is
where per-app remediation plans now live (`docs/arcade-remediation.md` in each
repo, moved out of `plans/` on 2026-07-28 so this repo stops carrying work
addressed to other maintainers).

| Issue | Theme | Severity |
| ----- | ----- | -------- |
| [#108 — WP3: spec-cue scheduler retirement path (cache turnover, SDK v4)](https://github.com/paulgibeault/paulgibeault.github.io/issues/108) | SDK lifecycle | MED |
| [#113 — Five acceptance suites have never run in CI](https://github.com/paulgibeault/paulgibeault.github.io/issues/113) | CI coverage | HIGH |
| [#114 — Nothing in CI asserts a game actually renders — a blank game ships green](https://github.com/paulgibeault/paulgibeault.github.io/issues/114) | CI coverage | MED |
| [#120 — Docs finalization: GAME_INTEGRATION.md audit](https://github.com/paulgibeault/paulgibeault.github.io/issues/120) | Documentation | MED |
| [#39 — SDK pattern-lift batch (tween/fx, canvas.autosize, SW template, guide, fmt, undo, …)](https://github.com/paulgibeault/paulgibeault.github.io/issues/39) | SDK ergonomics | LOW |

(Closed since the last revision of this table: #17, #106, #107 — the security
batch, the t=0 root-cause + fleet re-audition, and the WP2 graph packs all
landed; the t=0 cause was Chromium's DynamicsCompressorNode warm-up, the
renderer's 0.25 s section lead-in is the complete offline fix, documented on
`createBus` in `arcade-audio.js`.)

Historical context for all of the above: the eight-part platform review of
2026-07-06, indexed in [plans/README.md](plans/README.md).

## Seams — framework work blocked on an app, or vice versa

These are the only cross-repo entries that belong here, because the *framework
side* is what is blocked. Each names the condition, not a schedule: under the
closed-fleet policy the framework side is deleted as soon as the app side merges
and its acceptance passes, with no deprecation window.

- **Retire the spec-cue (chiptune) audio engine.** `Arcade.audio.cue()` and the
  spec form of `play()` are superseded by graph cues sharing one convolution
  room. **All seven catalog apps now ship a graph pack** — the last three
  landed 2026-07-28, joining the four approved earlier (the per-app rollout is
  recorded in [#107](https://github.com/paulgibeault/paulgibeault.github.io/issues/107)).
  What still holds this open
  is the other half of the condition: every one of the seven also registers
  spec cues on its **fallback path**, for a player on a service-worker cache
  stale enough to be missing `/arcade-audio.js`. Those paths are the last
  consumer of the spec-voice scheduler and they go when it does. When the
  fleet's caches have turned over far enough to drop them, cut SDK v4 without
  the spec-voice scheduler, move the fleet to it, and delete `sdk/v3/`.
  **Pinning posture (decided 2026-07-30, #120/#108 item 1): the fleet loads
  the EVERGREEN aliases** (`/arcade-sdk.js` + `/arcade-audio.js`) — all seven
  apps; the one previously major-pinned app migrated off `/sdk/v3/` to match.
  The closed fleet moves together at each major cut rather than pinning per
  app; compatibility
  inside a major stays runtime-negotiated by `welcome.caps`. Consequence for
  the v4 cut above: the cut is sequenced WITH the fleet migration (evergreen
  followers move the moment v4 ships), so the spec-cue fallback deletion and
  the v4 deploy land as one coordinated change, gated on the cache-turnover
  criterion.
  Work package: [#108](https://github.com/paulgibeault/paulgibeault.github.io/issues/108).
  Plan: [plans/decouple-game-names-2026-07.md](plans/decouple-game-names-2026-07.md) §3a.

## Standing policy

No deprecated-but-supported code. The catalog apps are the entire dependency on
this framework — there is no unknown consumer to keep a legacy path alive for,
so a superseded path is deleted the week its last consumer migrates. The only
compatibility that gets a window at all is **player data at rest**, and that
window is one active-migration release, scoped in `sdk/CHANGELOG.md` with its
deletion already planned. See
[plans/decouple-game-names-2026-07.md](plans/decouple-game-names-2026-07.md).
