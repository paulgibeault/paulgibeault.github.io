# Framework Review & Implementation Plan — 2026-07

A prioritized, actionable remediation plan from the four-subsystem review of the
`multiplayer-ux` branch (SDK, launcher, P2P transport/bridge, rendezvous/tooling).

**How to use this doc:** work top-down by phase. Each item has a stable ID
(`P1-a`, `B-sdk-1`, …), a file:line anchor, the fix, and a checkbox. IDs are
referenced across items where fixes share a root cause — prefer the structural
refactors in Phase 4, which delete whole classes of the bugs above them.

**Overall verdict:** well-engineered platform. Trust architecture is sound
(opaque-origin frames, launcher-derived bridge paths, 10-gate import), rendezvous
crypto is clean, test culture is real. Problems cluster in four areas: this
branch's UX change breaks the transport's topology model; state-lifecycle bugs
(stale bindings, mid-iteration mutation, races across `await`); security-spec
drift; and a structurally broken in-arcade offline story.

Legend: 🔴 blocker · 🟠 high · 🟡 medium · ⚪ low · 📄 docs

---

## Implementation status (updated 2026-07-14)

**Landed and validated** (all acceptance suites green: store, bridge, export,
p2p, multiseat, reconnect):

- **Phase 1 — all six blockers.** Role-gated Host/Join + transport role-flip
  guards (`createOffer`/`createAnswer` throw on a flip with live links);
  ceremony completion keyed on the ceremony's own peerId; accessible live region
  for reconnect state; message toast gated on mounted games; watermark no longer
  shimmers for abandoned offers; copy fix. Plus B-p2p-3 (`_startOver` via
  `disconnectPeer`) and B-p2p-8 (Escape-listener leak).
- **Phase 2 SDK** — B-sdk-1 (snapshot dispatch), B-sdk-2 (framed-adopt data-loss
  guard), B-sdk-3/4/6/9 (blob keyed by `fromPeer|id`, size caps, corrupt/dead
  handling), B-sdk-5 (paced `sendBlob`, real progress), B-sdk-7/8/10/11/12/13/14,
  S-sdk-1 (getOrInit persists + clones).
- **Phase 2 rendezvous** — B-rdv-1 (day-topic refresh), B-rdv-2 (slot-race guard),
  B-rdv-3/4/5 (serialized delete/reads + tombstone), B-rdv-6, carrier ping-race.
- **Phase 2 bridge/core** — B-p2p-1 (departed-seat prune + `seatReachable`
  gating), B-p2p-2 (relay appends to `sessionStash`).
- **Phase 3 security** — S-sec-1/S-sec-2 (rebind-hijack guards, strict live-link
  check), S-sec-3 (blob abort/poison via `fromPeer|id`), S-sec-4b (decrypt
  rate-limit), S-sec-6 (store/files bridge size caps), B-lnc-2 (import can't
  overwrite TOFU trust records).
- **Phase 5 gaps** — G-off-1 (resilient SW install, network-first + timeout +
  runtime cache), G-ux-1 (iframe loading veil + error card), G-res-1
  (`_meta.rdvBrokers`), **G-mp-1 toolkit** (`peer.request`/`onRequest`,
  `Arcade.random.seeded`, `state.keys`/`has`, targeted `sendBlob({to})`),
  B-lnc-1 (ls-proxy keys ride save bundle + size cap), B-lnc-4 (SW fetch).
- **Phase 6 CI** — T-1 (reconnect suite wired into `pages.yml`).
- **Phase 7 docs** — D-1 (PROTOCOL.md frozen-ratchet honesty in §7.2/7.4/7.5/8),
  D-2 (GAME_INTEGRATION.md framed adopt/migrate + `set()` return), D-3 (ARCADE_
  PLATFORM.md duplicate section removed, README message-count, new-API docs).

**Landed in a second pass (also validated):** T-2/T-3 (crypto + MQTT-codec
unit tests — `tools/rendezvous-unit.mjs`, 32 checks, wired into CI as an
early no-browser gate); B-p2p-5 (per-peer `rdvReconnecting` Set); S-sec-5 (SDP
token/CRLF validation on unpack); S-sdk-3 (scores order sticks to category),
S-sdk-4 (corrupt-JSON warn-once), S-sdk-5 (warn on `ready` before `init`);
G-ux-2 (non-blocking `window.__arcade.dialog` replacing the P2P confirm/prompt
that froze the heartbeat); G-ux-3 (tappable message toast).

**Phase 4 landed (validated across all P2P suites):**

