# Plan — Framework & Launcher (`paulgibeault/paulgibeault.github.io`) — ✅ mostly shipped

Source: platform/security review of `arcade-sdk.js`, `arcade-p2p.js`, launcher `index.html`,
`sw.js`, `p2p/`. **Part A (security & correctness) is 9/9 shipped; Part B is 11/13 shipped.**
Landed via PR #18 (`5c43bb7`, "security fixes + fleet-wide SDK/launcher enhancements") and
follow-ons. Verified in code 2026-07-10.

> The P2P *protocol* security checklist (issue #21) and all fleet-wide infrastructure are a
> **separate, still-open** effort — see **`fleet-hardening-plan.md`**, the active tracker.

## ✅ Part A — Security & correctness (all shipped)
| # | Item | Where it landed |
| - | ---- | --------------- |
| A1 | Inbound `postMessage` origin check (`e.origin !== entry.origin`) | `index.html:1157` |
| A2 | `__proto__`/`constructor`/`prototype` rejected in key validator + hardened `deepMerge` | `index.html:706-710`, `arcade-sdk.js:235-252` |
| A3 | `loadP2P` exposed on `window.__arcade`; Known Peers toggle works | `index.html:1002,1697-1750` |
| A4 | Fingerprint-gated pair rebind + `DEVICE_ID_RE` format check | `arcade-p2p.js:216,429` |
| A5 | Launcher SW scope-filtered; `sowduku.png` added to `ASSETS` | `sw.js:29,67-73` |
| A6 | `#p2p-offer` shows a consent prompt before `createAnswer` | `p2p-ui.js:214-224` |
| A7 | TEMP p2p-chat catalog entry removed | `index.html` (no entry) |
| A8 | Broker-trust doc gets an honest metadata-leakage sentence | `ARCADE_PLATFORM.md:215` |
| A9 | CDN URLs point at `./vendor/`; version label `v1.9` from a constant | `p2p-addon.js:55-56`, `p2p-ui.js:6,479` |

## ✅ Part B — Framework enhancements (11/13 shipped)
B1 SW hygiene toolkit (`tools/templates/game-sw.js`, escalated `checkSWCollision`, GAME_INTEGRATION §10) ·
B2 standalone suspend/resume (`installPageLifecycle`) · B3 `context.suspended` + `data-arcade-suspended` ·
B4 `Arcade.loop` + `session.setTimeout/setInterval` · B5 scores `order:'asc'` + `best(cat,key)` ·
B6 `peer.self/remote/onReady` + real `fromPeer` · B7 `sendBlob/onBlob` + queue depth ·
B8 `data-reduced-motion` hook + kill-switch rule · B9 `state.adopt` + doc note ·
B10 `dev.sh` gameId detection · B12 save-export governance (`{exportable:false}`, merge-copy fix, `matchMedia`).

---

## Remaining work (2 items)

### B11 — Retire the ls-proxy legacy path — NOW UNBLOCKED
- `handleLsProxyRequest` + the `ls-proxy-request` branch (`index.html:1100,1164`) are still present.
- **hecknsic's `.ls.*` data-recovery migration has now shipped** (hecknsic PR #39), which was the
  prerequisite. **Wait one release** after hecknsic deploys, then delete `handleLsProxyRequest`,
  the `ls-proxy-request` branch, and the back-compat notes in GAME_INTEGRATION.md §9. Tracked as
  launcher issue [#10](https://github.com/paulgibeault/paulgibeault.github.io/issues/10).

### B13 — De-god the `platformController` — PARTIAL
- Done: `window.__arcade` is now an explicitly-constructed object (`index.html:463`); `knownPeers`
  has its own `arcade-known-peers.js` owner.
- **Not done:** the ~680-line IIFE (`index.html:697`) still inlines save/load
  (`isSafeArcadeKey`/`buildBundle`/`exportSave`/`importSaveFile`) and p2p wiring
  (`loadP2P`/`askAutoReconnect`/`tryResumeOnLaunch`). Extract these into `arcade-save.js` and
  `arcade-p2p-wiring.js` (following the `arcade-p2p.js` module pattern). **Also tracked in
  `fleet-hardening-plan.md` Part B** — do it there; sequence after the Part A security phases.

**Recommendation:** B11 is a small, safe deletion — schedule it one release after hecknsic ships.
B13 is a no-behavior-change refactor; low urgency, gate it behind `npm run acceptance`.
