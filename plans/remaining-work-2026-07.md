# Finish the framework-review plan: P4-d extraction + all remaining items

## Context

`plans/framework-review-2026-07.md` is nearly done — everything through Phase 4 landed in PR #54 (HEAD `1a1b38d`, all six acceptance suites green in CI). Verified against current code, exactly six items remain: **P4-d** (extract the ~1,000-line storage-bridge + save/import machinery from `index.html` into modules — deferred because it's the security-critical opaque-frame boundary from #50), **S-sec-4a** (persistent cross-episode replay cache in rendezvous), **T-4** (harness carrier hooks + failure-injection scenarios), and three small ones (**S-sdk-2** doc-deprecation, **S-sdk-6** SDK dedup, **D-4** plans housekeeping). This plan executes all of them as four sequential work packages on the working tree (user commits per package, matching prior sessions). All line anchors below verified at HEAD.

---

## WP1 — P4-d: extract storage/save machinery from index.html (+ S-lnc dedup)

Pure move/re-wire refactor — behavior, toast copy, DOM ids, and the native `window.confirm` must be preserved exactly (Playwright suites depend on them). `index.html` is 2936 lines: block B (523–2541) is a **classic** script holding `platformController` (766–2479); block C (2543–2933) is the `type="module"` connections dialog — the `window.__arcade`-as-bus pattern to imitate.

### New modules (3 — all ES modules, zero top-level side effects so Node can import them)

**`arcade-storage-core.js`** (~230 lines) — shared pure layer; the single file where all allowlists live (makes B-lnc-1-style drift visible in one place). Verbatim moves from index.html:
- Key predicates/constants: `KEY_PREFIX`/`KEY_RE`@770, `DUNDER_SEGMENTS`/`isSafeArcadeKey`@775-782, `IMPORT_PROTECTED_KEYS`@790, `SAVE_FORMAT`/`SAVE_SCHEMA`/`MAX_IMPORT_BYTES`/`PROBE_KEY`@795-801, `lsPrefix`/`LS_PROXY_KEY_RE`/`isLsProxyBackupKey`@1347-1359, `BRIDGE_VALUE_MAX`/`BRIDGE_STORE_VALUE_MAX`/`BRIDGE_FILE_MAX`/`approxSize`/`SETTINGS_KEY_RE`@1415-1429, `bridgeKeyWritable`@1455, `STORE_NAME_RE`@1498 + file-name regexes, `hasDunderSegment`@1966
- Checksums/serialization: `checksumData`@1938, `stableStringify`@1972, `checksumBundle`@1978 (crypto.subtle — Node 24 has it)
- IDB/OPFS helpers (shared by bridge AND save — the reason for a third module): `idbOpen`/`idbAll`/`idbPut`/`idbGet`/`idbDel`/`idbClear`@1990-2047, `blobToB64`/`b64ToBlob`/`listArcadeDbNames`/`opfsRoot`@2048-2079

