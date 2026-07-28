# Framework issues

Open work on **this repo** — the SDK, the launcher, and the tooling. Each app in
the catalog tracks its own integration work in its own issue tracker; that is
where per-app remediation plans now live (`docs/arcade-remediation.md` in each
repo, moved out of `plans/` on 2026-07-28 so this repo stops carrying work
addressed to other maintainers).

| Issue | Theme | Severity |
| ----- | ----- | -------- |
| [#17 — Arcade platform: security fixes + fleet-wide SDK/launcher enhancements](https://github.com/paulgibeault/paulgibeault.github.io/issues/17) | Security hardening, lifecycle, SW hygiene | HIGH |

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
  room. Three apps still register spec cues and need graph packs designed and
  ear-approved first; four have packs, and any in-app chiptune fallback path
  goes with them. When no app registers a spec cue, cut SDK v4 without the
  spec-voice scheduler, move the fleet to it, and delete `sdk/v3/`.
  Plan: [plans/decouple-game-names-2026-07.md](plans/decouple-game-names-2026-07.md) §3a.

## Standing policy

No deprecated-but-supported code. The catalog apps are the entire dependency on
this framework — there is no unknown consumer to keep a legacy path alive for,
so a superseded path is deleted the week its last consumer migrates. The only
compatibility that gets a window at all is **player data at rest**, and that
window is one active-migration release, scoped in `sdk/CHANGELOG.md` with its
deletion already planned. See
[plans/decouple-game-names-2026-07.md](plans/decouple-game-names-2026-07.md).
