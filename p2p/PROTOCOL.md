# QRP2P Protocol Specification

**Version:** 1.11 · **Status:** Implemented · **Date:** 2026-07-10

> Maintained in this repo alongside the implementation (`p2p/`, see
> `p2p/README.md`). The protocol originated in the now-archived
> `paulgibeault/QRCodeP2P` repo; this copy is the authoritative spec.

QRP2P is a serverless peer-session protocol: two (or more) browsers establish
and *sustain* an encrypted WebRTC session where the only infrastructure ever
required is one human-carried signaling exchange — a QR scan or a shared
link. Everything above that first exchange is designed so the session
survives what real devices do: switch apps, take notifications, sleep the
screen, change networks, and get their browsers killed and reopened.

This document is the authoritative description of every wire format and
state machine in the stack. Implementation: `p2p-core.js`, `sdp-codec.js`,
`rendezvous-crypto.js`, `rendezvous-carriers.js`, `rendezvous.js`.

---

## 1. Design goals

1. **No infrastructure of our own.** No signaling server, no accounts, no
   TURN. The only third parties ever touched are optional public STUN
   (address reflection only) and, for the opt-in rendezvous layer, public
   dead-drop relays that carry ciphertext they cannot read, link, or forge.
2. **The human exchange is the root of trust.** Cryptographic identity and
   all later automation derive from the one in-person ceremony.
3. **Sessions outlive connections.** The unit apps care about (the *session*:
   ordering, exactly-once delivery, "who I'm playing with") is decoupled from
   any individual `RTCPeerConnection`.
4. **Graceful degradation.** Every automated layer that fails falls back to
   the layer below it, bottoming out at "do the QR ceremony again."

## 2. Conventions and terminology

- **Link** — one `RTCPeerConnection` + data channel between two devices,
  identified by a `peerId` (7-char base36, minted by the inviter; both sides
  key the link by the same value).
- **Session** — the reliability state (sequence counters, outbox) and app
  meaning attached to a `peerId`. A session may span many links over time.
- **Inviter / joiner** — roles in a ceremony: the inviter creates the offer.
- **Caller / listener** — fixed roles in a *rendezvous pair* (see §7.1),
  independent of who invited whom originally.
- **Frame** — one data-channel message (UTF-8 JSON in v1.x).
- All JSON wire objects ignore unknown fields (forward compatibility).
- Byte orders are big-endian. `||` denotes concatenation. `b64url` is
  base64url without padding.

## 3. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Application (games, chat)         payloads only, no transport view │
├────────────────────────────────────────────────────────────────────┤
│ §7 Rendezvous      zero-touch re-signaling through untrusted relays│
│ §6 Identity        persistent DTLS certificate, fingerprint pinning│
│ §5 Link protocol   reliability · liveness · repair · relay         │
├────────────────────────────────────────────────────────────────────┤
│ §4 Ceremonies      QR scan · link tennis (human-carried signaling) │
│ §3.1 Payload codec packed SDP, ~110–180 chars                      │
├────────────────────────────────────────────────────────────────────┤
│ WebRTC             RTCPeerConnection · DTLS · SCTP data channel    │
└────────────────────────────────────────────────────────────────────┘
```

### 3.1 Signaling payload codec

A signaling payload is logically `{ peerId, sessionDesc: { type, sdp } }`.
On the wire (QR, link fragment, or sealed rendezvous blob) it is packed:

```
payload := "1." b64url(bytes)
bytes   := version_flags(1)      high nibble: codec version (1)
                                 bit0: 0 = offer, 1 = answer
           peerId    (len-prefixed ASCII)
           mid       (len-prefixed ASCII)
           ice-ufrag (len-prefixed ASCII)
           ice-pwd   (len-prefixed ASCII)
           dtls-fp   (len-prefixed raw bytes; hash algo inferred from length:
                      32 = sha-256, 48 = sha-384, 64 = sha-512)
           candCount (1)
           candidate := meta(1)  bits0-1 addr kind: ipv4|ipv6|mdns|raw
                                 bits2-3 cand type: host|srflx|prflx|relay
                        addr    (4 | 16 | 16-uuid | len-prefixed ASCII)
                        port    (2)