**`arcade-storage-bridge.js`** (~270 lines) — imports core. Verbatim moves: `handleLsProxyRequest`@1360, `handleBridgedStateWrite`@1463, `bridgeReply`@1490, `validRpcId`@1496, `handleStoreOp`@1499, `handleFilesOp`@1546, `handleStorageOp`@1635. One export:
```js
export function initStorageBridge(host) {
    return { lsProxy, stateWrite, storeOp, filesOp, storageOp };  // authenticated (gameId, data) handlers
}
```
Closure substitutions inside moved bodies: `postToIframe` → `host.postToIframe`; `pool.keys()` loop @1482 → `host.listMountedGameIds()`; `window.__arcade.broadcastSettings()` @1487 → `host.broadcastSettings()` (bridge-acceptance exercises a `global.*` settings write — don't drop this).

**`arcade-save.js`** (~330 lines) — imports core. Verbatim moves: `gatherGameIds`/`collectStores`/`collectFiles`/`writeStores`/`writeFiles`@2080-2201, `collectArcadeKeys`@2203, `isoStamp`/`downloadJSON`@2231 (keep filename formats exactly), `buildBundle`@2262 (keep `appVersion:'1.0.0'`), `countFiles`, `exportSave`@2286, `quotaProbe`/`snapshotKeys`/`restoreSnapshot`/`readFileText`@2309, `importSaveFile`@2343.

The one deliberate reshape — extract the pure validation gates (shape → allowlist filter → empty-check → checksum, current gates 4–6 of `importSaveFile`) into a Node-testable export:
```js
export async function validateSaveBundle(parsed) →
    { ok:false, reason:'not-a-save'|'no-valid-keys'|'checksum-error'|'checksum-mismatch' }
  | { ok:true, isV2, cleanData, cleanKeys, droppedKeys, protectedSkipped, parsedStores, parsedFiles }
```
Invariant to preserve (pin in the unit test): checksum verifies the file's **original** `data`/`stores`/`files`, never the filtered `cleanData` (comment at index.html:2392). `importSaveFile` keeps gates 1–3 and 7–10 unchanged, maps each `reason` to the exact existing toast strings, and keeps native `window.confirm` (export-roundtrip auto-accepts via `page.on('dialog')`).

Wiring export `initSaveLoad(host)`: re-attaches the verbatim listeners @2471-2478 to `#btn-save`/`#btn-load`/`#file-load` (ids unchanged — tests click these). Post-import reseed @2465-2467 → `host.listMountedGameIds()` + `host.postToIframe` + `host.stateSnapshotFor`.

### What stays in index.html

- **The message router @1660-1771 and its trust guard** (`findPoolEntryForSource` + `e.origin !== 'null'`) — the #50 security boundary exists exactly once; handlers receive already-authenticated `(gameId, data)`. The `arcade:hello`/`peer.send`/`ui.toast` cases stay verbatim (launcher/p2p-coupled).
- **`stateSnapshotFor`@1431** — needed synchronously by the hello→welcome path @1705; passed to the save module via host ctx. index.html keeps a local `KEY_PREFIX` literal (acceptable duplication; the drift-prone allowlists all move to core).
- Router storage cases become delegation **with a pending queue** (a dropped pre-init `ls-proxy-request` would hang hecknsic's boot — its shim blocks module init on the dump reply):
```js
const pendingStorageMsgs = [];
function dispatchStorageMessage(gameId, data, source, origin) {
    const S = window.__arcade.storage;
    if (!S) { pendingStorageMsgs.push([gameId, data, source, origin]); return; }
    switch (data.type) { /* ls-proxy-request, arcade:state.write, store.op, files.op, storage.op → S.* */ }
}
```
- Host ctx defined at the end of `platformController`:
```js
window.__arcade.storageHost = { postToIframe, listMountedGameIds: () => [...pool.keys()],
    stateSnapshotFor, showToast, broadcastSettings: () => window.__arcade.broadcastSettings(),
    replayPendingStorageMessages };
```
- Add `storageHost: null` and `storage: null` slots to the `__arcade` literal @532-552 (its doc comment requires every slot listed).

### Load wiring — new script block D

New `<script type="module">` between block B (@2541) and block C:
```html
<script type="module">
    import { initStorageBridge } from './arcade-storage-bridge.js';
    import { initSaveLoad } from './arcade-save.js';
    const host = window.__arcade.storageHost;
    window.__arcade.storage = initStorageBridge(host);
    initSaveLoad(host);
    host.replayPendingStorageMessages();
</script>
```
Module blocks run in document order after parse, before `load` (which Playwright's `goto` awaits) — tests unaffected.

### S-lnc dedup (fold in, per plan §P4-d)

- `resolvePeerName` @1173-1176 (inline `JSON.parse` of knownPeers): change `loadP2P` @1030 to `Promise.all([import('./arcade-p2p.js'), import('./arcade-known-peers.js')])` (already a static dep of arcade-p2p — zero extra fetches) and use `readKnownPeers()` (arcade-known-peers.js:21).
- `tryResumeOnLaunch` @1264 (same inline parse): move the callable-check inside `import('./arcade-known-peers.js').then(...)` (it already dynamic-imports arcade-diag nearby); `.catch` falls back to the lastLive-only decision so boot survives a module-fetch failure.

### sw.js + CI

- `CACHE_NAME` `'paul-arcade-v27'` → `'paul-arcade-v28'` (sw.js:1); add `'./arcade-storage-core.js'`, `'./arcade-storage-bridge.js'`, `'./arcade-save.js'` to `ASSETS_TO_CACHE` after `'./arcade-known-peers.js'` (sw.js:13).
- pages.yml `node --check` list (:29-30) is **explicit, not a glob** — add the three new filenames.

### New Node unit test — `tools/save-validation-unit.mjs`

Modeled on `tools/rendezvous-unit.mjs` (no browser). Imports core + save. Checks: `isSafeArcadeKey` (accept/reject incl. dunder smuggling `arcade.v1.__proto__.x`), `isLsProxyBackupKey`, `bridgeKeyWritable` (own ns + `global.*` + `_meta.dev` allowed; other ns / `_meta.deviceId` / `_meta.knownPeers` / >512-char rejected), `stableStringify` order-independence, `checksumData`/`checksumBundle` determinism + tamper detection, and `validateSaveBundle` fixtures: valid v1/v2 accept; bad format/schema → `not-a-save`; unsafe keys → `droppedKeys`; every `IMPORT_PROTECTED_KEYS` member excluded + counted; all-invalid → `no-valid-keys`; flipped checksum → `checksum-mismatch`; **checksum-over-original-data invariant** (fixture whose dropped keys would change the digest). Add `"save-unit"` script to package.json + a pages.yml step next to `rendezvous-unit`.

### Migration order (verify after each step)

1. Create `arcade-storage-core.js` (index.html untouched) → `node --check` + Node import smoke.
2. Create `arcade-save.js`, delete moved code from block B, add `storageHost` + block D (save half) → `npm run export-roundtrip`, `store-acceptance`.
3. Create `arcade-storage-bridge.js`, router delegation + queue, delete moved bridge code → `bridge-acceptance`, `store-acceptance`, `export-roundtrip`.
4. S-lnc dedup → `p2p-acceptance`, `p2p-reconnect`, `p2p-multiseat`.
5. `tools/save-validation-unit.mjs` + package.json + pages.yml → `npm run save-unit`.
6. sw.js bump → final full pass of all suites.

---

## WP2 — S-sec-4a: persistent cross-episode replay cache (`p2p/rendezvous.js`)

The ratchet is intentionally frozen (`rendezvous.js:1414-1439`, `rec.epoch` stays 0), so replay defense is per-episode only: `ep.deadNonces`/`ep.seenRings` (episode struct @1025-1033), checked at `_onListenerOffer` @1326, `_onCallerRing` @1291-1292, `_onCallerAnswer` @1241. The compensating decrypt rate-limit (S-sec-4b) is in @1196-1207.

**Design:** add `rec.seenNonces` — a bounded FIFO array (cap **512** nonces, newest-last) in the IDB pair record (shape minted at `_completePairing` @653-656).
- **Check:** at the three sites above, after the ephemeral-set check, also reject if the nonce is in the rec's persistent list. Keep an in-RAM mirror on the episode (loaded from the rec the episode start already reads through `_serial(this._recWrites, pairId, () => dbGet(pairId))` @1015/@869) so the check is synchronous.
- **Record:** on each successful `open()` of an offer/ring/answer, append the nonce to the mirror and write-through via `_updateRec(pairId, mutate)` @310-325 (already serialized, tombstone-aware). Trim FIFO at cap. Replayed frames are rejected before processing, so an attacker cannot force writes — only fresh legitimate frames append.
- **Docs:** update `p2p/PROTOCOL.md` §7.4 (@357-362) and the §8 threat table (@491) — the "partial / tracked follow-up" wording becomes "closed by persistent per-pair nonce cache (bounded FIFO, 512)". Tick S-sec-4a in the plan status banner.
- **Test:** extend `tools/rendezvous-unit.mjs`-style coverage if feasible; at minimum a reconnect-suite scenario asserting a second episode rejects a replayed prior-episode offer (fits naturally with WP3's harness work; if browser-driving a raw replay is impractical, unit-test the FIFO/check helper in isolation).

Verify: `npm run rendezvous-unit`, `npm run p2p-reconnect` (3 attempts, it's timing-sensitive), `p2p-acceptance`, `p2p-multiseat`.

---

## WP3 — T-4: harness carrier hooks + failure-injection scenarios

The injected test carrier (`tools/lib/p2p-test-harness.mjs:44-70`, `httpCarrierScript`) implements `connect/_poll/publish/subscribe/close` but lacks the two hooks production carriers have, so three recovery paths run only in production:
- `ensureAlive` — called by `nudgeAll` at `rendezvous.js:539`
- `onSessionUp` — session-restore republish at `rendezvous.js:1077-1079`
- 6-hour topic refresh — `_refreshTopics` @961-987 on `_every(ep, RENDEZVOUS_TOPIC_REFRESH_MS /* 6h, @202 */)` @1069 (the B-rdv-1 fix, currently untested)

**Changes:**
1. Add `ensureAlive()` and an `onSessionUp` callback slot to the harness carrier, with a test-controllable "sever/restore" switch (publishes fail / polls stall while severed; `onSessionUp` fires on restore).
2. New scenarios in `tools/p2p-reconnect-acceptance.mjs` (follow the existing inline-block style, `freshPair(tag)` @64):
   - **Sever/restore mid-episode**: sever the carrier during an active repair, restore, assert `onSessionUp` republish completes the rendezvous.
   - **Day-rollover / topic refresh** with a fake clock — borrow the fake-clock pattern from `tools/bridge-acceptance.mjs:270-281`; advance past 6 h and a UTC midnight, assert new day topics subscribed and aged ones dropped (`_refreshTopics` reconciliation).
   - **Multi-pair concurrent rendezvous**: hub with two spokes healing simultaneously (plan's T6).

Verify: `npm run p2p-reconnect` green ×3 locally (CI runs it with retry); other p2p suites unaffected.

---

## WP4 — Quick wins: S-sdk-2, S-sdk-6, D-4

**S-sdk-2 (docs only):** mark `peer.remote()` deprecated-in-docs in favor of `peers()` — `GAME_INTEGRATION.md:477` (add "deprecated single-peer helper — prefer `peers()`") and the `arcade-sdk.js:1616-1622` comment. Note `arcade:peer.identity` (@1070-1071, doc @GAME_INTEGRATION.md:796) as legacy, retained for launcher compat. No behavior change.

**S-sdk-6 (mechanical dedup, `arcade-sdk.js`):**
- Collapse the two identical monotonic-clock helpers (`now` @1933-1936 inside `createSessionTimer`, module-scoped `nowMs` @2031-2034) into one shared `nowMs`.
- `onStorageError` @2519-2526: replace the hand-rolled push/splice with `makeSubscriber(storageErrorListeners)` (@524-533).
- `devModeOn()` @669-674: cache the `rawGet('arcade.v1._meta.dev')` result (it's read per message @899/@999); refresh on `arcade:state.changed`/`state.replaced` for `_meta.dev` so toggling dev mode still takes effect.

**D-4 (plans housekeeping):**
- `plans/framework-evolution.md`: mark done — C1 LICENSE @129-130, C3 CI gate @137-140, fingerprint-pin overwrite @215-218, MQTT inbound size cap @221-223, blob integrity/abort (#51) @224-225; update the "Now, cheap" summary @236-237.
- `plans/implementation-roadmap.md`: Phase 0 "not yet committed" @17-18 → committed/merged; #41 @159 → closed by #51; promote `_meta.rdvBrokers` #33 @143 out of the deferred pile — **note it is now implemented** (G-res-1 landed in #54), so mark it done rather than just promoted.
- `plans/framework-review-2026-07.md`: update the status banner — tick P4-d, S-sec-4a, S-sdk-2/6, T-4, D-4 as they land.

Verify: `npm run store-acceptance` + `bridge-acceptance` (SDK touched), grep docs for stale references.

---

## Full verification (end of session)

Run the complete suite set, matching CI (`.github/workflows/pages.yml`): `rendezvous-unit`, `save-unit` (new), `store-acceptance`, `bridge-acceptance`, `export-roundtrip`, `p2p-acceptance`, `p2p-multiseat`, `p2p-reconnect`. All must be green. Manual spot-check: load the launcher via a local server, mount a game, save → load roundtrip, dev-mode console shows bridge traffic.

## Risks

1. **Save/Load wiring moves to module-execution time** — Playwright waits for `load`, so tests fine; cold-load first-instant click could no-op once (negligible).
2. **New 404 failure mode** for the three module files — mitigated by SW precache + pages.yml syntax-check list.
3. **`tryResumeOnLaunch` decision becomes async** (one SW-cached import) — `.catch` fallback preserves lastLive-only boot; guarded by p2p-reconnect.
4. **S-sec-4a write-amplification** — one serialized IDB write per successfully-opened frame during rendezvous (a handful per episode); goes through the existing `_recWrites` queue, so no new race surface.
5. **Toast/confirm copy** must move verbatim — user-visible and (for confirm) test-load-bearing.