- **P4-a — unified seat record** (`arcade-p2p.js`). Four parallel structures
  (`identityLinks`, `announcedTo`, `autoPairMintedFor`, and the linear reverse
  lookup) collapsed into one `seats` Map keyed by peerId (`{deviceId, announced,
  minted}`) + an O(1) `deviceIndex` reverse map. One `dropSeat`/`unbindDevice`
  owns a seat's whole lifecycle; `deviceIdForPeerId` is now O(1). `indirectPeers`
  stays separate (it's relay-tag-keyed, not peerId-keyed).
- **P4-b/c** — already covered by the `_renderBadge`/`_renderChoiceButtons`
  helpers and the per-peer `rdvReconnecting` Set added earlier.
- **P4-e — transport `statusSummary()`**: the connection-liveness snapshot moved
  onto `PeerManager`, so the UI's `_connectionState()` no longer iterates
  `peerNode.peers`/`sessionStash` directly.

**Landed in a third pass (2026-07-14, `multiplayer-refactoring` branch — all
suites green: store, bridge, export, p2p, multiseat, reconnect, plus the new
save-validation unit test):**

- **P4-d — storage/save extraction.** The ~1,000-line storage-bridge +
  save/import block is out of `index.html` (2936 → 2145 lines) into three ES
  modules: `arcade-storage-core.js` (the single audit surface for every key
  allowlist / size cap / checksum / IDB helper), `arcade-storage-bridge.js`
  (`initStorageBridge(host)` — ls-proxy + state/store/files/storage ops), and
  `arcade-save.js` (`initSaveLoad(host)` + a pure, Node-testable
  `validateSaveBundle`). The launcher's single message router keeps the #50
  trust boundary and delegates authenticated messages through
  `window.__arcade.storageHost` with a pending-message queue. Folded in the
  S-lnc dedup (`readKnownPeers` for `resolvePeerName`/`tryResumeOnLaunch`). New
  `tools/save-validation-unit.mjs` (35 checks) + sw.js v28.
- **S-sec-4a — persistent cross-episode replay cache.** Bounded per-pair nonce
  FIFO (`rec.seenNonces`, cap 512) in the IDB pairing record, seeded into every
  episode and checked at the offer/ring sites; PROTOCOL.md §7.2/7.4/§8 updated —
  cross-episode replay is now defended and no longer depends on the ratchet.
- **T-4 — harness carrier hooks + scenarios.** Added `ensureAlive`/`onSessionUp`
  + a sever/restore control to the test carrier; three new reconnect scenarios
  (carrier sever→onSessionUp heal, day-topic rollover / B-rdv-1, replay-cache
  white-box).
- **S-sdk-2/6, D-4.** `peer.remote()` doc-deprecated (SDK + GAME_INTEGRATION.md);
  SDK dedup (one monotonic clock helper, `onStorageError` via `makeSubscriber`,
  cached `devModeOn`); shipped items ticked in framework-evolution.md /
  implementation-roadmap.md.

**Still open (genuinely deferred):** S-sec-4b→ nothing further; TURN config for
G-res-1 (#33); the per-game `acceptance.mjs` + `--pool` CI wiring (needs a
catalog-registered fixture, issue #40); the multi-pair concurrent-rendezvous
harness scenario (T-4's stretch item).

---

Legend below is the original plan; the boxes are not individually re-ticked —
use the status summary above.

---

## Phase 1 — Block the `multiplayer-ux` merge until these land

- [ ] **P1-a 🔴 Role-gate Host/Join while a link is live.**
  `p2p/p2p-ui.js:359-360, 405-407, 721-723`. The branch makes both buttons
  always visible and claims "each ceremony is a fresh, standalone connection" —
  false: `PeerManager` has one `peers` map, one global `isHost` (`p2p-core.js:1057`
  `createOffer`→true, `:1098` `createAnswer`→false), one relay loop
  (`:588-592`). A host tapping Join flips `isHost=false` and silently kills the
  relay for existing joiners; a joiner tapping Host becomes an accidental chain
  relay. **Fix:** while `peers.size > 0` or `sessionStash` non-empty, show only
  the role-consistent button (Host for `isHost` nodes; Join only when no
  live/stashed link exists). Belt-and-braces: `createOffer()` throws if
  `!isHost && peers.size`; `createAnswer()` throws if `isHost && peers.size`
  (never reassign the role).

- [ ] **P1-b 🔴 Key ceremony completion on the ceremony's own peerId.**
  `p2p/p2p-ui.js:705-735` (host), `736-763` (joiner). Completion is keyed on
  aggregate `connectedCount`, so any status event (peer #1 recovering from a
  wobble, peer #2's own `checking` ICE event) during a second ceremony runs
  `cleanupUI()` + `hide()` and marks `_setStage(2,'done')` for the wrong peer;
  a later failure of ceremony #2 is invisible. **Fix:** record the peerId minted
  by `createOffer`/`createAnswer`; complete/cleanup/hide only when *that* peerId
  reaches `connected`. Drive the badge from the aggregate separately (feeds P4-b).

- [ ] **P1-c 🟠 Restore accessible signal for `interrupted`.**
  `index.html:441` (watermark is `aria-hidden="true"`), `950-951` (toast removed).
  Screen-reader users now hear "reconnected!" for interruptions they were never
  told began. **Fix:** give the watermark label `aria-live="polite"` (changes a
  few times per episode, not chatty), or mirror state into a visually-hidden
  live region.

- [ ] **P1-d 🟡 Gate the cross-game message toast on mounted games.**
  `index.html:1050-1062, 1073`. `maybeMessageToast` runs before routing, so it
  announces "💬 Alice — P2P Chat" when that game isn't mounted and the message
  was dropped; `resolveGameTitle` also builds a `querySelector` from a
  wire-supplied gameId (`arcade-p2p.js:541`, only `typeof`-checked, unbounded).
  **Fix:** gate on `pool.has(targetGameId) && helloedGames.has(targetGameId)`
  and read the title from `pool.get(targetGameId).name` — removes the selector,
  the spoof surface, and the misleading toast in one move. (Then P5-d: make the
  toast tappable to `showGame`.)

- [ ] **P1-e ⚪ Watermark stops pulsing after an abandoned ceremony.**
  `index.html:1677-1679` + `p2p-ui.js:467-470`. A pending offer keeps the corner
  mark shimmering "connecting…" for up to the 5-min transport timeout. **Fix:**
  only show the watermark for `connecting` when `everConnected`/interrupted-repair
  or when an episode is actually running — not for a mere pending offer.

- [ ] **P1-f ⚪ Fix leftover copy.** `p2p/p2p-ui.js:800` still says
  `'📤 Can't scan? Send a reply link instead'` after the de-emojification pass
  changed the parallel string (`:231`).

---

## Phase 2 — Correctness bugs (data-loss / silent-corruption first)

### SDK (`arcade-sdk.js`)

- [ ] **B-sdk-1 🟠 Snapshot listener arrays before dispatch.**
  `430-442, 926-931, 985-987`. `fire()` iterates live arrays while managed timers
  detach from inside their own callbacks — two pending `session.setTimeout` timers
  + a save import → only the first is cancelled; the second fires against
  post-import state. **Fix:** `var snap = arr.slice()` in all four loops.

- [ ] **B-sdk-2 🟠 `state.adopt()` orphans legacy saves in framed mode.**
  `1242` with `1154-1164, 1222-1226`. Raw `localStorage` read throws in an opaque
  frame → `adopt()` returns false silently → `migrate()` writes the completion
  sentinel anyway → the standalone visit that *could* migrate is skipped forever.
  The only permanent-data-loss finding. **Fix:** add an `arcade:state.adopt`
  bridge op (launcher holds origin storage) **or** have `runMigration` withhold
  the sentinel when any adopt was blocked by inaccessibility. Also update the doc
  example (see D-2). Also: `adopt` reads `existing` via raw `getItem` (`1246`)
  instead of `rawGet`.

- [ ] **B-sdk-3 🟡 Blob transfers keyed by `id` alone — cross-peer poison/abort.**
  `688-702, 726-733`. Multi-seat: guessable ids (`'b'+counter+'-'+Date.now()...`);
  any peer can abort or inject chunks into another seat's transfer. **Fix:** key
  `blobRx` by `fromPeer + '|' + id`; require `st.fromPeer === fromPeer` in
  `handleBlobAbort`. (Same root as B-p2p-8 / S-sec-3.)

- [ ] **B-sdk-4 🟡 No per-chunk/total-size cap on incoming blobs (memory DoS).**
  `683-708`. Chunk *count* is capped (2048) but not `meta.bytes`. **Fix:** reject
  chunks whose decoded length exceeds `BLOB_CHUNK_BYTES` (+slack); drop entries
  exceeding `meta.size`.

- [ ] **B-sdk-5 🟡 `sendBlob` has no backpressure; `onProgress` is fictional.**
  `1398-1424`. All chunks `postMessage`d in one synchronous loop (up to ~128 MB
  of strings); progress renders 0→100% in one frame; guaranteed outbox overflow
  above ~48 MB (`outboxLimit:1000`, `p2p-core.js:730-739`), which trips
  `outboxOverflowed` and tells every game to resync. **Fix:** pace the loop
  (`await setTimeout(0)` every N chunks) and/or cap `BLOB_MAX_CHUNKS` at a safe
  fraction of `outboxLimit` (~512). Longer-term: launcher→SDK drain signal.

- [ ] **B-sdk-6 ⚪ Corrupt base64 chunk dies with no `onBlobError`.**
  `703-705` — `catch { delete blobRx[id]; return; }`. Contradicts the #41 goal;
  TTL never fires (entry deleted). **Fix:** `fireBlobError(id, st, 'integrity',
  fromPeer)` before returning; remember the dead id briefly so retransmits don't
  resurrect a ghost entry.

- [ ] **B-sdk-7 ⚪ Loading the SDK twice throws `TypeError`.**
  `2207-2211` (`defineProperty ... configurable:false`). **Fix:** `if (window.Arcade) return;` at the top of the IIFE.

- [ ] **B-sdk-8 ⚪ Memory-mode write past 500 logs a misleading warning forever.**
  `306-314`. **Fix:** warn once; memory-mode-specific message when `readyResolved && !framed`.

- [ ] **B-sdk-9 ⚪ Duplicate `arcade:welcome` clobbers newer local writes.**
  `842-864, 754-786`. **Fix:** add a `welcomed` flag; ignore/log duplicates.

- [ ] **B-sdk-10 ⚪ `remotePeers` grows without bound.** `192-204`. **Fix:** prune
  entries absent from an applied roster.

- [ ] **B-sdk-11 ⚪ Listener exceptions swallowed by empty catches.**
  `433, 440, 929, 986, 1760, 1765, 1960, 1999`. **Fix:** keep isolation, add
  `console.error('[Arcade SDK] listener threw:', e)`.

- [ ] **B-sdk-12 ⚪ `for await` in `files.list()` breaks ES5 parse target.**
  `2081-2089` — one async-iteration construct makes the *entire* SDK fail to
  parse on older engines. **Fix:** rewrite with `.then()` recursion over
  `dir.entries()`, or formally drop the ES5 discipline (decide one).

- [ ] **B-sdk-13 ⚪ `applySettings` accepts `fontScale <= 0`.** `484-486` — blanks
  all rem-sized text. **Fix:** clamp 0.5–3.

### Launcher (`index.html`, `sw.js`)

- [ ] **B-lnc-1 🟡 ls-proxy accepts keys the export allowlist drops → silent backup loss.**
  `1225-1229` (setItem) vs `715`/`1981` (`KEY_RE`/`collectArcadeKeys`) vs `2131`.
  A game with a space/colon/`/` in a native key writes and round-trips fine but is
  excluded from every export and rejected on import. Also no `BRIDGE_VALUE_MAX` on
  this path. **Fix:** encode ls-proxy sub-keys into the allowed charset (or widen
  `collectArcadeKeys` handling of the `.ls.` subtree, still dunder-guarded); apply
  the `state.write` value cap.

- [ ] **B-lnc-2 🟡 Import can overwrite TOFU trust records.**
  `715 + 2130-2135 + 2190`. Checksum is integrity, not authenticity; a crafted
  save can replace fingerprint pins / `autoReconnect` in `knownPeers` and swap
  `deviceId` (desyncs `myDeviceIdCache`). **Fix:** exclude `_meta.knownPeers`/
  `_meta.deviceId` from the import *write* set (keep exporting for inspection), or
  gate behind a second explicit confirm ("also restore device identity & trusted
  connections?"). (Security; also listed S-sec-2.)

- [ ] **B-lnc-3 ⚪ Relaunch within the retire grace can snapshot stale state.**
  `810-823 + 1521-1532`. A same-gameId relaunch inside the 250 ms flush window
  takes its `arcade:hello` snapshot before the retiree's suspend-flush lands.
  **Fix:** on `ensureIframe`, if a retiring same-gameId entry exists, delay the
  welcome (or resend `arcade:state.replaced`) until the grace expires.

- [ ] **B-lnc-4 ⚪ sw.js fetch fallback rejects with `undefined`; query navigations miss cache.**
  `sw.js:76-78`. **Fix:** `fetch(req).catch(async () => (await caches.match(req,
  {ignoreSearch: req.mode==='navigate'})) || Response.error())` + a
  `req.method==='GET'` guard.

### Rendezvous (`p2p/rendezvous.js`, `rendezvous-carriers.js`)

- [ ] **B-rdv-1 🟠 Episodes go deaf on UTC day rollover.**
  `rendezvous.js:978`. Topics computed once at episode start (yesterday/today/
  tomorrow), no resubscribe timer; publishers rotate daily (`:1074, :1279`), so a
  left-open device is uncallable within ~24-48h despite the 30-day standby promise.
  **Fix:** daily timer (or the existing slow republish tick / `nudgeAll`) that
  recomputes `_topics(ep)`, subscribes new day topics, unsubscribes aged ones
  (`ep.unsubs` bookkeeping exists). Add a fake-clock test (T-4).

- [ ] **B-rdv-2 🟠 `_startEpisode` slot race across the `dbGet` await.**
  `935-955`. Guard checked before `await dbGet` (`937`); `episodes.set` runs after
  more awaits (`955`). Two overlapping triggers (terminal `disconnected` vs user
  Call, or `_failEpisode` rearm vs status) both build episodes; the second
  overwrites the first in the map — the orphan's carriers redial forever and it
  publishes offers with a *different nonce* than the survivor (the exact failure
  `_promoteEpisode` fixed). **Fix:** claim the slot synchronously
  (`episodes.set(pairId, PENDING)`) before the first await, or route per-pair
  through the `_serial` mutex; re-check after reads.

- [ ] **B-rdv-3 🟡 `disablePair` bypasses `_recWrites` — revoked secret can resurrect.**
  `384` (`await dbDelete` direct) vs `_commitPairing`/`_settleEpisode` writing
  through the queue. A queued settle runs after the delete and re-persists the
  secret the user revoked. **Fix:** route the delete through
  `_serial(this._recWrites, pairId, …)`; have `_updateRec` refuse to write behind
  a tombstone.

- [ ] **B-rdv-4 🟡 Episode-start reads race queued record writes — missed bye.**
  `937, 840` use raw `dbGet`. A just-received `bye` (queued at `604`) is missed →
  a full active repair episode is armed against a peer that deliberately hung up.
  **Fix:** wrap reads as `_serial(this._recWrites, pairId, () => dbGet(pairId))`.

- [ ] **B-rdv-5 ⚪ `ensureAlive` races the 30 s ping into spurious teardowns.**
  `carriers.js:418-432` vs `368-377`. **Fix:** timestamp the outstanding ping
  (`_pingSentAt`); both checks require `now - _pingSentAt > grace`.

- [ ] **B-rdv-6 ⚪ `destroy()` leaves `_peerLocks`/`_recWrites` queues live.**
  `245-258`. **Fix:** `_destroyed` check inside `_serial`'s runner.

### P2P bridge & core (`arcade-p2p.js`, `p2p/p2p-core.js`)

- [ ] **B-p2p-1 🟠 Departed peers never unbound → targeted sends "succeed" into a dead stash.**
  `arcade-p2p.js:505-508` (terminal handler deletes only `announcedTo`/
  `autoPairMintedFor`), `629` (bindings only added), `397` (`idle` clears
  `indirectPeers` but not `identityLinks`), `944-951` (send path). **Fix:** in the
  terminal status branch drop the `identityLinks` entry pointing at the dead
  peerId (unless a rendezvous episode is actively repairing *that* link); clear
  `identityLinks` on `idle` too. Best done via P4-a (unified seat record).

- [ ] **B-p2p-2 🟠 Host relay loop skips `sessionStash` — repair-window broadcasts lost.**
  `p2p-core.js:588-592` vs `broadcast()` `784-789`. A joiner mid-rendezvous-
  adoption misses every frame other joiners broadcast during the repair —
  breaking the exactly-once claim direct traffic honors. **Fix:** after the
  `peers.forEach`, `_stashAppend` the relayed frame to every `sessionStash` entry
  except the source.

- [ ] **B-p2p-3 🟡 `_startOver` deletes pending peers behind the transport's back.**
  `p2p-ui.js:380-387` mutates `peerNode.peers` directly (no status event) → bridge
  status can wedge on `connecting`. **Fix:** call `peerNode.disconnectPeer(id)`
  (never-connected peers aren't stashed; the terminal status event flows).

- [ ] **B-p2p-4 🟡 UI status handler ignores event `peerId` — recovering link wipes a ceremony.**
  `p2p-ui.js:705-725, 738-743`. (Same defect family as P1-b; the P4-b refactor
  resolves both.)

- [ ] **B-p2p-5 ⚪ `rdvReconnecting` is one global flag gating per-peer stash.**
  `arcade-p2p.js:97, 270-276`. With two peers, repairing A makes B's unrelated
  stash count as an `interrupted` seat. **Fix:** track reconnecting per peerId
  (rdv events carry `peerId` in `detail`).

- [ ] **B-p2p-6 ⚪ Joiner-branch badge reflects only the latest event's status.**
  `p2p-ui.js:736-763`. Resolved by P4-b. 

- [ ] **B-p2p-7 ⚪ `acceptAnswer` failure invisible — stage already `done`.**
  `p2p-ui.js:775-779` + `p2p-core.js:1141-1143`. **Fix:** return/throw a result;
  on failure set the stage to `error` and prompt a rescan.

- [ ] **B-p2p-8 ⚪ Escape keydown listener leaks in `P2PUIManager.destroy()`.**
  added `p2p-ui.js:674-678`, not removed in `destroy()` `1007-1032`. Also the
  `status`/`diagnostic` listeners on `peerNode` are never removed, and
  `PeerManager.destroy()` doesn't clear `sessionStash`. **Fix:** store refs;
  remove in `destroy()`.

---

## Phase 3 — Security hardening

- [ ] **S-sec-1 🟠 deviceId binding hijack at the hub.**
  `arcade-p2p.js:629` (unconditional `identityLinks.set`), consumed at `557-563`
  (forward routing + `fromDevice` stamping). A joiner announcing another live
  seat's deviceId captures that seat's inbound targeted frames *and* gets its own
  frames stamped `fromDevice:<victim>` by the trusted host — exceeds PROTOCOL §8's
  stated residual risk. **Fix:** refuse to rebind a deviceId while its current
  peerId still has a live `peers`/`sessionStash` entry (log a diagnostic, keep the
  old binding). Pairs naturally with B-p2p-1 / P4-a. Same rule for the relayed
  `indirectPeers` path (`611-612`).

- [ ] **S-sec-2 🟠 Import overwrites TOFU trust records.** See **B-lnc-2** (same fix).

- [ ] **S-sec-3 🟡 Blob abort/poison across seats.** See **B-sdk-3** (same fix).

- [ ] **S-sec-4 🟡 PROTOCOL.md replay claims are currently untrue + no decrypt rate limit.**
  Ratchet is deliberately frozen (`rendezvous.js:1307-1347`, sound reason — one-
  sided divergence bricked pairs), so `rec.epoch` stays 0 for a pair's life and
  replay defense reduces to *per-episode* nonce Sets. A hostile broker can replay
  a recorded ring to provoke presence disclosure/publish spam forever; each
  recorded offer burns an RTCPeerConnection + 30 s stall. **Fix:** (a) add a
  *persistent per-pair* replay cache (bounded, in the IDB record) so §7.4's claim
  becomes true without the ratchet-agreement problem; (b) token-bucket decrypt
  attempts per episode (~10/s) in `_onBlob` (`1101-1123`); (c) rewrite the
  PROTOCOL.md claims to match reality (D-1). Optionally drop the pre-1.10
  nonce-less-answer compat branch (`1137`).

- [ ] **S-sec-5 ⚪ SDP unpack splices unvalidated strings into template lines.**
  `p2p/sdp-codec.js:308-311` → `buildSDP` `220-223` — CRLF injection via
  ufrag/pwd/mid. Bounded (legacy deflate path already takes an attacker-authored
  sdp), but if the packed codec is the constrained format, validate charsets and
  raw candidate addresses. Also drop SHA-1 (20-byte) fingerprint acceptance
  (`sdp-codec.js:25`, D-1).

- [ ] **S-sec-6 ⚪ No size cap on `store.op`/`files.op` — shared-quota exhaustion.**
  `index.html:1331-1461`. A runaway game can exhaust the origin quota the qrp2p
  key stores share, breaking P2P persistence arcade-wide. **Fix:** per-op cap
  (~32 MB) and/or a `navigator.storage.estimate()`-based refusal.

---

## Phase 4 — Structural refactors (delete bug *classes*, don't patch instances)

- [ ] **P4-a 🟠 One seat record per peer in `arcade-p2p.js`.**
  Six parallel module-level maps (`identityLinks`, `indirectPeers`, `announcedTo`,
  `autoPairMintedFor`, `fingerprintSuspects`, `hostCaps`) with no unified
  lifecycle are the root cause of B-p2p-1, S-sec-1, S-sec-3 (nothing owns "this
  seat left, forget everything"). **Fix:** one `Map<peerId, seatRecord>` +
  a `deviceId → peerId` index, deleted in one place on terminal teardown. Removes
  the two linear reverse-lookup scans (`deviceIdForPeerId`, `deviceIdForRelayFrom`).

- [ ] **P4-b 🟠 One `renderConnectionState()` in `p2p-ui.js`.**
  Badge/button state is derived in four places with subtly different rules
  (`347-376, 400-418, 705-763`) — where P1-b, B-p2p-4, B-p2p-6 live. **Fix:** one
  aggregate function reading the peers map, called from all four sites; separate
  "did *my* ceremony's peer connect" check (P1-b). Collapses the host/joiner
  branch duplication.

- [ ] **P4-c 🟡 One status aggregate in the transport.**
  `aggregateStatus`, `rosterSnapshot`, `connectionState` each encode a different
  "live" definition (produced B-p2p-5). **Fix:** derive all three from a single
  `aggregate()` over `peers` + `sessionStash` + per-pair rdv state.

- [ ] **P4-d 🟡 Extract storage/save machinery from `index.html`.**
  ~950 lines (`1254-2227`) of bridge/checksum/export/import inside a 1,500-line
  IIFE in a 2,685-line file. **Fix:** split into `arcade-storage-bridge.js`
  (state/store/files/storage ops + IDB helpers) and `arcade-save.js`
  (export/import/checksums), wired via `window.__arcade` like the connections
  dialog. Makes import validation unit-testable and allowlist drift (B-lnc-1)
  visible in one file. **Remember:** add new files to `ASSETS_TO_CACHE` (`sw.js:2`)
  — keep module count small (2-3) for that reason. Fold in S-lnc dedup
  (`resolvePeerName`/`tryResumeOnLaunch` parse `knownPeers` inline; export
  `readKnownPeers` from `arcade-known-peers`).

- [ ] **P4-e ⚪ Give the transport a small API; stop the UI reaching into internals.**
  UI does `peerNode.peers.delete(...)` (B-p2p-3), mutates `peerNode.options`
  (`p2p-ui.js:618-623`), reads `peers`/`isHost` everywhere. **Fix:** add
  `cancelPending()` and `statusSummary()` to `PeerManager`. Also delete or
  fix `P2PAddon`'s dead parsed `'data'` event (`p2p-addon.js:12-18`;
  `arcade-p2p.js:728-730` can't use it — add `peerId` to detail or remove).

### SDK surface tightening (API simplicity)

- [ ] **S-sdk-1 🟡 `getOrInit` footguns.** `state.getOrInit` (`1192-1205`),
  `stats.getOrInit` (`1587-1599`). Merge isn't written back (plain `get`
  afterwards returns the unmerged value); empty case returns `defaults` *by
  reference* (mutating the result mutates the shared default). **Fix:** persist
  the merge (or document loudly); return a clone of defaults.
- [ ] **S-sdk-2 ⚪ Doc-deprecate `peer.remote()`** in favor of `peers()`; retire
  `peer.identity` handling once all launchers send rosters (`1351-1357, 894-896`).
- [ ] **S-sdk-3 ⚪ Store scores sort order on the category, not per-call.**
  `1505-1541` — one `add` without `{order:'asc'}` resorts a time list and evicts
  the best times.
- [ ] **S-sdk-4 ⚪ `state.get()` can't distinguish absent / stored-null / corrupt.**
  `344-348`. Log once on parse failure; consider `state.has(key)`.
- [ ] **S-sdk-5 ⚪ `Arcade.ready` never settles if `init()` is never called.**
  `240`. Reject after a timeout, or warn on pre-init access.
- [ ] **S-sdk-6 ⚪ Minor dedup:** two monotonic-clock helpers (`1634-1637, 1732-
  1735`); `onStorageError` hand-rolls `makeSubscriber` (`2197-2204`); `devModeOn()`
  re-reads localStorage per message (`586-591`) — cache it.

---

## Phase 5 — Gaps that enrich the platform

- [ ] **G-off-1 🟠 Decide the in-arcade offline story.**
  Opaque frames can't be controlled by any service worker, so the per-game SW
  strategy GAME_INTEGRATION.md mandates only works standalone; `sw.js:60-75`
  ignores `/<gameId>/` paths. Offline, the shell opens and every game is a dead
  black frame. **Fix (choose):** launcher SW runtime-caches game paths
  (size-capped LRU — it's the only party that can), **or** document in-arcade
  play as online-only and let G-ux-1's error card say so. Also: precache is
  refreshed only on `CACHE_NAME` bump and `cache.addAll` fails install on one
  404 — network-first hides both from online users, silently stranding offline
  users on a stale version.

- [ ] **G-ux-1 🟠 Iframe loading/error/timeout state.**
  `index.html:826-877` — `ensureIframe` sets `src` and hopes; a 404 or offline
  launch is a black frame with only a quit button. **Fix:** loading veil until
  first `arcade:hello` (stronger than `load`, which fires for opaque error
  pages), ~10 s timeout → error card with Retry / Back.

- [ ] **G-mp-1 🟠 Multiplayer game-dev toolkit** (the transport is excellent; the
  game-facing layer makes every game reinvent the same primitives):
  - [ ] `Arcade.peer.request(payload, {to, timeoutMs})` → Promise with reply
    correlation (docs already tell games to hand-roll acks, GAME_INTEGRATION §7).
  - [ ] State-resync primitive — snapshot/sequence helper + `peer.onResyncNeeded`
    (docs mandate resync after queue overflow but provide nothing).
  - [ ] `Arcade.random.seeded(seed)` (mulberry32-class) — shared PRNG for
    lockstep/turn-based determinism.
  - [ ] Targeted `sendBlob(blob, {to})` — currently broadcast-only (`1409`).
  - [ ] Lobby/seat/turn helpers + host-election beyond `direct:true`.
  - [ ] Peer game-version negotiation — `init({gameVersion})` surfaced in
    `onReady`/roster (GitHub Pages rollout skew produces confusing wire breakage).
  - [ ] `state.keys()` — enumerate own saves (slot pickers, debug dumps).
  - [ ] Continuous send-backpressure visibility (`queue()` is only populated while
    `interrupted`; expose bufferedAmount / a `congested` boolean while connected).

- [ ] **G-ux-2 🟡 Non-blocking dialogs during live sessions.**
  `index.html:979-1023` (`confirm`/`prompt` in onPeerIdentity/askAutoReconnect/
  onPairRequest), `2168/2175/2179`. The first-contact "Name this connection"
  prompt fires right after the data channel opens and freezes the event loop, so
  the *peer* sees the new connection flap to `interrupted`. **Fix:** use the
  existing dialog infrastructure (connections dialog) for these.

- [ ] **G-res-1 🟡 Configurable rendezvous brokers.**
  All three brokers are free public sandboxes with shared fate; networks blocking
  WSS have zero recourse. Implement `_meta.rdvBrokers` override (roadmap B6 /
  issue #33) — ~10 lines, the cheapest resilience win. (No `rdvBrokers` exists
  anywhere today.)

- [ ] **G-ux-3 ⚪ Make the message toast actionable** — tap to `showGame(...)`
  (after P1-d). `#launcher-toast` is `pointer-events:none` (`styles.css:652`).

---

## Phase 6 — Test & CI

- [ ] **T-1 🔴 Wire `p2p-reconnect-acceptance.mjs` into CI.**
  `.github/workflows/pages.yml` runs store/bridge/export/p2p/multiseat but **not**
  the reconnect suite (`package.json` `p2p-reconnect`) — the *only* coverage of
  the highest-churn subsystem (rendezvous, RDV_BUILD v2.4). Add it with the same
  3-attempt retry wrapper as the other p2p suites.

- [ ] **T-2 🟠 `rendezvous-carriers.js` has zero coverage.**
  The harness injects its own carrier (`tools/lib/p2p-test-harness.mjs:44-70`,
  honored at `arcade-p2p.js:100`), so `MqttCarrier`/`mqttCodec`/`MultiCarrier`
  run only in production. `mqttCodec` is exported "for hermetic unit tests" that
  don't exist. **Fix:** Node unit tests for the codec/parser (varint edges +
  oversize-skip resync — security-relevant, no browser needed); drive `MqttCarrier`
  against a local `ws` echo (~100 lines).

- [ ] **T-3 🟡 No `rendezvous-crypto.js` unit tests.** AAD direction/epoch binding
  (a sealed `'o'` must not open as `'a'`; epoch n must not open as n+1),
  `open()`-returns-null on tamper/truncation, topic-derivation vectors, confirmMac
  role asymmetry.

- [ ] **T-4 🟡 Add harness carrier hooks + failure-injection scenarios.**
  Injected carrier lacks `ensureAlive`/`onSessionUp`, so `nudgeAll`, session-
  restore republish (`rendezvous.js:992-996`), and freeze/thaw recovery are never
  exercised. Add both hooks + a sever/restore-mid-episode scenario, a fake-clock
  day-rollover scenario (catches B-rdv-1), and a multi-pair concurrent-rendezvous
  scenario (T6: hub with two spokes healing simultaneously).

- [ ] **T-5 ⚪ Per-game `acceptance.mjs` + `--pool` not in CI** — already tracked
  (pages.yml:78-85, issue #40); no action beyond what's tracked.

---

## Phase 7 — Documentation

- [ ] **D-1 📄 PROTOCOL.md ↔ code drift (security spec — highest priority doc).**
  §7.2/§7.4/§7.5/§8: frozen ratchet, epoch persistence, "recorded blobs dead on
  arrival", forward secrecy for relay recordings all disabled by
  `rendezvous.js:1310-1335` — state the frozen-secret trade honestly (the code
  comment has the right text). §7.1 documents pairing `v:1`; code speaks v2 with
  `pair-confirm` + commit-after-proof (`639, 696-743`). §10 registry internally
  inconsistent (missing `pair-confirm`, `bye`, sealed direction `r`; SHA-1
  fingerprint length). §7.6 omits `MultiCarrier` + three-broker wiring. §11
  version history ends at 1.11 (code is RDV_BUILD v2.4). §5.5 calls the stash a
  "bounded LRU"; it's FIFO (`p2p-core.js:970-974`).

- [ ] **D-2 📄 GAME_INTEGRATION.md ↔ SDK drift.**
  §migration example (`154-179`) calls raw `localStorage.getItem` inside
  `migrate()` — throws every load when framed (fix with B-sdk-2). `state.set`
  "returns false on quota" (`109-116`) is untrue in framed mode (always true;
  quota surfaces via `onStorageError`). `adopt` needs a framed caveat (`126-137`).
  Version field ambiguity (`5, 694-696` say v2; SDK sends `3`). kebab-case gameId
  (`15`) vs actual regex (`arcade-sdk.js:134` allows `_`/uppercase). Document
  `__arcade*` payload keys as reserved (`arcade-sdk.js:866-874`).

- [ ] **D-3 📄 Fix in-repo doc inconsistencies.**
  ARCADE_PLATFORM.md has the entire "Multiplayer dialog" section **duplicated**
  (lines 266-275 and 277-285) with divergent Hang-Up copy — delete one. README
  says "10-message protocol"; ARCADE_PLATFORM.md says twenty-one message types —
  reconcile. Document the launcher `{arcade:1,…}` wire vocabulary (envelopes,
  `kind:'identity'` + caps, presence/presence-ack, targeted `to` + host-stamped
  `fromDevice`, `__arcadeBlob*` chunking) — a real inter-device format specified
  nowhere, with version-skew handling (`hostCaps`/`WIRE_CAPS`) already depending
  on it.

- [ ] **D-4 📄 Mark shipped items done in plans/.**
  `framework-evolution.md`: LICENSE (`129-130`), CI gate (`137-140`), MQTT size
  cap, blob integrity/abort (#51), fingerprint-pin overwrite fix (`215-225`).
  `implementation-roadmap.md`: Phase 0 "not yet committed" (`17-18`), #41 deferred
  (`159`, closed by #51). Promote `_meta.rdvBrokers` (#33) out of the deferred
  pile — it's now the top resilience item (G-res-1).

---

## Suggested execution order

1. **Phase 1** (unblock the branch) + **T-1** (one CI stanza) — smallest diffs,
   highest urgency.
2. **P4-a** and **P4-b** first among refactors — they *are* the fix for B-p2p-1,
   S-sec-1, S-sec-3, P1-b, B-p2p-4, B-p2p-6. Do the refactor, land those fixes on
   top of it.
3. **B-sdk-1** and **B-sdk-2** — the state-corruption and only permanent-data-loss
   bugs; both small.
4. **B-rdv-1 / B-rdv-2** — they break the product's core "stays reachable" promise.
5. **S-sec-4 + D-1** together — make the security spec true again.
6. Everything else by severity within phase.