```

The receiver reconstructs a full SDP from a template — only entropy travels.
The legacy format (deflate-raw + b64url, no `"1."` prefix) MUST still be
accepted for decode. Payloads failing shape validation
(`ConnectionUtils.validatePayload`) MUST be rejected before touching any
RTC API.

## 4. Ceremonies (first contact)

Signaling is **one-time-use by design**: ICE credentials are per-connection
(browsers provide no API to reuse them), so a captured ceremony payload is
useless after the connection it created. This is a deliberate security
property — old QR codes and stale invite links are inert.

**QR flow.** Inviter shows packed offer as QR → joiner scans, shows packed
answer as QR → inviter scans. Connected.

**Link tennis.** The offer travels as a URL fragment
(`#p2p-offer=<packed>`); the joiner's browser auto-produces an answer link
(`#p2p-answer=<packed>`) sent back through the same human channel (chat
thread). A relay tab delivers the answer to the original inviter tab via
`BroadcastChannel`/`localStorage` and acks.

The app-level meaning of **connected** is: *the data channel is open*
(`v1.5.1` rule). ICE reaching `connected` before the answer is applied MUST
surface as `finalizing`, never `connected`.

## 5. Link protocol

All frames are JSON. Two namespaces exist; they are distinguished by the
reserved key `__p2pc`, which application payloads can never occupy (the
send path always wraps app data under `text`).

### 5.1 App frames

```json
{ "text": "<application payload>", "from": "<origin myId>",
  "seq": 42, "relayed": true, "noRelay": true }
```

| field | presence | meaning |
|---|---|---|
| `text` | always | opaque application payload (apps typically nest JSON here) |
| `from` | always | sender's transport id (app-level attribution; not authenticated) |
| `seq` | v1.7+ | per-link, per-direction sequence number, starts at 1 |
| `relayed` | when relayed | stamped **by the relaying host only** (§5.6) |
| `noRelay` | v1.11, targeted frames | set by the sender: the hub MUST NOT fan this frame out (§5.6) |

The app-frame serializer is a whitelist: only the fields above travel, in
both directions — a sender cannot smuggle arbitrary keys into another
peer's message handler.

### 5.2 Control frames

| frame | direction | meaning |
|---|---|---|
| `{__p2pc:'ping', t}` | both | liveness probe (§5.4) |
| `{__p2pc:'pong', t}` | reply | echo of `t` |
| `{__p2pc:'ack', upTo}` | receiver→sender | cumulative app-seq acknowledgment |
| `{__p2pc:'resync', have}` | both, on channel open | request replay of app frames with `seq > have` |
| `{__p2pc:'signal', desc\|cand}` | both | in-band renegotiation (§5.5) |
| `{__p2pc:'ext', ns, data}` | both | namespaced extension (registry §10); `ns:'rdv'` = rendezvous pairing |

Control frames are **never relayed**, are only honored from the direct
DTLS-authenticated link they arrived on, and are unforgeable by
applications.

### 5.3 Reliability — exactly-once across interruptions

- Sender: every app frame gets `seq = ++outSeq` and is held in a bounded
  outbox (default cap 1000) until acked. Overflow drops oldest and MUST be
  surfaced as a diagnostic (continuity is then best-effort).
- Receiver: frames with `seq <= lastInSeq` are dropped (duplicates from
  replay/retransmit) but still re-acked; fresh frames advance `lastInSeq`
  and are acked immediately.
- On every channel open, each side sends `resync{have: lastInSeq}`; the
  peer prunes its outbox to `> have` and replays the rest in order.
- **Ordering gate:** after a channel opens, a sender MUST NOT transmit new
  app frames until it has processed the peer's `resync` (new frames queue in
  the outbox meanwhile; a bounded fallback timer covers pre-v1.7 peers that
  never send one). A fresh frame overtaking the replay would advance the
  receiver's cumulative dedup counter past the gap, causing the replayed
  frames to be dropped as duplicates.
