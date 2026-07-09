# Plan — Framework & Launcher (`paulgibeault/paulgibeault.github.io`)

Source: platform/security review of `arcade-sdk.js`, `arcade-p2p.js`, launcher
`index.html`, `sw.js`, and `p2p/`. Findings are grouped into **Part A —
security & correctness** (ship before next release) and **Part B — framework
enhancements** (each fixes a bug that recurs across multiple games).

Line numbers are from the reviewed tree; re-confirm before editing.

---

## Part A — Security & correctness (before next release)

### A1. Inbound `postMessage` has no origin check — HIGH
- **Where:** `index.html:1151-1156` (message handler gates only on `e.source`).
- **Problem:** Both docs promise an origin allowlist (ARCADE_PLATFORM.md:288,
  GAME_INTEGRATION.md:470) but the handler deliberately skips it "for local dev".
  The sandbox does not stop an iframe from navigating *itself* cross-origin (a
  stray `<a href>` suffices); afterward `e.source` still matches the pool entry,
  so an arbitrary origin can drive `ls-proxy` read/write (replies posted to
  `e.origin`), `arcade:peer.send`, and toasts.
- **Fix:** Each pool entry already captures its origin at mount
  (`index.html:899-902`). Add `if (e.origin !== entry.origin) return;`. For the
  dev harness, allow `location.origin` (same-origin staging already matches).
- **Accept:** cross-origin message from a mounted-but-navigated frame is ignored;
  same-origin games unaffected; `npm run acceptance` still green.

### A2. `__proto__` passes the import allowlist and reaches `deepMerge` — HIGH
- **Where:** `KEY_RE` at `index.html:807`; SDK `deepMerge` at
  `arcade-sdk.js:141-150` (reached via `state.getOrInit`/`stats.getOrInit`).
- **Problem:** `KEY_RE` matches `arcade.v1.__proto__.x` and
  `arcade.v1.global.__proto__`, contradicting ARCADE_PLATFORM.md:289. Keys are
  inert in localStorage, but imported *values* are attacker JSON: `JSON.parse`
  makes `__proto__` an own-enumerable key, `for (k in override)` iterates it, and
  `out[k] = ov` fires the prototype setter — inherited-property injection on the
  merged game-state object.
- **Fix (two layers):**
  1. Reject `__proto__`/`constructor`/`prototype` path segments in `KEY_RE`
     (launcher import).
  2. Harden `deepMerge`: iterate `Object.keys(override)`, `continue` on
     `k === '__proto__' || k === 'constructor' || k === 'prototype'`, and/or
     build `out` with `Object.create(null)`.
- **Accept:** an import file with a `__proto__` segment is dropped with a warning;
  a stored value containing `{"__proto__": {...}}` does not alter the merged
  object's prototype. Add a unit/acceptance probe.

### A3. Known Peers auto-reconnect toggle is dead code (ReferenceError) — HIGH (completeness)
- **Where:** `index.html:664` (knownPeersController IIFE) calls `loadP2P()`,
  declared in the *separate* platformController IIFE at `index.html:957`.
- **Problem:** 🔁/🚫 throws `ReferenceError: loadP2P is not defined`; the toggle
  documented at ARCADE_PLATFORM.md:193 silently does nothing.
- **Fix:** Expose `loadP2P` on the shared object (e.g. `window.__arcade.loadP2P`,
  matching `openMultiplayerPanel` at `index.html:1045`) and call that from the
  Known Peers panel.
- **Accept:** toggling auto-reconnect from the panel enables/disables pairing with
  no console error.

### A4. Rendezvous pair secret rebinds on a remote-claimed `deviceId` — MED
- **Where:** `arcade-p2p.js:296-307`; `recordPeerIdentity` at
  `arcade-p2p.js:171-193` (validates only `typeof === 'string'`).
- **Problem:** `deviceId` is peer-chosen. A peer you ceremony with once can claim
  another device's id and capture that pair's auto-reconnect slot; the
  `fingerprintChanged` signal only raises a toast (`index.html:983-985`) and never
  gates the rebind.
