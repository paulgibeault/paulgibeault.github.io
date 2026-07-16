# Arcade.sync — multi-device state replication over P2P (LWW) · issue #28

*Plan authored 2026-07-15 at HEAD `2da52ed`; every file:line anchor below verified against that
commit. Written to be executed step-by-step (WP1→WP6) with per-step verification — commit per WP.*

> **Implementation status (2026-07-15, branch `arcade-sync-28`):** ✅ ALL WPs landed —
> WP1 core (95-check `sync-unit`), WP2 SDK, WP3 engine, WP4 envelope/flag/toggle,
> WP5 acceptance (`tools/sync-acceptance.mjs`, incl. scenario 4b), WP6 chrome/docs.
> One post-plan fix: WP5's suite caught a WP3 cursor bug — `reconcileDigest`
> committed the hlcRecv-advanced clock as the per-pair cursor before req'd diffs
> were applied, swallowing `onConflict` on the sever-then-heal digest path. Fixed
> with a pending-cursor discipline (park the union-max, commit only when the
> exchange's need-set drains; drop uncommitted on timeout — a lost diff can cause
> a spurious later conflict, never a swallowed one). Scenario 4b pins it.

## Context (verified anchors)

P2P today moves ephemeral game frames only. The launcher-level envelope router lives in
`arcade-p2p.js`'s transport `message` listener (`arcade-p2p.js:591-761`): `kind:'presence'/'presence-ack'`
handled at :597-612, **everything else without `kind:'identity'` is treated as a game message and
requires `typeof env.gameId === 'string'`** (:613-615) — so a new `kind:'sync'` envelope inserted
before :613 bypasses game routing entirely, and *older* launchers drop it harmlessly (no `gameId`
→ return at :615). State writes flow: game SDK `Arcade.state.set` (`arcade-sdk.js:1450-1461`) →
`writeJSON`→`rawSetItem`→`queueStateWrite` posts `arcade:state.write` (:337) → launcher router
(`index.html:1362-1473`, trust guard :1372-1378) → `dispatchStorageMessage` (:1347-1357) →
`arcade-storage-bridge.js handleBridgedStateWrite` (:96-121) → `localStorage` + shared-key
broadcast. The SDK's generic `arcade:state.changed` handler (`arcade-sdk.js:1205-1218`) updates
`lsCache` and fires `onChange` for **any** key — so the launcher can push sync-applied writes into
a mounted frame with a plain `state.changed`; `arcade:state.replaced` (:1186-1204) covers imports.

Verified facts the design builds on:

- **`{exportable:false}` exists exactly as issue #28 hoped**: sticky per-key flag stored as a
  full-key list at `arcade.v1.<gameId>._noExport` (`arcade-sdk.js:1409-1425`; export honors it at
  `arcade-save.js:229-245`). We mirror the mechanism (`_sync` list) rather than reuse it — sync is
  opt-**in**, so `exportable:false` is not needed as a "don't sync" signal (deviation from the
  issue's sketch, noted in Risks).
- **Allowlists live in one file** (`arcade-storage-core.js` header, :1-18): the new sync-eligibility
  predicate goes there.
- **IDB helpers** `idbOpen/idbGet/idbPut/idbAll/idbDel` (`arcade-storage-core.js:159-216`) open any
  DB with a `kv` store — reusable for the sync DB. Export structurally excludes non-`arcade.v1.*`
  DB names: `collectStores` filters on `STORE_DB_RE` (`arcade-save.js:131`), `gatherGameIds` on its
  own regex (:113) — a DB named **`arcade-sync`** can never be exported, same mechanism that
  protects `qrp2p-identity`/`qrp2p-rendezvous` (asserted by `tools/export-roundtrip-acceptance.mjs:91-92`).
- **Paired-device identity**: `deviceId` (minted `arcade-p2p.js:180-203`, format pinned by
  `DEVICE_ID_RE` :391), per-device record in `arcade.v1._meta.knownPeers` (single owner
  `arcade-known-peers.js`, entry shape :10-16), fingerprint TOFU pin (`recordPeerIdentity`
  :406-433). **Connect/reconnect trigger**: every completed (re)connection re-announces identity
  (seat.announced reset on terminal disconnect, :575-583) so `ArcadeP2P.onPeerIdentity`
  (:1002-1008) fires per-(re)connect on both sides — that's the digest-exchange trigger.
  `fingerprintSuspects`/`isFingerprintSuspect` (:375-386) must gate sync like it gates pairing.
- **Frame cap**: inbound app frames > 256 KB are dropped (`p2p/p2p-core.js:268,621-623`). Sync
  frames must self-cap well below.
- **Targeted direct send**: `addon.sendTo(peerId, env)` (`p2p/p2p-addon.js:105-109`) delivers on
  one link only; `seatReachable` (`arcade-p2p.js:307-311`) gates dead seats; sends queue in the
  per-link outbox during `'interrupted'` and replay on recovery.
- **Never-sync keys**: `_meta.*` (deviceId/deviceName/knownPeers/dev/rdvBrokers/lastLiveSession —
  see `arcade-p2p.js:173-176`, `rdvBrokerUrls` :102-114), `global.*` (launcher-managed settings,
  `SETTINGS_KEY_RE` `arcade-storage-core.js:89`), SDK sidecars (`_noExport`, `_migrated.*`,
  `_sync`), and the `.ls.` proxy subtree (`arcade-storage-core.js:56-72`) — v1 syncs
  **own-namespace app keys only**.
- **Test scaffolding**: `startP2PHarness` (`tools/lib/p2p-test-harness.mjs:120-253`) gives
  two-launcher contexts, injected dead-drop carrier, `ceremony()`; `freshPair(tag)` pattern at
  `tools/p2p-reconnect-acceptance.mjs:64-73`; fake clock pattern at
  `tools/bridge-acceptance.mjs:271-305`; Node-unit style `tools/rendezvous-unit.mjs`. Ports in use:
  4794-4799 (+4791 dev.sh) → the new suite uses **4792/4793**.
- **Chrome**: `sw.js:1` `CACHE_NAME 'paul-arcade-v30'`, assets list :5-39 (insert after
  `'./arcade-save.js'` :17); `pages.yml` explicit `node --check` list :31-33 and unit-test steps
  :38-45; `package.json` scripts :8-22; `window.__arcade` literal `index.html:482-512` requires
  every slot listed; storage module block D `index.html:1771-1788`; `storageHost` :1652-1659;
  `loadP2P` :982-1191 (attach point after `window.__arcade.p2p = ArcadeP2P;` :1183);
  connections-dialog icon group :1950-2023.

**Scope control (v1):** pairwise launcher-side LWW sync of opted-in `Arcade.state` keys. NOT in
v1 (say so in docs): `Arcade.store`/`Arcade.files` blobs, `global.*` settings, `.ls.` subtree,
values > 64 KB, mesh anti-entropy, any transport crypto beyond the existing sealed channel.

---

## Design

### HLC (hybrid logical clock)

Packed sortable string — lexicographic order == causal LWW order:

```
<millis:13 decimal digits>:<counter:4 decimal digits>:<deviceId>
e.g. "1783468800123:0007:0f3c2d1e-...-9a"
HLC_RE = /^\d{13}:\d{4}:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|dev-[a-z0-9]{6,50})$/i
```

- `hlcNext(prevPacked, nowMs, deviceId)`: `millis = max(nowMs, prev.millis)`;
  `counter = millis === prev.millis ? prev.counter + 1 : 0`; counter overflow (>9999) bumps millis
  by 1, counter 0. Monotonic across wall-clock regressions because prev is persisted (`clock`
  record, below).
- `hlcRecv(prevPacked, remotePacked, nowMs, deviceId)`: standard HLC receive — advance to
  `max(prev, remote, now)` before the next local stamp.
- `hlcCompare(a, b)`: plain string compare (fixed widths make it correct); deviceId is the built-in
  tiebreaker.

### Storage schema — IndexedDB db `arcade-sync`, object store `kv` (via existing `idbOpen`)

| kv key | value | purpose |
| --- | --- | --- |
| `clock` | packed HLC string | last HLC issued/observed — monotonicity across restarts |
| `k\|<fullKey>` | `{ h: <hlc>, x: <sha256 hex of raw value>, del: 0\|1, t: <ms> }` | per-key sync record; `del:1` = tombstone (replicated delete), `t` = record time for tombstone GC |
| `p\|<deviceId>` | `{ hlc: <max HLC in the union at last completed exchange>, at: <ms> }` | **per-pair replication cursor** (survives restart; also the pragmatic "concurrent" test for onConflict) |

Tombstone bounds: GC at engine init — drop `del:1` records older than
`SYNC_TOMBSTONE_TTL_MS = 30*24*3600*1000`, and cap tombstones at 512 per app (prune oldest).
Engine keeps a RAM mirror (Map) of all `k|` records, write-through to IDB.

### Key eligibility (two layers)

1. **Structural predicate** — new, in `arcade-storage-core.js` (the audit surface), next to
   `bridgeKeyWritable`:

```js
// ---- sync (Arcade.sync) eligibility + caps ----
export const SYNC_LIST_RE = /^arcade\.v1\.[a-z0-9_-]+\._sync$/;
export const SYNC_VALUE_MAX = 64 * 1024;        // per-value cap (frame budget)
export const SYNC_FRAME_BUDGET = 96 * 1024;     // serialized envelope cap (< transport 256 KB)
export const SYNC_MAX_ENTRIES = 150;            // per-frame entry cap
export function syncEligibleKey(k) {
    if (typeof k !== 'string' || k.length > 512) return false;
    if (!isSafeArcadeKey(k)) return false;              // shape + dunder guard
    const seg = k.slice(KEY_PREFIX.length).split('.');
    if (seg[0] === '_meta' || seg[0] === 'global') return false; // device-local / launcher-owned
    if (!seg[1] || seg[1].charAt(0) === '_') return false;       // SDK sidecars (_sync/_noExport/_migrated)
    if (seg[1] === 'ls') return false;                           // ls-proxy subtree: not synced in v1
    return true;
}
```

2. **Opt-in list** — full-key JSON array (or `["*"]` = all eligible own keys) at
   `arcade.v1.<gameId>._sync`, written by the SDK exactly like `_noExport`. A key is synced iff
   `syncEligibleKey(k)` **and** its app's `_sync` list contains `k` or `'*'`. **Inbound adoption
   rule**: when a diff for eligible key `k` is applied, the launcher appends `k` to that app's
   `_sync` list (and broadcasts `state.changed` for the list key) so replication stays
   bidirectional even before the app ran locally. Opt-in therefore replicates implicitly;
   `{sync:false}` stops *this device's* outbound only (documented).

### Peer eligibility

`knownPeers[deviceId].syncEnabled === true` (new flag, default absent=off; user toggles per pair in
the Multiplayer dialog) **and** `!isFingerprintSuspect(deviceId)`. Both sides must be on — the
engine neither sends to nor accepts from a pair whose *local* flag is off. Sync envelopes are
accepted **only from direct links with a completed identity binding** (never relayed/host-forwarded).

### Wire protocol (launcher-level envelope, `kind:'sync'`, versioned)

```js
{ arcade:1, kind:'sync', v:1, op:'digest', part:0, parts:1, entries:[[key, hlc, hash], ...] }
{ arcade:1, kind:'sync', v:1, op:'req',    keys:[key, ...] }
{ arcade:1, kind:'sync', v:1, op:'diff',   entries:[{k, h, v}, ...] }   // v: raw string; or {k, h, del:1}
```

Flow: on `onPeerIdentity({deviceId})` for a sync-enabled pair, each side sends its full digest
(chunked to ≤ `SYNC_MAX_ENTRIES` / `SYNC_FRAME_BUDGET`; `parts` lets the receiver know when the
union is complete, 30 s reassembly timeout). Receiver compares each remote entry to its RAM
mirror: remote HLC greater and hash differs → add to `req`; local HLC greater → add to `diff`;
hashes equal but HLCs differ → adopt max HLC locally, no data motion; local keys absent from the
completed remote digest → `diff`. `req` is answered with `diff`. While connected, every local
synced write ships as a one-entry live `diff` immediately.

**Apply rule (LWW)**: an inbound `diff` entry is applied iff `entry.h > local.h` (string compare;
absent local = apply). Apply = `localStorage.setItem/removeItem` + record `{h, x, del}` +
`host.postToIframe(appId, {type:'arcade:state.changed', key, value})` + `_sync`-list adoption.
**Never** routes back through `noteLocalWrite` (no echo).

**Inbound validation (every field, before anything touches storage)**: `env.v === 1`; `op` in
allowlist; `entries`/`keys` are arrays with length ≤ `SYNC_MAX_ENTRIES`; every key passes
`syncEligibleKey` (covers dunder smuggling + namespace escape); every `h` matches `HLC_RE`; every
`hash` is `/^[0-9a-f]{64}$/`; every `v` is a string ≤ `SYNC_VALUE_MAX`; serialized inbound frame
already capped by transport. A malicious-but-paired device can thus only write *eligible app keys*
with *bounded values* — it cannot touch `_meta`, `global.*`, other sidecars, qrp2p stores, or
pollute prototypes. Quota failures on apply are caught and logged (`ArcadeDiag.log('sync', ...)`).

**onConflict ("concurrent" pragmatically)**: when an applied remote entry discards a local value
whose record was authored by *this* device (`local.h` ends in my deviceId) **and**
`local.h > cursor(peer).hlc` (peer had not seen our edit) **and** hashes differ → fire conflict
`{key, mine, theirs}`: launcher-level listeners (`window.__arcade.sync.onConflict`) +
`postToIframe(appId, {type:'arcade:sync.conflict', key:<unprefixed>, mine, theirs})`. The losing
side fires; the winning side stays silent (its peer fires symmetrically).

---

## WP1 — Pure core: `arcade-sync-core.js` + predicates in core + Node unit test

**New `arcade-sync-core.js`** (ES module, zero top-level side effects — Node-importable like
`arcade-storage-core.js`). Exports:

```js
export const SYNC_PROTOCOL_V = 1;
export const SYNC_DB = 'arcade-sync';
export const SYNC_TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;
export const SYNC_TOMBSTONE_CAP_PER_APP = 512;
export const HLC_RE = /^\d{13}:\d{4}:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|dev-[a-z0-9]{6,50})$/i;
export function hlcPack(millis, counter, deviceId) { ... }
export function hlcParse(s) { ... }                       // null on non-match
export function hlcCompare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
export function hlcNext(prev, nowMs, deviceId) { ... }    // monotonic issue
export function hlcRecv(prev, remote, nowMs, deviceId) { ... } // receive-advance
export async function sha256Hex(str) { ... }              // crypto.subtle (Node 20+)
export function chunkEntries(entries, maxEntries, budgetBytes) { ... } // → [[...],[...]]
export function planFromDigest(localMap, remoteEntries) { ... }
    // → { need: [keys], send: [keys], adopt: [[key, hlc]] }
export function applyDecision(localRec /*|undefined*/, remoteEntry) { ... }
    // → 'apply' | 'skip' | 'adopt-hlc'
export function isConcurrentLoss(localRec, cursorHlc, myDeviceId) { ... }
export function validateSyncEnvelope(env, caps /*{maxEntries,valueMax}*/) { ... }
    // → { ok:true, op } | { ok:false, reason:'bad-v'|'bad-op'|'too-many'|'bad-key'|'bad-hlc'|'bad-hash'|'bad-value' }
```

Import `syncEligibleKey` from `arcade-storage-core.js` inside `validateSyncEnvelope`
(pure-imports-pure is fine; both Node-clean).

**Edit `arcade-storage-core.js`**: add the `SYNC_*` constants + `syncEligibleKey` block verbatim
from the Design section, placed after `bridgeKeyWritable` (:91-97). Update the header comment
(:5-12) to name sync eligibility as one of the allowlists living here.

**New `tools/sync-unit.mjs`** (style: `tools/rendezvous-unit.mjs` — `ok(cond,label)`, exit 1 on
fail). Cover: pack/parse/HLC_RE round-trip; `hlcNext` monotonic when `nowMs` regresses 10 s;
counter overflow bumps millis; `hlcCompare` orders by millis→counter→deviceId; `hlcRecv` advances
past remote; `syncEligibleKey` matrix (accept `arcade.v1.myapp.save1`; reject `_meta.deviceId`,
`global.theme`, `myapp._sync`, `myapp._noExport`, `myapp.ls.x`, `arcade.v1.__proto__.x`,
other-shape, >512 chars); `planFromDigest` (need/send/adopt partitioning incl. local-only keys);
`applyDecision` (newer applies, older skips, equal-hash adopts); `isConcurrentLoss` true only for
own-authored unreplicated records; `validateSyncEnvelope` rejects each malformed field class +
oversize; `chunkEntries` respects both caps; `sha256Hex` determinism. Also assert
`STORE_DB_RE.test('arcade-sync') === false` (export can never pick up the sync DB).

**Plumbing**: `package.json` add `"sync-unit": "node tools/sync-unit.mjs"` (after `"save-unit"`
:15); `pages.yml` add step `node tools/sync-unit.mjs` after the save-validation step (:41-42) and
add `arcade-sync-core.js` to the syntax-check list (:31-33 — `arcade-sync.js` gets added in WP3,
the WP that creates it).

**Verify**: `node --check arcade-sync-core.js && node --check arcade-storage-core.js && npm run sync-unit && npm run save-unit`
(save-unit proves core still imports clean in Node).

---

## WP2 — SDK surface: `{sync:true}` + `Arcade.sync` (`arcade-sdk.js`)

1. **Sticky flag** — mirror `setKeyExportable` (:1413-1425) directly below it:

```js
function syncListKey() { return gameKey('_sync'); }
function setKeySyncable(fullKey, on) {
    var list = readJSON(syncListKey());
    if (!Array.isArray(list)) list = [];
    var i = list.indexOf(fullKey);
    if (on && i === -1 && list.indexOf('*') === -1) { list.push(fullKey); writeJSON(syncListKey(), list); }
    else if (!on && i !== -1) { list.splice(i, 1); writeJSON(syncListKey(), list.length ? list : undefined); }
}
```

2. **`stateApi.set`** (:1450-1461): inside the existing `if (ok)` block, alongside the
   `opts.exportable` branch (:1455-1457), add:

```js
if (opts && typeof opts.sync === 'boolean') setKeySyncable(k, opts.sync);
```

(`state.remove` :1462-1468 needs no change — the bridged null write becomes a launcher-side
tombstone in WP3.)

3. **`syncApi`** — new, near `globalApi` (:1605):

```js
var syncApi = {
    // enable() → sync every current & future own key ('*'); enable(['k1','k2']) → those keys.
    enable: function (keys) {
        ensureGameId();
        if (keys === undefined) { writeJSON(syncListKey(), ['*']); return; }
        (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { setKeySyncable(gameKey(String(k)), true); });
    },
    disable: function (keys) {
        ensureGameId();
        if (keys === undefined) { writeJSON(syncListKey(), undefined); return; }
        (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { setKeySyncable(gameKey(String(k)), false); });
    },
    list: function () { ensureGameId(); var l = readJSON(syncListKey()); return Array.isArray(l) ? l.slice() : []; },
    // fn({ key, mine, theirs }) — a concurrent local edit lost LWW. Informational; state already updated.
    onConflict: makeSubscriber(listeners.syncConflict)
};
```

4. **Listeners + message case**: add `syncConflict: []` to the `listeners` object (:183-197). In
   `handleMessage`'s switch, after `case 'arcade:state.changed'` (:1205-1218), add:

```js
case 'arcade:sync.conflict':
    if (typeof data.key === 'string') {
        fire(listeners.syncConflict, { key: data.key, mine: data.mine, theirs: data.theirs });
    }
    break;
```

(Launcher sends `key` already unprefixed, `mine`/`theirs` JSON-parsed-or-null.)

5. **API object** (:2566-2625): add `sync: syncApi,` after `storage: storageApi,` (:2600). Update
   the header doc block (~:37-51) with the three new lines.

**Verify**: `node --check arcade-sdk.js && npm run store-acceptance && npm run bridge-acceptance`
(SDK touched — both suites exercise it), plus quick grep `grep -n "_sync" arcade-sdk.js`.

---

## WP3 — Launcher engine `arcade-sync.js` + host hooks

**New `arcade-sync.js`** — ES module, `initSyncEngine(host)` following the `initStorageBridge(host)`
pattern (`arcade-storage-bridge.js:40`). Static imports: `arcade-sync-core.js`, from
`arcade-storage-core.js` (`KEY_PREFIX, syncEligibleKey, SYNC_LIST_RE, SYNC_VALUE_MAX,
SYNC_FRAME_BUDGET, SYNC_MAX_ENTRIES, idbOpen, idbGet, idbPut, idbAll, idbDel`), `readKnownPeers`
from `arcade-known-peers.js`, `ArcadeDiag` from `arcade-diag.js`. Returned surface:

```js
export function initSyncEngine(host) {
    ...
    return {
        noteLocalWrite,        // (key, rawValueOrNull) — from the bridge hook
        noteImportCommitted,   // (keys[]) — from arcade-save
        attachP2P,             // (ArcadeP2P) — wires onSyncEnvelope/onPeerIdentity/sendSyncEnvelope
        kick,                  // (deviceId) — start a digest exchange now (UI toggle-on)
        onConflict,            // (fn) launcher-level subscribe
        _records, _cursor      // test hooks: RAM-mirror snapshot; per-pair cursor
    };
}
```

Engine internals (all lazy behind an `ensureLoaded()` promise so visitors with no synced keys pay
~zero):

- **Init scan** (first time a synced key/peer exists): read all `_sync` lists from localStorage
  (`SYNC_LIST_RE`, parse defensively, entries must be strings) → syncable-set cache (per app: Set
  or `'*'`); load `k|` records + `clock` + `p|` cursors from `arcade-sync` IDB into RAM; GC
  tombstones (TTL + per-app cap); for each currently-synced localStorage key with no record **or**
  a hash mismatch vs its record (covers standalone-mode edits and pre-existing data), stamp a
  fresh HLC. deviceId: read `arcade.v1._meta.deviceId`, mint-and-store via `crypto.randomUUID()`
  if absent (mirrors `arcade-p2p.js:180-203`; format passes `DEVICE_ID_RE`).
- **`noteLocalWrite(key, value)`**: if `key` matches `SYNC_LIST_RE` → refresh that app's
  syncable-set (and re-scan for newly-synced keys to stamp). Else if key is synced → stamp
  `hlcNext`, hash, upsert record (write-through), and if any attached peer is sync-enabled +
  `connectionState(deviceId)` is `'connected'`/`'interrupted'` → send live one-entry `diff`
  (values > `SYNC_VALUE_MAX` are **not** sent; log once per key via ArcadeDiag). `value === null`
  → tombstone record + `del:1` diff.
- **`noteImportCommitted(keys)`**: re-stamp every imported key that is synced (an import is a
  deliberate local edit "now").
- **`attachP2P(p2p)`**: `p2p.onSyncEnvelope((fromDeviceId, env) => handleInbound(...))`;
  `p2p.onPeerIdentity(({deviceId}) => maybeStartExchange(deviceId))`; keep the `p2p` ref for
  `sendSyncEnvelope`/`connectionState`. `maybeStartExchange` gates on
  `readKnownPeers()[deviceId]?.syncEnabled === true`, dedupes in-flight per device (30 s timeout).
- **`handleInbound`**: gate `readKnownPeers()[fromDeviceId]?.syncEnabled === true`;
  `validateSyncEnvelope`; then per op — digest parts → reassemble → `planFromDigest` → send `req`
  + `diff` chunks; `req` → `diff` of requested *synced* keys; `diff` → per entry `applyDecision`,
  apply as in Design (localStorage write in try/catch, record,
  `host.postToIframe(appId, state.changed)`, `_sync`-list adoption + its own `state.changed`,
  conflict check via `isConcurrentLoss` + cursor). On exchange completion update `p|<deviceId>`
  cursor.

**Edit `arcade-storage-bridge.js`** — `handleBridgedStateWrite` (:96-121): after the successful
`try { ... setItem/removeItem }` block (:104-110), before the `shared` check (:113), add:

```js
if (host.onStateWritten) { try { host.onStateWritten(gameId, key, value); } catch (e) {} }
```

**Edit `arcade-save.js`** — `importSaveFile`: after the localStorage commit block (:429-438),
before the reseed loop (:455-457), add:

```js
if (host.onImportCommitted) { try { host.onImportCommitted(cleanKeys); } catch (e) {} }
```

**Edit `index.html`**:
- `__arcade` literal (:482-512): add `sync: null` after `storage: null` (:511) with a one-line
  comment (the doc comment demands every slot listed).
- `storageHost` (:1652-1659): add two slots:

```js
onStateWritten: (gameId, key, value) => { if (window.__arcade.sync) window.__arcade.sync.noteLocalWrite(key, value); },
onImportCommitted: (keys) => { if (window.__arcade.sync) window.__arcade.sync.noteImportCommitted(keys); },
```

- Module block D (:1771-1788): add `import { initSyncEngine } from './arcade-sync.js';` and
  `window.__arcade.sync = initSyncEngine(storageHost);` **before**
  `storageHost.replayPendingStorageMessages();`.
- `loadP2P` (:982): after `window.__arcade.p2p = ArcadeP2P;` (:1183), add
  `if (window.__arcade.sync) window.__arcade.sync.attachP2P(ArcadeP2P);`.

**Plumbing now**: add `arcade-sync.js` to the pages.yml syntax list (:31-33).

**Verify**: `node --check arcade-sync.js && npm run bridge-acceptance && npm run store-acceptance && npm run export-roundtrip`
(proves the hooks are inert when sync is unused). Manual smoke: serve locally, console
`window.__arcade.storage.stateWrite('demo', {key:'arcade.v1.demo.x', value:'"1"'})` → no errors,
`window.__arcade.sync._records()` empty (no `_sync` list yet); then write
`arcade.v1.demo._sync = '["*"]'` via `stateWrite` and repeat → record appears.

---

## WP4 — P2P envelope + peer flag + dialog toggle

**Edit `arcade-p2p.js`**:
1. Module scope, next to `messageListeners` (:451):
   `const syncListeners = []; // fn(fromDeviceId, env)`.
2. In the transport `message` listener, insert **after the presence branch's closing `return;`
   (:611-612) and before `if (env.kind !== 'identity')` (:613)**:

```js
if (env.kind === 'sync') {
    // Launcher-level replication frames: direct links only (a relayed or
    // host-forwarded frame must never carry another device's sync data),
    // and only once the sender's identity binding completed.
    if (d.relayed) return;
    const syncDev = deviceIdForPeerId(d.peerId);
    if (!syncDev) return;
    for (const fn of syncListeners) { try { fn(syncDev, env); } catch (err) {} }
    return;
}
```

3. Public API (insert after `onMessage` :886-892):

```js
/** Subscribe to launcher-level sync envelopes: fn(fromDeviceId, env). Direct links only. */
onSyncEnvelope(fn) {
    syncListeners.push(fn);
    return () => { const i = syncListeners.indexOf(fn); if (i >= 0) syncListeners.splice(i, 1); };
},

/** Send a sync envelope to one paired device over its DIRECT link. */
sendSyncEnvelope(deviceId, env) {
    if (!addon || (sdkStatus !== 'connected' && sdkStatus !== 'interrupted')) return false;
    const pid = deviceIndex.get(deviceId);
    if (pid === undefined || !seatReachable(pid)) return false;
    return addon.sendTo(pid, { ...env, arcade: 1, kind: 'sync' });
},
```

4. Update the wire-envelope header comment (:14-18) to list the `kind:'sync'` shape.

**Edit `arcade-known-peers.js`**: add after `setKnownPeerPaused` (:59-65):

```js
/** Per-pair opt-in for Arcade.sync state replication. */
export function setKnownPeerSyncEnabled(id, on) {
    return mutateKnownPeers((map) => {
        if (!map[id]) return null;
        map[id].syncEnabled = !!on;
        return map;
    });
}
```

Extend the entry-shape doc comment (:10-16) with `syncEnabled?`.

**Edit `index.html` connections dialog** (module block at :1790): import
`setKnownPeerSyncEnabled` alongside the existing imports (:1807); in `buildRow`'s icon group,
after the `autoBtn` block (:1953-1978), add a `syncBtn` icon button following the same shape:
`🔄`/`⛔` on `peer.syncEnabled === true`, title
`'App-data sync is ON/OFF — tap to toggle (both devices must turn it on)'`, aria-label, click
handler: `setKnownPeerSyncEnabled(id, !on); if (!on && window.__arcade.sync) window.__arcade.sync.kick(id); render();`.

**Verify**: `node --check arcade-p2p.js arcade-known-peers.js && npm run p2p-acceptance && npm run p2p-reconnect && npm run p2p-multiseat`
(envelope insert must not disturb game routing/presence/identity paths).

---

## WP5 — Browser acceptance: `tools/sync-acceptance.mjs`

Uses `startP2PHarness({ port: 4792, dropPort: 4793 })` + `makeCheck`. Borrow
`freshPair`/`pairBoth`/`FAST_RDV` verbatim from `tools/p2p-reconnect-acceptance.mjs:27-73`. Helper
to enable sync on a page for its (single) known peer:

```js
const enableSync = (page) => page.evaluate(async () => {
    const { setKnownPeerSyncEnabled, readKnownPeers } = await import('./arcade-known-peers.js');
    const id = Object.keys(readKnownPeers())[0];
    setKnownPeerSyncEnabled(id, true);
    window.__arcade.sync.kick(id);
    return id;
});
```

Drive writes through the **production bridge path** without an iframe:
`window.__arcade.storage.stateWrite('syncfix', { key, value })` (calls `handleBridgedStateWrite`
→ `host.onStateWritten` → engine). Seed the opt-in list the same way
(`key:'arcade.v1.syncfix._sync', value:'["*"]'`). Scenarios:

1. **Live replication both ways**: pair, enable both sides, write `arcade.v1.syncfix.a='"1"'` on H
   → poll `J.evaluate(() => localStorage.getItem('arcade.v1.syncfix.a'))` === `'"1"'`; write `b`
   on J → lands on H; `_sync` list adopted on the side that never wrote it.
2. **Converge after reconnect, newer wins**: reload J (kills the link; resume-on-launch heals —
   reconnect suite scenario 1 pattern, :118-134); while J is down write `a='"H2"'` on H, then
   after J's page is back but before heal completes write `a='"J3"'` on J (later wall clock ⇒
   larger HLC); wait both `connected`; poll both sides read `'"J3"'`.
