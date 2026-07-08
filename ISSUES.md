# Arcade Platform Review — Issues

All GitHub issues opened from the eight-part platform/integration review
(2026-07-06). Each links to its full remediation plan on the
`arcade-review-plans` branch of `paulgibeault/paulgibeault.github.io`.

| # | Repo | Issue | Plan | Severity of headline |
| - | ---- | ----- | ---- | -------------------- |
| 1 | paulgibeault.github.io | [#17 — Arcade platform: security fixes + fleet-wide SDK/launcher enhancements](https://github.com/paulgibeault/paulgibeault.github.io/issues/17) | [framework-launcher.md](https://github.com/paulgibeault/paulgibeault.github.io/blob/arcade-review-plans/plans/framework-launcher.md) | HIGH |
| 2 | moon-lit | [#20 — Arcade integration: origin-wide SW/cache wipe (critical) + suspend containment + stats-delta](https://github.com/paulgibeault/moon-lit/issues/20) | [moon-lit.md](https://github.com/paulgibeault/paulgibeault.github.io/blob/arcade-review-plans/plans/moon-lit.md) | HIGH (critical) |
| 3 | p2p-chat | [#1 — Arcade integration: stored XSS via peer ids (critical) + interrupted-send cap + reduced-motion](https://github.com/paulgibeault/p2p-chat/issues/1) | [p2p-chat.md](https://github.com/paulgibeault/paulgibeault.github.io/blob/arcade-review-plans/plans/p2p-chat.md) | HIGH (critical) |
| 4 | pi-game | [#14 — Arcade integration: resume rAF freeze + accruing timer + offline SW assets](https://github.com/paulgibeault/pi-game/issues/14) | [pi-game.md](https://github.com/paulgibeault/paulgibeault.github.io/blob/arcade-review-plans/plans/pi-game.md) | HIGH |
| 5 | hecknsic | [#38 — Arcade integration: SW caches the SDK + orphaned .ls.* migration + canvas font-scale](https://github.com/paulgibeault/hecknsic/issues/38) | [hecknsic.md](https://github.com/paulgibeault/paulgibeault.github.io/blob/arcade-review-plans/plans/hecknsic.md) | HIGH |
| 6 | si-syn | [#17 — Arcade integration: pause cinematic timers when hidden + locked-level rehydrate](https://github.com/paulgibeault/si-syn/issues/17) | [si-syn.md](https://github.com/paulgibeault/paulgibeault.github.io/blob/arcade-review-plans/plans/si-syn.md) | MED |
| 7 | cozy-solitaire | [#7 — Arcade integration: idle clock freeze + standalone flush + cleanup](https://github.com/paulgibeault/cozy-solitaire/issues/7) | [cozy-solitaire.md](https://github.com/paulgibeault/paulgibeault.github.io/blob/arcade-review-plans/plans/cozy-solitaire.md) | MED |
| 8 | sowduku | [#1 — Arcade integration: SW caches the SDK + no suspend handling + non-square art](https://github.com/paulgibeault/sowduku/issues/1) | [sowduku.md](https://github.com/paulgibeault/paulgibeault.github.io/blob/arcade-review-plans/plans/sowduku.md) | HIGH |

Index of all plans: [plans/README.md](https://github.com/paulgibeault/paulgibeault.github.io/blob/arcade-review-plans/plans/README.md)

## Cross-repo dependencies
- **p2p-chat launcher entry** — finish the `profile.html` `#games` mirror vs. remove the TEMP button: framework [#17](https://github.com/paulgibeault/paulgibeault.github.io/issues/17) (A7) ↔ p2p-chat [#1](https://github.com/paulgibeault/p2p-chat/issues/1) (#7).
- **Retire the ls-proxy path** — blocked on hecknsic's `.ls.*` migration: hecknsic [#38](https://github.com/paulgibeault/hecknsic/issues/38) (#2) ↔ framework [#17](https://github.com/paulgibeault/paulgibeault.github.io/issues/17) (B11).

## Fleet priority (across all repos)
1. p2p-chat stored XSS — [p2p-chat#1](https://github.com/paulgibeault/p2p-chat/issues/1)
2. moon-lit origin-wide SW/cache nuke — [moon-lit#20](https://github.com/paulgibeault/moon-lit/issues/20)
3. Launcher inbound `postMessage` origin check — [#17](https://github.com/paulgibeault/paulgibeault.github.io/issues/17) A1
4. `__proto__` import-regex + `deepMerge` hardening — [#17](https://github.com/paulgibeault/paulgibeault.github.io/issues/17) A2
5. Known Peers `loadP2P` dead-code fix — [#17](https://github.com/paulgibeault/paulgibeault.github.io/issues/17) A3
6. SW SDK-caching in hecknsic + sowduku — [hecknsic#38](https://github.com/paulgibeault/hecknsic/issues/38), [sowduku#1](https://github.com/paulgibeault/sowduku/issues/1)
7. Rendezvous fingerprint-gated pair rebind — [#17](https://github.com/paulgibeault/paulgibeault.github.io/issues/17) A4
8. Remove TEMP p2p-chat button; square sowduku art — [#17](https://github.com/paulgibeault/paulgibeault.github.io/issues/17) A7, [sowduku#1](https://github.com/paulgibeault/sowduku/issues/1) #3