- **Fix:** In the identity handler, refuse `rdv.enablePair(...)` when the direct
  link's fingerprint mismatches the stored `knownPeers[deviceId].fingerprint`
  (or require explicit user confirmation). Validate deviceId format (UUID-ish
  pattern, bounded length) in `recordPeerIdentity`.
- **Accept:** a mismatched-fingerprint identity does not silently rebind the pair
  secret; malformed deviceIds are rejected.

### A5. Launcher SW intercepts game URLs — MED (completeness/claim-drift)
- **Where:** `sw.js:56-60` calls `respondWith(...)` for every root-scope fetch,
  no path filter. GAME_INTEGRATION.md:365 says it doesn't intercept game URLs.
- **Problem:** For games without their own SW, offline requests resolve
  `caches.match → undefined`, producing an opaque TypeError instead of a normal
  network error. Cache *contents* are correctly launcher-scoped, so this is
  claim-drift, not poisoning.
- **Fix:** Early-return unless the request path is in the launcher's own asset set
  (root-level launcher files, `p2p/`, `images/`). Add `images/sowduku.png` and
  `images/p2p-chat.png` to `ASSETS` (currently missing though on the grid).
- **Accept:** requests for `/<gameId>/…` fall through to network; launcher assets
  still served from cache offline.

### A6. `#p2p-offer=` fragment auto-answers with no consent — LOW-MED (privacy)
- **Where:** `p2p-ui.js:170-243` (runs `createAnswer` on load), broadcast at
  `p2p-ui.js:249-276`.
- **Problem:** Opening a crafted offer link immediately starts ICE/STUN toward the
  link author's endpoints and auto-broadcasts the answer — enough to reveal the
  victim's public IP. Undocumented.
- **Fix:** One confirmation tap ("Accept this invite?") before `createAnswer`.
- **Accept:** landing on an offer link shows a prompt; no ICE/answer until the user
  accepts.

### A7. Remove committed TEMP catalog entry — LOW
- **Where:** `index.html:386-393` — p2p-chat button annotated "TEMP local-dev only
  — remove before pushing".
- **Problem:** 404s in prod and inflates `gameCount`, loosening the pool-cap clamp
  (`index.html:522`). NOTE: p2p-chat also needs the `#games` mirror in
  `profile.html` — coordinate with the p2p-chat plan; if p2p-chat is a real
  release, finish the catalog entry instead of removing it.
- **Fix:** Either remove the button+card or promote to a real release (image,
  profile.html `#games` mirror per §11).
- **Accept:** no dead launcher button in prod; `gameCount` reflects shipped games.

### A8. Broker-trust doc line is overstated — LOW (docs)
- **Where:** ARCADE_PLATFORM.md:194 ("the broker can only delay or drop").
- **Problem:** Crypto holds (AEAD w/ direction+epoch AAD, HKDF from sorted
  randoms, exchange-gated ratchet, non-extractable keys) — but any wildcard
  subscriber on `qrp2p/r/v1/#` learns both IPs, that the pair rendezvous, and
  timing. Garbage blobs also cost the listener up to 3 AES-GCM attempts
  (`rendezvous.js:424-428`), a DoS-only nuisance.
- **Fix:** One honest sentence about metadata leakage in the doc; optionally
  rate-limit blob processing.

### A9. Latent CDN URLs + stale UI version label — LOW (defense-in-depth)
- **Where:** `p2p-addon.js:52-53` (cdnjs URLs, only avoided via load order in
  `arcade-p2p.js:258-259`); `p2p-ui.js:461` hardcodes "v1.6.1" while docs describe
  transport v1.9 (and the UI tells users to compare that header across devices).
- **Fix:** Point the addon at `./vendor/`; update the modal version label (or read
  it from a single constant).

---

## Part B — Framework enhancements (each fixes a fleet-wide recurrence)

