# Arcade fleet — security, lifecycle & platform hardening plan

> ## ✅ Verified status — 2026-07-10
> A code-level audit of every repo (git + source) reconciled this plan against reality.
>
> **DONE (removed from the per-game plans):**
> - **All 7 per-game review PRs are MERGED** (`arcade-review-fixes`, 2026-07-10):
>   moon-lit #21, p2p-chat #2, pi-game #15, hecknsic #39, si-syn #18, cozy-solitaire #8, sowduku #2.
>   Their primary bugs are fixed and verified. Residual per-game items are down to a few
>   low-priority cleanups (see each game plan) — **except sowduku's stored XSS, still open (C1).**
> - **Framework-launcher.md Part A: 9/9 shipped. Part B: 11/13 shipped** (B11 deferred by design,
>   B13 partial). Every SDK helper the "Confirmed already DONE" list below claims was re-verified
>   present in code — no false claims.
>
> **STILL OPEN — this document's remaining scope, in priority order:**
> 1. **sowduku stored XSS + migration sentinel (Part C1)** — still exploitable; top priority.
> 2. **Framework P2P security checklist #21 (Part A, phases A1–A5)** — *none implemented.* Recent
>    commits were multiplayer feature/reliability work, not this hardening.
> 3. **CI test gate (Part D1)** — highest leverage; protects every fix above from silent regression.
> 4. **Part D2/D3, Part B (envelope validator, mqtt-codec test, B13 refactor, B11 cleanup).**
> 5. **Part E docs + issue hygiene** (close 7 paired issues, version reconcile, doc corrections).
>
> Part C2 (suspend-leaking timers) is now **behaviorally resolved per-game** — see the updated C2.

