# Arcade Platform — Remediation Plans

Generated from an eight-part review (2026-07-06) of the Paul's Arcade framework
(`arcade-sdk.js`, `arcade-p2p.js`, launcher `index.html`, `p2p/`) and every game
in the launcher catalog. Each plan below is the actionable checklist tracked by a
GitHub issue in the corresponding repository.

## Plans

| Repo | Plan | Theme |
| ---- | ---- | ----- |
| `paulgibeault/paulgibeault.github.io` | [framework-launcher.md](framework-launcher.md) | Security fixes + SDK/launcher enhancements the whole fleet needs |
| `paulgibeault/moon-lit` | [moon-lit.md](moon-lit.md) | Origin-wide SW/cache nuke (critical), suspend containment, stats-delta bug |
| `paulgibeault/p2p-chat` | [p2p-chat.md](p2p-chat.md) | Stored XSS via peer ids (critical), interrupted-send cap, reduced-motion |
| `paulgibeault/pi-game` | [pi-game.md](pi-game.md) | Resume rAF freeze, hand-rolled timer, offline SW asset list |
| `paulgibeault/hecknsic` | [hecknsic.md](hecknsic.md) | SW caches the SDK, orphaned `.ls.*` keys, canvas font-scale |
| `paulgibeault/si-syn` | [si-syn.md](si-syn.md) | Cinematic timers run while hidden, locked-level rehydrate |
| `paulgibeault/cozy-solitaire` | [cozy-solitaire.md](cozy-solitaire.md) | Idle clock freeze, standalone flush, dead code |
| `paulgibeault/sowduku` | [sowduku.md](sowduku.md) | SW caches the SDK, no suspend handling, non-square art, dir/slug |

## Two systemic themes (fix once in the framework)

**A. Service workers.** Three games break the platform three ways (moon-lit
nukes origin caches; hecknsic + sowduku cache the same-origin SDK). Root cause:
the "a SW controls every fetch the page makes, not just fetches under its path"
rule is undocumented as code. Framework fix in
[framework-launcher.md](framework-launcher.md) §B1 (reference `game-sw.js`,
copy-paste snippet in GAME_INTEGRATION.md §10, escalate `checkSWCollision`,
`acceptance.mjs` offline check).

**B. Lifecycle / suspend.** Five of seven games get suspend or resume subtly
wrong. Root causes are framework-shaped: standalone never fires suspend/resume;
`document.visibilityState` doesn't reflect iframe-pool hiding; no managed
rAF/timer helper. Framework fix in [framework-launcher.md](framework-launcher.md)
§B2–B4.

## Priority (across all repos)

1. p2p-chat stored XSS
2. moon-lit origin-wide SW/cache nuke
3. Launcher inbound `postMessage` origin check
4. `__proto__` import-regex + `deepMerge` hardening
5. Known Peers `loadP2P` scope bug (dead feature)
6. SW SDK-caching in hecknsic + sowduku
7. Rendezvous fingerprint-gated pair rebind
8. Remove TEMP p2p-chat launcher button; square sowduku art