### B1. Service-worker hygiene toolkit — from moon-lit / hecknsic / sowduku
- Ship a reference `game-sw.js` template: scope-filtered fetch handler
  (`if (!url.pathname.startsWith(SCOPE)) return;`) + version-keyed cache.
- Add the copy-paste fetch-guard snippet to GAME_INTEGRATION.md §10 (currently
  says "never cache" with no code).
- Escalate the SDK's `checkSWCollision` (`arcade-sdk.js:380-394`) from
  `console.warn` to a visible dev-mode error, and probe whether *any* launcher-root
  asset was served by a game SW (not just the SDK's own script entry).
- Add an offline-reload check to `tools/acceptance.mjs` (§13 currently only tests
  that the SW doesn't cache launcher assets, not that games cache their own).
- Document the origin-wide-cleanup foot-gun: "never call `caches.delete` /
  `getRegistrations().unregister` outside your own scope" (moon-lit shipped exactly
  this).

### B2. Standalone suspend/resume — from cozy-solitaire / sowduku
- **Problem:** the SDK fires `onSuspend`/`onResume` only when framed, so every game
  that (correctly) moved flush/pause logic into `onSuspend` silently regresses
  standalone, and `session.start({persistKey})` never persists standalone.
- **Fix:** when `!framed`, the SDK listens to `visibilitychange`/`pagehide` and
  fires the same `listeners.suspend`/`listeners.resume` arrays. Zero game changes;
  fixes cozy, sowduku, and every future game at once.

### B3. Expose suspend state to games/CSS — from sowduku
- **Problem:** `document.visibilityState` stays `"visible"` for a hidden iframe, so
  polling-style time trackers keep accruing (sowduku's `playMs` inflates).
- **Fix:** SDK sets `Arcade.context.suspended` (readable getter) and toggles
  `data-arcade-suspended` on `<html>` so code mounted mid-session (and CSS) can
  read current state without having subscribed from t=0.

### B4. Managed rAF loop + suspend-aware scheduling — from pi-game / si-syn / cozy / hecknsic
- **Problem:** every canvas game re-implements "cancel rAF on suspend, re-request
  on resume" and someone always gets it wrong (pi-game freezes on resume;
  si-syn's cinematics keep ticking hidden; cozy's clock freezes; hecknsic spins
  rAF while paused).
- **Fix:**
  - `Arcade.loop(fn)` → `{ start(), stop(), kick() }` that auto-cancels on suspend,
    auto-resumes only if it was running, and feeds a suspended-time-excised delta.
  - `Arcade.session.setTimeout(fn, ms)` / `.setInterval(fn, ms)` (or `t.onTick(fn,
    intervalMs)`) that auto-freeze on suspend, resume with remaining time, and
    cancel on `stateReplaced`.

### B5. `Arcade.scores` sort order + keyed bests — from cozy / sowduku / si-syn
- **Problem:** `scores.add` sorts descending only (`arcade-sdk.js:635`), locking out
  time-based "lower is better" games; sowduku wants best-per-board-code, not top-N.
- **Fix:** `scores.add(cat, entry, { order: 'asc' })` (or `scores.configure(cat,
  {order})`), and a keyed-best variant `scores.best(category, key)` — or document
  `Arcade.stats` as the blessed home for keyed maps.

### B6. Peer identity + presence surface — from p2p-chat
- **Problem:** p2p-chat had to invent its own persistent `myId` and a retry+echo
  hello handshake because `fromPeer` is the hardcoded string `'peer'`
  (`index.html:1027`) and no stable peer identity is exposed — even though the
  launcher already keys auto-reconnect on `deviceId`.
- **Fix:** expose `Arcade.peer.self()` / `Arcade.peer.remote()` (or a roster),
  stamp `fromPeer` with the real id, and emit a "remote game with matching gameId
  is now listening" presence/ready event so games stop re-solving handshake-with-
  backoff.

### B7. Binary/large-payload helper + queue visibility — from p2p-chat
- **Problem:** p2p-chat owns 60+ lines of base64 chunking/reassembly/progress; the
  1000-message replay cap is invisible to games (chained file sends during one
  `interrupted` episode can silently overrun it).
- **Fix:** `Arcade.peer.sendBlob(blob, {onProgress})` / `onBlob`, and expose queue
  depth or a "queue full / dropping" event.

### B8. `data-reduced-motion` DOM hook + kill-switch rule — from si-syn / p2p-chat / sowduku
- **Problem:** the SDK sets `--motion-scale` (needs every duration rewritten as
  `calc()`), so games hand-roll blanket approaches and p2p-chat's broke on a
  `--motion` vs `--motion-scale` name mismatch.
- **Fix:** also set `data-reduced-motion="true|false"` on `<html>` and ship the
  standard `[data-reduced-motion="true"] * { animation-duration:.001ms!important;
  transition-duration:.001ms!important; }` rule in the injected base style
  (opt-out-able like the font-size rule).

### B9. Migration ergonomics — from cozy / hecknsic
- **Fix:** `Arcade.state.adopt(legacyKey, newKey, { json = true })` (read →
  namespaced write → delete original, error-safe) so migrations shrink to a line.
- Doc note in §3: "treat `onStateReplaced` like a fresh boot — recompute your start
  screen from storage; don't assume the current screen is valid in the imported
  save" (si-syn's locked-level bug), plus an intra-namespace schema-bump example.

### B10. `dev.sh` should read gameId from the game, not the dir basename — from sowduku
- **Where:** `dev.sh:133,176` (`game_id="$(basename "$game_dir")"`).
- **Problem:** a checkout named differently from the slug (`sow-duku` vs `sowduku`)
  makes launcher buttons and `acceptance.mjs` 404.
- **Fix:** grep the staged `index.html` for `Arcade.init({ gameId: ... })`, or
  accept a `../dir:gameId` override, and mount at `/<gameId>/`.

### B11. Retire the ls-proxy legacy path — from hecknsic
- The only game that shipped the shim (hecknsic) removed it. Sequence: land
  hecknsic's `.ls.*` data-recovery migration (see hecknsic plan), wait one release,
  then delete `handleLsProxyRequest` and the `ls-proxy-request` branch
  (`index.html:1099-1163`) and the back-compat notes in GAME_INTEGRATION.md §9.

### B12. Save-export governance + import semantics — from moon-lit
- **Problem:** nothing caps per-game export weight (moon-lit ships 500-record
  telemetry into every save); import is merge-not-replace while the UI says
  "replace N keys" (`index.html:1461-1471`); OS theme flips mid-session don't
  re-broadcast (no `matchMedia` change listener at `index.html:1219-1252`).
- **Fix:** optional `Arcade.state.set(key, v, { exportable:false })`; make the
  confirm copy match merge behavior (or offer replace); add `matchMedia` listeners
  that fire `arcade:settings.changed`.

### B13. Structural: de-god the platformController — MED (cohesion)
- **Where:** `index.html:803-1486` — one ~680-line IIFE coordinating with five
  siblings via 12+ `window.__arcade.*` properties. Finding A3 is a direct symptom.
- **Fix:** extract save/load and p2p wiring into ES modules (arcade-p2p.js proves
  the pattern); make `window.__arcade` a single explicitly-constructed object;
  give `knownPeers` a single owner (the bridge) exposing rename/delete to end the
  duplicated CRUD + last-write-wins race (`index.html:576-595` vs
  `arcade-p2p.js:142-152`).

---

## Suggested sequencing
1. A1–A3 (small, localized, high-value) → A4, A5.
2. B2–B4 + B1 (the systemic lifecycle + SW fixes that unblock game plans).
3. B5–B9, B12 (SDK API additions; coordinate with game plans that depend on them).
4. B10, A6–A9, B13 (tooling, hardening, refactor when convenient).
5. B11 after hecknsic's migration ships and one release passes.