- Frames without `seq` (pre-v1.7 peers) are delivered without dedup.
- A terminally-dead session sitting in the adoption stash (§5.5, §7.5)
  still accepts sends into its stashed outbox, so traffic produced *during*
  a rendezvous repair replays on the reconnected channel.

Combined effect: SCTP retransmission covers in-connection loss; the
outbox+resync covers *across-connection* loss; seq dedup collapses both to
exactly-once app delivery.

### 5.4 Liveness

- **Heartbeat:** while a channel is open, ping every `heartbeatIntervalMs`
  (5 s). Any inbound frame refreshes `lastAliveAt`. Staleness beyond
  `heartbeatTimeoutMs` (12 s) marks the link `interrupted`. A device whose
  own tab is hidden MUST NOT judge its peers (its timers are throttled and
  the peer's silence is expected).
- **Wake probe:** on `visibilitychange → visible`, ping immediately; no
  inbound frame within `wakeProbeTimeoutMs` (3 s) marks the link
  `interrupted` without waiting for ICE.

### 5.5 Link state machine and repair

```
new → checking → finalizing → connected ⇄ interrupted → disconnected(terminal)
```

`interrupted` = *session alive, path under repair*. Entered on ICE
`disconnected`/`failed` (established links), heartbeat staleness, or wake
probe failure. Exited by **any inbound frame** or by expiry of
`interruptedGraceMs` (default 5 min) → terminal. While interrupted, sends
are queued (§5.3), not refused. Mid-ceremony failures skip the grace and
fail fast. On terminal teardown the session state is stashed (bounded LRU,
8 entries) for later adoption (§7.5).

Repair escalation while interrupted:
1. ICE self-heal (consent checks resume when a suspended tab wakes).
2. **In-band ICE restart:** `restartIce()` renegotiates over the data
   channel itself using `signal` frames and the perfect-negotiation
   pattern. Politeness is fixed per link: **the joiner side is polite**.
   Frames queue in SCTP while the path is down and deliver on revival.
   Restart attempts repeat every 10 s within the grace window.
3. Rendezvous (§7), if the pair opted in.

### 5.6 Multi-peer relay (star topology)

The inviter of a multi-peer session acts as hub: app frames from one spoke
are re-sent to every other spoke **through each destination link's own
sequence space**, stamped `relayed: true` by the hub itself. A spoke cannot
launder a relayed frame into looking direct (the hub always stamps), and
identity claims (§6) MUST NOT bind through a relayed frame.

**Targeted frames (v1.11).** `sendTo(peerId, text)` is the public
single-link send: it delivers to one peer through the same per-link outbox
(and the adoption stash of a dead-but-repairing session, §5.3), so
exactly-once replay applies to targeted frames unchanged. Targeted frames
carry `noRelay: true`; the hub's relay loop MUST skip them, so a targeted
frame sent to the hub is never fanned out to the other spokes.

**Inbound `relayed` sanitization (v1.11).** Only the hub may stamp
`relayed`, and every frame the hub receives arrives on a direct link from
its origin — an inbound `relayed: true` at the hub is therefore always
forged, and the hub MUST strip it before relay or local dispatch. Without
this, a spoke could launder its frames into "arrived through the hub" and
defeat relay-tag attribution in layers above.

## 6. Identity

Each browser profile persists one ECDSA P-256 `RTCCertificate` (IndexedDB
db `qrp2p-identity`) presented on every connection, giving the device a
DTLS fingerprint that is stable across page loads.

- `getPeerFingerprint(peerId)` / `getOwnFingerprint(peerId)` expose the
  uppercase `HH:HH:…` fingerprint of a live link's remote/local identity.
- Browsers cap certificate lifetime (~30 days; regenerated shortly before
  expiry), so fingerprints rotate on that cadence. Therefore pinning at
  this layer is **trust-on-first-use with change notice**: a changed
  fingerprint on a *manual* ceremony is recorded and surfaced to the user,
  never silently trusted and never hard-failed (the in-person exchange is
  itself the authentication). Durable pair binding lives in §7's ratcheting
  secret, which survives certificate rotation.

## 7. Rendezvous (zero-touch reconnection)

Purpose: when a link dies *terminally* (channel closed, both networks
changed, browser killed) there is no in-band path left to carry fresh
signaling. The rendezvous layer lets two devices that completed one manual
ceremony re-exchange signaling through an **untrusted dead-drop** with no
human courier. It can only re-introduce paired devices — never introduce
strangers.

### 7.1 Pairing

While a manually-ceremonied link is connected, each side that opts in sends
one extension frame over the DTLS-authenticated control channel:

```json
{ "__p2pc": "ext", "ns": "rdv", "data": { "t": "pair", "v": 1, "rand": "<b64 32 bytes>" } }
```

Correlation is by link (`peerId`), not by label — each side stores the pair
under its own local `pairId` (applications typically use the remote
device's id). When both randoms have crossed, each side derives:

- `pairBase_0` per §7.2, and
- its **role**: the side whose random is lexicographically smaller (as
  lowercase hex) is the **caller**; the other is the **listener**. Roles
  are fixed for the life of the pair.

A record `{base, role, epoch: 0, enabled, lastPeerId, lastSeenAt, byeAt?}`
persists in IndexedDB (`qrp2p-rendezvous`), with `base` as a non-extractable
`CryptoKey`. Re-pairing on a later manual ceremony REPLACES the record —
every physical meeting is a fresh trust event.

`enabled` is the local suspend switch: `pausePair()` clears it (episodes and
standby stop; the device is deliberately unreachable for this pair) and
`resumePair()` restores it and attempts a reconnect immediately.

A second `rdv` extension frame signals a DELIBERATE hang-up over the live
control channel, sent just before closing the link:

```json
{ "__p2pc": "ext", "ns": "rdv", "data": { "t": "bye", "v": 1 } }
```

The receiver cancels any repair for the pair and records `byeAt`; until the
pair reconnects (or the receiver itself calls), its episodes start as quiet
STANDBY (§7.5) — no repair is burned on a link the peer closed on purpose,
but the device remains callable.

### 7.2 Key schedule

```
ikm            = sort32(randA, randB)[0] || sort32(randA, randB)[1]
pairBase_0     = HKDF-SHA256(ikm,        salt=0^32,           info="qrp2p/rdv/v1/base")
topicKey_n     = HKDF-SHA256(pairBase_n, salt=0^32,           info="qrp2p/rdv/v1/topic")   → HMAC-SHA256 key
aeadKey_n      = HKDF-SHA256(pairBase_n, salt=0^32,           info="qrp2p/rdv/v1/aead")    → AES-256-GCM key
pairBase_{n+1} = HKDF-SHA256(pairBase_n, salt=transcriptHash, info="qrp2p/rdv/v1/ratchet")
transcriptHash = SHA-256( sort(ownFp, peerFp).join("|") )     — fingerprints of the NEW connection
```

The ratchet (§7.5) is **specified but currently disabled in the
implementation** — see the frozen-ratchet note in §7.5. With it disabled the
epoch never advances (`pairBase_n = pairBase_0` for the pair's life), so the
forward-secrecy / post-compromise-recovery properties it would provide are
**not** in force today. Confidentiality against the relay still holds (the base
never touches a broker); what's lost is the *cross-episode* replay and
key-rotation guarantees. See §7.4 and §8 for what actually defends replay now.

### 7.3 Topics

The rendezvous topic for UTC day `d` (format `YYYY-MM-DD`):

```
topic(d) = lowercase_hex( HMAC-SHA256(topicKey_n, "topic/" || d)[0..15] )
```

Participants SHOULD subscribe to `topic(d-1)`, `topic(d)`, `topic(d+1)` for
clock skew and publish to `topic(today)`. Topics are unlinkable across days
and across pairs; no device identifier ever reaches a relay.

### 7.4 Sealed messages

Everything published to a carrier is:

```
blob = b64url( nonce(12) || AES-256-GCM(aeadKey_n, packed_payload, aad) )
aad  = "qrp2p/rdv/v1|" || direction || "|" || epoch      direction ∈ {"o","a","r"}
```

`packed_payload` is the §3.1 codec output for the offer/answer ("o"/"a"),
or plain JSON `{peerId, n}` for a ring ("r") — the listener role's doorbell
asking the caller role to publish a fresh offer (§7.5). Rules:

- **Decrypt-then-parse:** a blob that fails AEAD is *silence* — no error
  path, no parser contact. This is the entire input surface exposed to a
  malicious relay.
- The direction tag prevents reflection (an echoed offer can never
  authenticate as an answer); brokers that echo publishes to their sender
  are harmless for the same reason.
- **Epochs** are per-pair counters that *would* advance only on ratchet. The
  caller seals with `epoch = completed + 1`; the listener accepts a window of
  `completed + 1 … + 3` (crash-recovery skew) and rejects anything at or below
  its completed epoch. **With the ratchet frozen (§7.5) the completed epoch
  stays 0 for the pair's life**, so this is a fixed window (epochs 1–3), not a
  moving floor — a recorded blob is therefore NOT "dead on arrival" across
  episodes the way a live ratchet would make it. What defends replay today:
  (a) per-episode `deadNonces`/`seenRings` sets (below) inside one episode;
  (b) a per-episode decrypt-attempt **rate limit** (~10/s) that caps the work a
  hostile broker can induce by streaming recorded/junk blobs; (c) the one-time
  ICE credentials in any replayed *ceremony* payload, which are inert (§4). A
  persistent cross-episode nonce cache — which would restore the "dead on
  arrival" property without needing the ratchet — is a tracked follow-up.
- **Exchange nonces** protect *within* the epoch window, where a relay can
  still delay or duplicate blobs (epochs advance only on success, so an
  abandoned attempt leaves valid-looking litter). Offers and rings carry a
  random `n`; an answer echoes its offer's `n` and is rejected on mismatch,
  duplicate offers/rings are dropped by `n`, and an answered offer that
  never produces a connection is retired after `answerStallMs` (30 s) so a
  stale blob can never wedge an episode. An absent `n` (pre-1.10 peer) is
  accepted for compatibility.

### 7.5 Episode state machine

Triggers (per enabled pair):
- link `interrupted` continuously for `listenerDelayMs` (15 s, listener) /
  `callerDelayMs` (30 s, caller) — the in-band repair gets first claim;
- terminal `disconnected` — immediately;
- `resumeAll()` at app startup, for pairs seen within `resumeWindowMs`
  (6 h) — this is what reconnects two *restarted* browsers;
- `resumePair()` — the app's explicit "call this peer now";
- `standbyAll()` at app startup outside the resume window — arms
  subscribe-only STANDBY episodes (below), so a device that merely has the
  app open stays callable.

**Caller:** builds a **shadow** connection (fresh `RTCPeerConnection` +
data channel; any still-interrupted live link is untouched), seals the
offer (with a fresh exchange nonce, §7.4), subscribes to the day topics,
and publishes with backoff (0 s, 5 s, 30 s, 2 min, then every 5 min). On a
valid sealed answer: if the old link healed in-band meanwhile, keep it and
discard the shadow; otherwise **adopt** the shadow under the session's
`peerId` and apply the answer. A valid **ring** re-arms the shadow (if it
has aged — the network may have moved under it) and republishes at once.

**Listener:** subscribes and publishes a sealed **ring** on the same
backoff — a doorbell that provokes the caller role into arming a fresh
offer, which is what makes a one-sided `resumePair()` land on a peer whose
episode went quiet hours ago. On a valid sealed offer it builds a fresh
connection, adopts it under the offer's `peerId`, and publishes the sealed
answer (with a few republishes).

**Quiet phase / standby:** after `episodeTimeoutMs` (10 min) an episode
DEMOTES rather than dying: `gave-up` is emitted so UIs and wake locks
release the active session claim, but the subscription stays and the slow
republish continues (bounded by `resumeWindowMs` since the pair was last
seen — reachability stays, standing spam doesn't). `standbyAll()` and
bye-flagged pairs start directly in this subscribe-only state and initiate
nothing until a ring (caller role) or an offer (listener role) provokes
them. Episodes end only on settlement or an explicit cancel
(`pausePair`/`disablePair`/re-pair); a hard error (carrier factory throw,
RTC failure) re-arms a quiet episode after `rearmDelayMs` (60 s).

**Adoption** (`PeerManager.adoptConnection`): the new connection is
installed under the existing `peerId`, inheriting the session (seq
counters + outbox) from the live entry or the terminal-death stash. The
standard §5.3 resync on channel-open then replays anything queued when the
old link died. Apps observe only `interrupted → connected`. After a full
restart no session state exists; adoption then starts a fresh session with
deterministic politeness (caller = impolite, listener = polite).

**Settlement:** first `connected` for the pair's `peerId` settles the
episode. The carrier is closed at settlement — a CONNECTED pair maintains no
presence on relays.

**Frozen ratchet (implementation note).** The spec above calls for both sides
to ratchet (`§7.2`) and persist `epoch = usedEpoch` when the sealed exchange
completed (`exchanged`). **The implementation deliberately does NOT ratchet or
persist the epoch** (`_settleEpisode`): a ratchet advances only if *both* sides
agree the exchange completed, and any one-sided divergence (a race where an
in-band recovery wins, a settle that lands on one device but not the other)
would leave the two devices holding different `pairBase_n` — permanently deaf,
recoverable only by a full manual re-ceremony. That failure was worse in
practice than the replay/forward-secrecy properties the ratchet buys, so the
epoch is frozen at 0 and the base is fixed for the pair's life. Consequences and
the compensating defenses are documented in §7.4; the trade is also reflected in
§8. Re-enabling the ratchet needs a two-sided commit (both devices confirm the
new base before either adopts it), which is future work.

**Presence trade-off (changed in 1.10):** pre-1.10, episodes were one-shot
and a device kept *no* standing presence on relays; the cost was that any
outage longer than one episode left both sides permanently deaf until a
manual ceremony. Now an enabled, DISCONNECTED pair holds a standing
subscription (pseudonymous, on daily-rotating HMAC topics) for as long as
the app is open. The relay's view: some client is subscribed to some
random-looking topic — but a long-lived subscription from one IP does link
that pseudonym across a day, and reconnection at app-open reveals "a
device that owns some pair is online". Pairs the user paused
(`pausePair`) subscribe to nothing. See §9.

### 7.6 Carriers

A carrier moves opaque `(topic, blob)` pairs and is untrusted by
construction — its worst case is delay/drop, which degrades to the manual
ceremony. Interface:

```
await connect() · await publish(topic, blob) · unsub = subscribe(topic, cb) · close()
```

Defined carriers: `MqttCarrier` (minimal dependency-free MQTT 3.1.1 over
WSS, QoS 0, for free public brokers; topics namespaced
`qrp2p/r/v1/<topic>`) and `LoopbackCarrier` (`BroadcastChannel`, same-origin
testing). Nostr relays are a candidate future carrier (requires secp256k1
signing, i.e. a vendored dependency).

A carrier is expected to be **self-healing** (1.10): `MqttCarrier.connect()`
resolves on its first successful broker session and never rejects — it
redials with backoff (1 s → 30 s) on failure or loss, re-issues every
subscription on each new session, and treats a missed PINGRESP as a dead
socket. Free public brokers restart routinely; carrier loss is an outage to
ride out, never an error that kills an episode. `publish()` during an
outage throws, which the episode's republish schedule absorbs.

## 8. Security considerations

| threat | defense |
|---|---|
| Stale/captured ceremony payload | one-time ICE credentials — replay is inert (§4) |
| App forging transport control | `__p2pc` unreachable from app send path (§5.2) |
| Spoke laundering relayed frames | hub stamps `relayed` itself and strips forged inbound `relayed` (§5.6) |
| Identity claim via relay | fingerprints bind only on direct links (§6) |
| Relay reads/forges signaling | AEAD with pairing-derived keys; decrypt-then-parse (§7.4) |
| Relay/observer links a pair across days | daily HMAC topics, no identifiers; standing subscriptions are pseudonymous and per-day (§7.5, §9) |
| Replay/duplication WITHIN an episode | per-episode exchange nonces (`deadNonces`/`seenRings`) + stalled-exchange retirement (§7.4) |
| Replayed rendezvous blobs ACROSS episodes | **partial** — ratchet frozen (§7.5), so the epoch floor is fixed at 0, not moving; mitigated by a per-episode decrypt **rate limit** and inert ceremony ICE creds (§7.4). A persistent cross-episode nonce cache to fully close this is tracked follow-up |
| Hostile broker induces decrypt work (junk-blob flood) | ≤16 KB frame cap + per-episode decrypt-attempt rate limit (~10/s) (§7.4) |
| Reflection (offer ↔ answer ↔ ring) | direction tag in AAD (§7.4) |
| Recorded traffic + later key theft (forward secrecy) | **NOT provided today** — the per-reconnect ratchet that would bind keys to each new DTLS transcript is specified but frozen (§7.5); base confidentiality against the relay still holds |
| MITM on rendezvous reconnect | new fingerprints travel only inside the AEAD; without `pairBase_n` substitution is impossible |
| Stranger introduction via rendezvous | no secret → no topic, no key; pairing requires the manual ceremony (§7.1) |

Residual risks, stated honestly: a malicious *direct* peer is inside the
trust boundary (it can lie about `from`, announce false identity fields —
the pin notice surfaces changes, nothing more); relay operators see IP +
timing metadata during episodes; rendezvous requires both apps to be
open — waking a closed app needs push infrastructure, which is out of
scope; multi-peer sessions rendezvous pairwise with the hub only.

## 9. Privacy considerations

Nothing identifying is ever published: topics are pair-secret HMACs rotated
daily and payloads are sealed. Since 1.10, an enabled pair that is
DISCONNECTED keeps a standing subscription on its carrier while the app is
open (see §7.5's presence trade-off) — the relay observes a pseudonymous
per-day topic and the subscriber's IP/timing, nothing more; initiating
publishes stop once the pair falls outside the resume window. Users opt in
per pair; pausing a pair unsubscribes it, and revocation deletes the secret
locally. STUN (when enabled) learns only what STUN always learns: the
reflexive address of a client that asked for it.

## 10. Registry

| item | values (v1.11) |
|---|---|
| payload codec versions | `1` (packed); legacy deflate (decode-only) |
| rdv ext frame kinds | `pair` `bye` |
| rdv sealed directions | `o` (offer) `a` (answer) `r` (ring) |
| control frame kinds | `ping` `pong` `ack` `resync` `signal` `ext` |
| ext namespaces | `rdv` |
| rdv ext message types | `pair` |
| sealed directions | `o` (offer) `a` (answer) |
| HKDF info strings | `qrp2p/rdv/v1/{base,topic,aead,ratchet}` |
| AAD prefix | `qrp2p/rdv/v1|` |
| IndexedDB | `qrp2p-identity/identity` · `qrp2p-rendezvous/pairs` |
| MQTT namespace | `qrp2p/r/v1/` |

Defaults: heartbeat 5 s / timeout 12 s · wake probe 3 s · grace 5 min ·
restart retry 10 s · outbox 1000 · stash 8 sessions · episode 10 min ·
caller backoff 0/5/30/120/300 s · listener delay 15 s · caller delay 30 s ·
resume window 6 h · epoch acceptance window +3.

## 11. Version history

| version | change |
|---|---|
| 1.5 | packed payload codec, link tennis, `connected` = channel open |
| 1.6 | guided ceremony UX, modal resume |
| 1.7 | resilience: `interrupted` state, heartbeat, wake probe, in-band ICE restart, seq/ack/outbox/resync, relay reseq |
| 1.8 | persistent identity certificate, fingerprint APIs, `relayed` stamp, one-tap host entry |
| 1.9 | rendezvous: pairing, key schedule, sealed dead-drop re-signaling, session adoption, carriers |
| 1.10 | reconnect-lifecycle hardening: self-healing carriers, standby/ring/bye, exchange nonces, quiet-phase episodes |
| 1.11 | targeted sends: public `sendTo`, `noRelay` app-frame flag, hub strips forged inbound `relayed` |