3. **Restart survival**: after scenario-2 state, reload J again, assert
   `window.__arcade.sync._records()` still holds the key's record post-reload (IDB persisted),
   heal, write on H, converge.
4. **onConflict fires on the losing side**: register
   `window.__syncConflicts=[]; window.__arcade.sync.onConflict(c => window.__syncConflicts.push(c))`
   on both; sever via reload, edit the *same* key on both while apart, heal; assert exactly the
   lower-HLC side got a conflict `{key:'arcade.v1.syncfix.a', ...}` and both converged.
5. **Excluded keys never sync**: on H write (direct `page.evaluate` localStorage for the _meta
   case) `arcade.v1._meta.deviceName`, `arcade.v1.global.theme` via stateWrite, an
   `arcade.v1.syncfix._noExport` sidecar, and an eligible-but-unlisted app key under a second app
   id with no `_sync` list; heal/kick; assert none appear on J and J's `_records()` has no entries
   for them. Also assert a hostile inbound frame is refused:
   `H.evaluate(() => window.__arcade.p2p.sendSyncEnvelope(<J-id>, { v:1, op:'diff', entries:[{ k:'arcade.v1._meta.deviceId', h:'9999999999999:0000:dev-evil01', v:'"x"' }] }))`
   → J's `_meta.deviceId` unchanged.
