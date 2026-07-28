# Framework issues

Open work on **this repo** — the SDK, the launcher, and the tooling. Each app in
the catalog tracks its own integration work in its own issue tracker; that is
where per-app remediation plans now live (`docs/arcade-remediation.md` in each
repo, moved out of `plans/` on 2026-07-28 so this repo stops carrying work
addressed to other maintainers).

| Issue | Theme | Severity |
| ----- | ----- | -------- |
| [#17 — Arcade platform: security fixes + fleet-wide SDK/launcher enhancements](https://github.com/paulgibeault/paulgibeault.github.io/issues/17) | Security hardening, lifecycle, SW hygiene | HIGH |
| [#106 — WP1: re-audition the four pre-fix sound packs; root-cause the renderer's t=0 attenuation](https://github.com/paulgibeault/paulgibeault.github.io/issues/106) | Soundpack tooling, fleet re-approval | HIGH |
| [#107 — WP2: land the v1 graph packs for the three remaining apps](https://github.com/paulgibeault/paulgibeault.github.io/issues/107) | Sound design, per-app wiring (uncommitted) | MED |
| [#108 — WP3: spec-cue scheduler retirement path (pinning, cache turnover, SDK v4)](https://github.com/paulgibeault/paulgibeault.github.io/issues/108) | SDK lifecycle | MED |

Historical context for all of the above: the eight-part platform review of
2026-07-06, indexed in [plans/README.md](plans/README.md).

## Seams — framework work blocked on an app, or vice versa

These are the only cross-repo entries that belong here, because the *framework
side* is what is blocked. Each names the condition, not a schedule: under the
closed-fleet policy the framework side is deleted as soon as the app side merges
and its acceptance passes, with no deprecation window.

- **Retire the `ls-proxy` path.** The launcher answers a pre-SDK
  postMessage-`localStorage` protocol so that a game shipping its own storage
  shim does not hang on init. One app still speaks it. When that app's `.ls.*`
  → `Arcade.state` migration merges, delete the handler from
  `arcade-storage-bridge.js`, `arcade-storage-core.js` and `index.html`, plus
  the protocol note in `ARCADE_PLATFORM.md`.
  Framework side: [#17](https://github.com/paulgibeault/paulgibeault.github.io/issues/17) (B11).

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
  Work package: [#108](https://github.com/paulgibeault/paulgibeault.github.io/issues/108).
  Plan: [plans/decouple-game-names-2026-07.md](plans/decouple-game-names-2026-07.md) §3a.

- **Root-cause the audition renderer's t=0 attenuation.** A gesture scheduled
  at exactly `t=0` in an `OfflineAudioContext` renders about 10 dB down, and
  with a different spectrum, from the identical gesture anywhere else — one
  `body` measured −28.6 dBFS at 0 and −18.4 dBFS at every other offset tested,
  including 500 ms. Same family as the render-quantum problem `primed()`
  handles in `arcade-audio.js`. It applied to the FIRST ITEM OF EVERY SECTION
  of every audition ever rendered, so every ear pass in the fleet judged that
  item at roughly half its true level; the four packs approved before
  2026-07-28 were signed off under it. Shipped audio was never affected —
  at runtime cues schedule against `audioCtx.currentTime`, which is never 0.
  `tools/soundpack/render.mjs` now starts each section at a 0.25 s lead-in,
  which is a mitigation and not a fix: the behaviour still bites any cue that
  schedules a layer at its own `when + 0`.
  Work package (including the fleet re-audition): [#106](https://github.com/paulgibeault/paulgibeault.github.io/issues/106).

## Standing policy

No deprecated-but-supported code. The catalog apps are the entire dependency on
this framework — there is no unknown consumer to keep a legacy path alive for,
so a superseded path is deleted the week its last consumer migrates. The only
compatibility that gets a window at all is **player data at rest**, and that
window is one active-migration release, scoped in `sdk/CHANGELOG.md` with its
deletion already planned. See
[plans/decouple-game-names-2026-07.md](plans/decouple-game-names-2026-07.md).
