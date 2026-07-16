# Arcade Platform — Remediation Plans

Generated from an eight-part review (2026-07-06) of the Paul's Arcade framework
(`arcade-sdk.js`, `arcade-p2p.js`, launcher `index.html`, `p2p/`) and every game
in the launcher catalog. Each plan below is the actionable checklist tracked by a
GitHub issue in the corresponding repository.

## Plans

| Repo | Plan | Issue | Theme |
| ---- | ---- | ----- | ----- |
| `paulgibeault/paulgibeault.github.io` | [framework-launcher.md](framework-launcher.md) | [#17](https://github.com/paulgibeault/paulgibeault.github.io/issues/17) | Security fixes + SDK/launcher enhancements the whole fleet needs |
| `paulgibeault/moon-lit` | [moon-lit.md](moon-lit.md) | [#20](https://github.com/paulgibeault/moon-lit/issues/20) | Origin-wide SW/cache nuke (critical), suspend containment, stats-delta bug |
| `paulgibeault/p2p-chat` | [p2p-chat.md](p2p-chat.md) | [#1](https://github.com/paulgibeault/p2p-chat/issues/1) | Stored XSS via peer ids (critical), interrupted-send cap, reduced-motion |
| `paulgibeault/pi-game` | [pi-game.md](pi-game.md) | [#14](https://github.com/paulgibeault/pi-game/issues/14) | Resume rAF freeze, hand-rolled timer, offline SW asset list |
| `paulgibeault/hecknsic` | [hecknsic.md](hecknsic.md) | [#38](https://github.com/paulgibeault/hecknsic/issues/38) | SW caches the SDK, orphaned `.ls.*` keys, canvas font-scale |
| `paulgibeault/si-syn` | [si-syn.md](si-syn.md) | [#17](https://github.com/paulgibeault/si-syn/issues/17) | Cinematic timers run while hidden, locked-level rehydrate |
| `paulgibeault/cozy-solitaire` | [cozy-solitaire.md](cozy-solitaire.md) | [#7](https://github.com/paulgibeault/cozy-solitaire/issues/7) | Idle clock freeze, standalone flush, dead code |
| `paulgibeault/sowduku` | [sowduku.md](sowduku.md) | [#1](https://github.com/paulgibeault/sowduku/issues/1) | SW caches the SDK, no suspend handling, non-square art, dir/slug |

## Two systemic themes (fix once in the framework) — ✅ both framework fixes shipped

> Both root-cause framework fixes below (§B1 SW hygiene, §B2–B4 lifecycle) are **now shipped in
> the SDK/launcher** and every game consumes them. Retained here for context.

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

> **Forward-looking:** [`framework-evolution.md`](framework-evolution.md) — evaluation of the
> framework as a *sovereign local-first application platform* (the "why" + full gap analysis).
> [`implementation-roadmap.md`](implementation-roadmap.md) — the **active build plan**: batch-1
> framework work (quick-wins + security + `Arcade.store`/`files`), then app refactors; everything
> deferred is filed as detailed issues **#28–#43**. `fleet-hardening-plan.md` remains the
> security/bug tracker.

## Status — 2026-07-10 (code-verified)

**Done.** All 8 items in the original priority list below are shipped and merged, along with
every per-game review PR (`arcade-review-fixes`, 2026-07-10) and framework-launcher Part A (9/9)
and most of Part B (11/13). See each plan for the merged-commit evidence.

<details><summary>Original priority list (all ✅ done)</summary>

1. ✅ p2p-chat stored XSS — `sanitizeId()` (p2p-chat #2)
2. ✅ moon-lit origin-wide SW/cache nuke — loopback-gated (moon-lit #21)
3. ✅ Launcher inbound `postMessage` origin check (framework A1)
4. ✅ `__proto__` import-regex + `deepMerge` hardening (framework A2)
5. ✅ Known Peers `loadP2P` scope bug (framework A3)
6. ✅ SW SDK-caching in hecknsic + sowduku (hecknsic #39, sowduku #2)
7. ✅ Rendezvous fingerprint-gated pair rebind (framework A4)
8. ✅ TEMP p2p-chat launcher button removed; ⏳ square sowduku art still open (launcher #26)

</details>

## Remaining work — see `fleet-hardening-plan.md` for detail

Everything in the original priority list has landed except the B13 refactor:

1. ✅ sowduku stored XSS + migration sentinel (Part C1) — fixed, merged (sowduku#4).
2. ✅ Framework P2P security checklist #21 (Part A, phases A1–A5) — closed, remediated in #54/#57
   plus the #59–#61 hygiene batch.
3. ✅ CI test gate (Part D1) — shipped.
4. ✅ Envelope validator, mqtt-codec test, B11 ls-proxy retirement — shipped (#59, #61). **B13
   refactor (de-god `platformController`) is still partial** — see `framework-launcher.md` B13.
5. ✅ Docs & issue hygiene (Part E) — the 7 paired integration issues are all closed.
6. Low-priority per-game cleanups (toasts/stats/enhancements) — tracked in each game's issue.