6. **Tombstone**: `stateWrite('syncfix', {key, value:null})` on H → key removed on J; J's record
   shows `del:1`; after J reload+heal the delete does not resurrect.
7. **Export exclusion**: `H.evaluate` that
   `(await indexedDB.databases()).some(d => d.name==='arcade-sync')` is true; the structural
   guarantee (`STORE_DB_RE` never matches `arcade-sync`) is asserted in `sync-unit` (WP1), so keep
   this browser check minimal.

**Plumbing**: `package.json` `"sync-acceptance": "node tools/sync-acceptance.mjs"`; `pages.yml`
step after the reconnect step (:104-116) with the same 3-attempt retry wrapper (it drives real
WebRTC).

**Verify**: `npm run sync-acceptance` green 3× locally.

---

## WP6 — Chrome + docs + final pass

- **`sw.js`**: `CACHE_NAME` `'paul-arcade-v30'` → `'paul-arcade-v31'` (:1); add
  `'./arcade-sync-core.js', './arcade-sync.js'` after `'./arcade-save.js'` (:17).
- **`GAME_INTEGRATION.md`**: §3 storage — document `{ sync:true }` next to the
  `{exportable:false}` bullet (:117-120); new short §3b "Multi-device sync — Arcade.sync"
  (enable/disable/list/onConflict, LWW semantics, 64 KB value cap, what never syncs, "user must
  enable per pair in Multiplayer"); wire summary §14 (:825+) — add
  `parent → child: arcade:sync.conflict { key, mine, theirs }`.
- **`ARCADE_PLATFORM.md`**: SDK shape block (:25-52) — add the `Arcade.sync.*` lines;
  storage-convention table (:299-310) — add row
  `Device-local sync metadata | IndexedDB 'arcade-sync' | launcher only; never exported`; new
  subsection under the Multiplayer section describing the `kind:'sync'` envelope beside the
  `kind:'identity'` doc (:264), the digest/diff protocol, and the trust posture (paired+opted-in
  devices gain bounded write authority over eligible app keys). `p2p/PROTOCOL.md` needs **no**
  change — sync is a launcher-level envelope like `identity`, invisible to the transport (note
  this in the PR description).
- **Final pass**: full CI-matching suite set —
  `npm run rendezvous-unit && npm run save-unit && npm run sync-unit && npm run p2p-core-unit && npm run store-acceptance && npm run sdk-helpers && npm run bridge-acceptance && npm run export-roundtrip && npm run catalog-acceptance && npm run acceptance:pool && npm run p2p-acceptance && npm run p2p-multiseat && npm run p2p-reconnect && npm run sync-acceptance`.

---

## Migration order (verify after each step)

1. WP1 core + unit test (`sync-unit` green; nothing else touched).
2. WP2 SDK (`store-acceptance`, `bridge-acceptance`).
3. WP3 engine + hooks, launcher wiring (`bridge-acceptance`, `store-acceptance`,
   `export-roundtrip` — hooks inert without opt-in).
4. WP4 p2p envelope + flag + toggle (`p2p-acceptance`, `p2p-reconnect`, `p2p-multiseat`).
5. WP5 acceptance suite + CI wiring (`sync-acceptance` ×3).
6. WP6 sw.js bump + docs + full pass.

## Risks

1. **Adoption rule widens write surface**: a paired, sync-enabled peer can create keys in any
   *eligible app namespace* on this device (bounded: `syncEligibleKey`, 64 KB values, no
   sidecars/`_meta`/`global`). This is inherent to the feature (own-device trust); the per-pair
   user toggle + fingerprint-suspect gate are the mitigations. Documented in ARCADE_PLATFORM.md
   trust model.
2. **Deviation from issue sketch**: `{exportable:false}` is *not* reused as the don't-sync signal
   — sync is opt-in via a separate `_sync` list, and `{sync:false}` only stops outbound from this
   device (inbound adoption can re-list a key). Documented limitation.
3. **Wall-clock skew** between devices biases LWW toward the fast-clock device. HLC bounds
   regressions locally but not cross-device skew; acceptable for v1 (document: "newer-wins by
   device clock, ties by deviceId").
4. **Engine runs in module block D for every visitor** — mitigated by the `ensureLoaded()` lazy
   gate (no `_sync` list ⇒ no IDB open, no scans).
5. **Digest size** for pathological key counts: chunking caps frames at 96 KB/150 entries;
   hundreds of keys ⇒ a few frames. Values > 64 KB silently don't sync (logged) — the documented
   v1 cut; v2 would ride a sendBlob-style chunked path.
6. **`state.replaced` after import** re-stamps all synced keys "now" (`noteImportCommitted`) — an
   import therefore wins over older remote edits on next sync, which matches user intent but
   should be stated in docs.
7. **Suite flakiness**: sync-acceptance drives real WebRTC + rendezvous heal; wrapped in the same
   3-retry CI pattern as the other p2p suites.

## Explicitly deferred (v2, note in docs/PR)

- `Arcade.store`/`Arcade.files` blob sync (needs digests over IDB + chunked transfer).
- `global.*` settings sync and the `.ls.` proxy subtree.
- Values > 64 KB (would ride a sendBlob-style chunked path).
- Mesh anti-entropy/gossip — v1 is pairwise; transitive convergence follows from LWW determinism.
- Any launcher UI beyond the per-pair dialog toggle.