> ## ✅ Update — 2026-07-15
> Of the "STILL OPEN" list above, all but the refactor have since landed:
> 1. ✅ **sowduku stored XSS + migration sentinel (C1)** — fixed, merged (sowduku#4).
> 2. ✅ **Framework P2P security checklist #21** — closed; remediated across #54/#57 plus the
>    #59–#61 hygiene batch (shared envelope validator `arcade-envelope.js`, blob concurrency caps,
>    MQTT codec unit suite).
> 3. ✅ **CI test gate (D1)** — shipped (`--pool` gate + unit suites in `pages.yml`).
> 4. ✅ Envelope validator, mqtt-codec test — shipped (#59, #61). **B13 refactor is still partial**
>    (see `framework-launcher.md` B13) — `platformController` is down to ~1,500 lines via the P4-d
>    storage/save extraction, but the `loadP2P`/`arcade-p2p-wiring.js` split hasn't happened.
> 5. ✅ **Part E docs + issue hygiene** — the 7 paired per-game issues are all closed.

## Context

Multiplayer (WebRTC datachannels + MQTT-broker auto-reconnect rendezvous) just shipped and works. Before it, a hardened security review produced GitHub issue **#21** (two ship-blockers fixed in PR #22; a longer checklist deferred), and `plans/framework-launcher.md` left Part-A/B framework items partly open. Separately, a seven-part per-game review produced one issue per game; **those fixes are now all merged (2026-07-10)** — the residual per-game work is small (and tracked in each game plan), except sowduku's stored XSS.

This plan started as "finish the #21 P2P security checklist." Three fresh read-only audits this session (SDK-propagation/SW-prevention, fleet-wide bug-class recurrence, docs/issue drift) widened it: the real remaining work is **fleet-wide**, not just in the launcher's P2P code. The goal is to close the genuine security gaps, stop the bug *classes* from recurring in the next game, and fix the framework-level things the whole fleet silently depends on — without regressing the multiplayer feature that just shipped.

---

## Corrections the audits forced (things the first draft or the tracking got wrong)

- **sow-duku has a stored-XSS bug** of the *same class* as p2p-chat's critical finding — user-authored pack/field names round-trip through save export→import and land raw in `innerHTML`. Its review PR (#2, now merged) only covered SW caching + suspend and **never touched this — re-confirmed still exploitable in code on 2026-07-10** (no `escapeHtml` helper; raw sinks at `index.html:2789-2792,2813,2970,3078`). **This is the single most important remaining finding. File sowduku issue #4.**
- **The managed lifecycle helpers shipped but no game uses them.** `Arcade.loop` / `Arcade.session.setTimeout/setInterval` exist in the SDK; fleet-wide references = **zero**. The per-game PRs fixed each game's *main* loop by hand, but secondary one-shot/interval timers still fire during launcher-suspend in hecknsic, si-syn, and sow-duku.
- **Issue #27 (peer-identity/sendBlob SDK asks) is stale** — `Arcade.peer.self/remote/onReady/sendBlob/onBlob/queue` all already exist. Close it.
- **Issue #25 is half-done** — the p2p-chat "TEMP" launcher button is *already removed* from `index.html`; only the "promote to a real release + add the `profile.html #games` mirror, or leave out" decision remains.
- **CI runs no tests.** The three Playwright acceptance harnesses are npm-scripts only; the sole workflow just deploys Pages. Nothing gates a regression of any fix in this plan.
- **Blob-cap (#5) nuance:** the *send-side* size cap already exists (`arcade-sdk.js:879`); the gap is the *receive-side* `blobRx` reassembly map (`arcade-sdk.js:441`) — no concurrent-id cap, no idle TTL.
- **#21 bookkeeping:** its "FIXED in #20" line should read **#22** (#20 is moon-lit's issue); decrypt-rate-limit / outbox-prune-bound / relay-fanout-bound aren't itemized in #21; `ISSUES.md` still points at the merged #17 as the tracker instead of #21.

### Confirmed already DONE (no action)
IndexedDB RMW races (#7, `_updateRec` + `_serial`), `atob`/unpack try-catch (#16), offer-link consent (A6), CDN URLs (A9), broker metadata-honesty sentence (A8), SW scope-filtering + `game-sw.js` template + §10 snippet + `checkSWCollision` (B1), standalone suspend (B2), `Arcade.context.suspended`/`data-arcade-suspended` (B3), managed loop/timers *exist* (B4), scores order + keyed bests (B5), peer identity/blob APIs *exist* (B6/B7), reduced-motion hook + kill-switch (B8), `state.adopt` (B9), `dev.sh` gameId detection (B10).

---

## PART A — Framework P2P security checklist (issue #21)

`p2p/*.js` + `arcade-sdk.js`. Each phase is its own branch/PR so the shipped multiplayer state stays bisectable. Reuse the existing per-key mutex `_serial(map, key, fn)` (`rendezvous.js:272`) rather than inventing locks.

### Phase A1 — SDP injection (HIGH, standalone) · `p2p/sdp-codec.js`
`ByteReader.lstr()` (55-61) validates nothing on unpack; `unpack()` (296-340) feeds `ufrag`/`pwd`/`mid`/RAW-candidate-address straight into `buildSDP()` (196-230), which interpolates them unescaped into SDP text reaching `setRemoteDescription` → CRLF-injection of arbitrary `a=candidate:` lines.
**Fix:** add per-field charset regexes near `UUID_LOCAL_RE`/`HASH_BY_LEN` (25-27), validate after each `r.lstr()` in `unpack()` and throw (existing `decodePayload` callers catch); reject `\r`/`\n`/whitespace in the RAW candidate-address fallback (328) before it reaches `buildSDP` (202/204).
**Verify:** new `tools/sdp-codec-unit.mjs` (pure Node) — round-trip legit SDPs; assert CRLF-injected packed payloads throw instead of emitting injected lines.

### Phase A2 — rendezvous episode-race cluster (HIGH + 2×MED) · `p2p/rendezvous.js`
- **#2 TOCTOU double-adopt:** `_onListenerOffer`/`_onCallerAnswer` check `ep.answering`/`ep.exchanged` before several `await`s, set after (1211/1233, 1141/1151). Add `_epLocks` (new Map keyed by pairId) and route the blob-dispatch chokepoint (~980) through `_serial(this._epLocks, pairId, …)`.
- **#8 unbounded decrypt (CPU DoS):** ~~`EPOCH_WINDOW=3` AES-GCM attempts run unconditionally~~ — RESOLVED: the epoch window was deleted with the frozen-ratchet machinery (decrypts are single-attempt at the fixed epoch now) and a per-episode decrypt token bucket already rate-limits hostile blobs.
- **#6 day-topics never refresh:** `_topics(ep)` (917-922) subscribes a 3-day window once (978); a long-quiet episode drifts past UTC midnight and goes deaf. Change `ep.unsubs` → `Map<topic,unsub>`, add hourly `_refreshTopics(pairId, ep)`.
**Verify:** extend `tools/p2p-reconnect-acceptance.mjs` (uses `window.__arcade.p2p._rdv()`; `FAST_RDV` at line 106 is the time-control template) — duplicate-distinct-offer → single adoption; simulated day-rollover → resubscribe; garbage-flood → attempt cap holds.

### Phase A3 — p2p-core session/control cluster (2×MED + 2×LOW) · `p2p/p2p-core.js`
- **#3+#13 session-resume identity binding:** `generateId()` (274) is `Math.random`; `preserveSession` (361) inherits outbox/seq with no fingerprint check; `stashedAt` (344) written, never read (no TTL). Fix: `generateId`→`crypto.getRandomValues` (mirror `RendezvousCrypto.randBytes`); add `fingerprint` to `_sessionSnapshot()` via `getPeerFingerprint()`, refuse resume on mismatch; enforce `stashedAt` TTL at the read site.
- **#9 forged control frames prune outbox:** `ack`/`resync` (591-598) trust `upTo`/`have` unbounded; `peerData.outSeq` already exists as the bound — clamp `Math.min(msg.upTo, peerData.outSeq)`.
- **#10 unbounded relay fanout:** host relay `forEach` (568-572) has no per-source budget — add a timestamp-window counter on `peerData`.
- **#14 `connectionTimeoutMs` leak:** setTimeout (1017-1027) never cleared — capture id, clear on `everConnected` (783).
**Verify:** extend `p2p-acceptance.mjs` — mismatched-fingerprint resume → no state carryover; forged `{__p2pc:'ack',upTo:1e9}` → entries below `outSeq` survive; 3-peer relay flood → capped without breaking delivery.

### Phase A4 — signaling forgery + blob cap (2×MED) · `p2p/p2p-ui.js`, `arcade-sdk.js`
- **#4 same-origin relay forgeable:** `_tryApplyAnswer` (69-85) accepts the first shape-valid answer for a known peerId off BroadcastChannel/localStorage — a same-origin sandboxed game iframe could race a forgery. Add a one-shot `_answeredPeerIds` gate.
- **#5 blob reassembly no cap/TTL:** receive-side `blobRx` (426) — cap concurrent ids (~8, reuse the `sessionStash` LRU idiom at p2p-core.js:920), lazy idle-TTL drop on next touch.
**Verify:** second same-origin page injects a post-legitimate forged answer → no effect; >8 never-completed blobs → oldest evicted.

### Phase A5 — LOW sweep (mechanical)
`noteRemotePeer` missing `isDunderKey` guard (#11, arcade-sdk.js:133); `identityLinks` cleaned only in `startOverKnownPeer` (#12, arcade-p2p.js — reuse reverse-lookup at :487); wake-probe stale-closure identity check (#15, p2p-core.js:887); `navigator.userAgent` in diag transcript, add a copy-visible notice (#17, arcade-diag.js:48 + p2p-ui.js:640).

---

## PART B — Framework structural & standardization

- **B13 de-god `platformController`** (`index.html:697-1532`, ~835 lines): extract `arcade-save.js` (save/export/import: `isSafeArcadeKey`/`KEY_RE`/`DUNDER_SEGMENTS`, `buildBundle`/`exportSave`/`importSaveFile`) and `arcade-p2p-wiring.js` (`loadP2P` body + `askAutoReconnect` + `tryResumeOnLaunch` as an injected factory), following the `arcade-known-peers.js`/`arcade-p2p.js` pattern. Leave the iframe pool + postMessage switch in `index.html`. `window.__arcade`-as-single-object is an optional follow-up. **Verify:** `npm run acceptance` green after each extraction (no behavior change). *No forced coupling with Part A — none of the outstanding security items touch `index.html`; sequence after A.*
- **Envelope/schema validator (roadmap #4): PROCEED**, after B13. Generalize `ConnectionUtils.validatePayload` (p2p-core.js:118) into a shared `envelope.js` used by the launcher postMessage switch, `arcade-p2p.js`'s envelope check, and the SDK `onMessage`.
- **MQTT-codec unit test (roadmap #2 alt): PROCEED**, anytime. The file claims `mqttCodec` is "exported for hermetic unit tests" but none exist — add `tools/mqtt-codec-unit.mjs`.
- **Noise Protocol swap (roadmap #1): REJECT.** `rendezvous-crypto.js` is a hand-rolled *protocol* on native WebCrypto primitives (non-extractable keys, decrypt-then-parse, AAD-bound direction+epoch, role-bound confirm MAC, DTLS-transcript ratchet) — no concrete weakness found; the swap adds a dependency (contradicts its zero-dep design) with no clean migration for paired devices.
- **mqtt.js swap (roadmap #2): REJECT.** ~200 narrowly-scoped lines with app-specific backoff/suspend-healing a general client wouldn't provide; the codec unit test above addresses the real underlying concern.
- **Games on a separate origin (roadmap #5): DEFER.** Cross-repo infra change (subdomain, hosting, every game's postMessage-origin assumptions) — track as its own standalone initiative.

---

## PART C — Fleet-wide residual bugs (from the recurrence audit)

### C1 — sow-duku dedicated follow-up (its review PR missed these) · `/Users/paulgibeault/work/sow-duku/index.html`
- **Stored XSS (MED-HIGH, critical class):** field name `(f.name||f.code)` → `innerHTML` (2792), pack name `p.name` (2811, 2960), `rec.code` (3078). No `escapeHtml` helper; only an ad-hoc quote-escape on the input value (3067). Pack names are export→import round-tripped and the UI literally invites sharing packs ("paste into campaigns.js") → a shared malicious pack executes script in the same-origin iframe (full `arcade.v1.*` read/write). **Fix:** add an `escapeHtml` helper (copy p2p-chat's), escape every dynamic name/code at each `innerHTML` sink, or render via `textContent` like hecknsic/pi-game already do.
- **Missing migration sentinel (LOW):** no `Arcade.state.migrate(...)` anywhere — the acceptance sentinel the other 6 games have. The review agent skipped this as "dead code"; it's the acceptance probe. Add a no-op `migrate('v1', () => {})`.
- **Reduced-motion (LOW, verify first):** honors only OS `@media (prefers-reduced-motion)` (456), never reads `Arcade.settings.reducedMotion()`. The SDK's injected global `:root[data-reduced-motion="true"] *` kill-switch *likely already neutralizes its CSS animations* — so the real residual is only JS/transform-driven motion and standalone. Confirm before investing; if covered, downgrade to a one-line README note.
**File a new sowduku issue** (will be #4) covering the XSS (lead item) + sentinel; either extend the open PR or a follow-up PR.

### C2 — Residual suspend-leaking timers — ✅ behaviorally RESOLVED (2026-07-10)
The `arcade-review-fixes` PRs closed these behaviorally, though most hand-rolled a suspend guard
rather than adopting the managed helper (that migration is C3, optional):
- **si-syn:** boot/guide/tray/auto-advance timers now paused on suspend via a hand-rolled
  `pauseTimeouts`/`scheduleTimeout` wrapper (`src/main.js:92-112,950-966`). ✅
- **sow-duku:** the 1 Hz tick `setInterval` is now `clearInterval`-ed on suspend
  (`index.html:1666`), so the persist-churn no longer fires while hidden. ✅
- **hecknsic:** rAF cancelled on suspend (`js/main.js:131`); its result/animation timers are
  short-lived and no longer a suspend concern. ✅

**No remaining C2 action.** The only leftover is the *stylistic* migration to
`Arcade.session.setTimeout/setInterval`, folded into C3 below (opportunistic, not required).

### C3 — Managed-helper adoption (systemic B, fleet-wide)
All 7 games hand-roll rAF + raw timers; zero use `Arcade.loop`/`Arcade.session.*`. Main loops are mostly rescued by manual `onSuspend`/`onResume`, but the pattern is re-hand-rolled everywhere and C2 is the recurring leak. **Recommendation:** file a framework-tracked "adopt managed lifecycle helpers" ticket; migrate opportunistically (not a forced rewrite) — C2 is the priority slice. cozy-solitaire and pi-game are the cleanest hand-rollers and can serve as the reference once migrated.

---

## PART D — Framework hardening the whole fleet depends on

- **D1 — CI test gate (HIGHEST LEVERAGE).** Only workflow is `pages.yml` (deploy). Add a workflow that runs `tools/acceptance.mjs` (+ the p2p harnesses) on PRs against the framework repo, and ideally a reusable acceptance job games can call. Without this, every fix in this plan can silently regress. This is the correction that protects all the others.
- **D2 — SDK cache-busting / stale-SDK eviction.** `/arcade-sdk.js` has no `?v=` and the SDK can't evict a copy a *game's* SW already cached (root cause of the moon-lit/hecknsic/sowduku SW findings, from the game side). Options: version query-string on the SDK script tag, or an SDK-broadcast "your cached SDK is stale" signal. File an issue.
- **D3 — Acceptance asserts the negative.** `acceptance.mjs` check #10 verifies a game with a SW boots offline, but does *not* assert the game SW refrains from caching launcher assets — it only scrapes `checkSWCollision` console output without failing on it. Make a collision a hard failure.

---

## PART E — Docs & issue hygiene

**Doc corrections (framework repo):**
- `ARCADE_PLATFORM.md:330` — launcher pins inbound `postMessage` to `entry.origin` (mount-time), *not* `location.origin`; document the cross-origin dev-staging allowance. (SDK half of the sentence is correct.)
- `ARCADE_PLATFORM.md:331` — credit prototype-pollution protection to the `DUNDER_SEGMENTS` per-segment check, not the key regex (the regex *matches* `__proto__`).
- **Version reconcile:** rendezvous feature is **v1.9** in `README.md:75`, `GAME_INTEGRATION.md:394`, and the shipped UI header (`p2p-ui.js:6`) but **v1.10** in `ARCADE_PLATFORM.md:210/218`. Pick one.

**Issue hygiene (framework repo):**
- Fix #21's "FIXED in #20" → **#22**; add decrypt-rate-limit / outbox-prune-bound / relay-fanout-bound as explicit line items.
- Update `ISSUES.md` to point at **#21** (not the merged #17) as the security tracker.
- **Close #27** (peer APIs already shipped); note p2p-chat hasn't adopted them yet (low-priority, separate).
- **Re-evaluate framework #1** (`sw.js:76` `fetch().catch(caches.match)` can still resolve `undefined` for an uncached launcher asset offline — scope-filtering narrowed but didn't close it).
- **#25** — button already removed; reduce to the "promote p2p-chat to a real release (+ `profile.html #games` mirror) or leave out" decision only.
- **File issues** for: D1 (CI), D2 (SDK cache-bust), D3 (acceptance negative), B13 (refactor), envelope validator, C3 (managed-helper adoption), and the roadmap items you want scheduled (Noise/mqtt/separate-origin — as "considered & rejected/deferred" records if nothing else).

**Close the 7 paired integration issues NOW** — all `arcade-review-fixes` PRs merged 2026-07-10:
moon-lit #20, p2p-chat #1, pi-game #14, hecknsic #38, si-syn #17, cozy-solitaire #7, sowduku #1.
(Caveat: close **sowduku #1** only after recording that the stored XSS was out of its scope and
is now tracked in the new sowduku #4.) Follow-up cleanup issues are already filed where needed:
hecknsic #40, cozy-solitaire #9, sowduku #3; launcher-side #25/#26/#27 remain open (see above).

---

## Execution order

1. **Part A** security phases A1→A5, each its own PR (bisectable). A1 and A5 are independent; A2/A3/A4 touch the racy core — land in order.
2. **Part C1** (sow-duku XSS) — fast, high-value, same class as an already-shipped critical fix; can run in parallel with Part A (different repo).
3. **Part D1** (CI gate) — do early; it protects everything after it.
4. **Part C2** (suspend-leaking timers) → **C3** (broader managed-helper adoption).
5. **Part B** (B13 refactor → envelope validator; mqtt-codec test anytime).
6. **Part D2/D3, Part E** — hardening + docs/issue cleanup, interleaved as convenient.

Rejected/deferred (Noise swap, mqtt.js swap, separate-origin) are recorded, not scheduled — revisit only on new information.

## Verification strategy

- **Unit (pure Node, fast, CI-able):** `tools/sdp-codec-unit.mjs` (A1), `tools/mqtt-codec-unit.mjs` (Part B).
- **Acceptance (Playwright):** extend `p2p-reconnect-acceptance.mjs` (A2) and `p2p-acceptance.mjs` (A3/A4) with the scenarios listed per phase; extend `tools/acceptance.mjs` for D3.
- **Per-game:** `npm run acceptance` per repo for C1/C2 (the sentinel is itself an acceptance probe).
- **Gate:** once D1 lands, all of the above run on PRs — the durable guarantee that these fixes stay fixed.
