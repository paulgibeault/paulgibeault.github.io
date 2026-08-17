# Connection model — field test 2026-08-16 and investigation brief

Three-phone field test of a multiplayer cardstock game surfaced **two
independent problems**. They share a symptom vocabulary ("it didn't connect")
and nothing else. Keep them apart: Track 1 is a rendezvous resume-policy bug
with a confirmed root cause and a local fix; Track 2 is a topology-model
question with an unconfirmed hypothesis and a product decision behind it.
Neither fix depends on the other.

Devices: **A** = Paul's iPhone (iOS 18.7, Safari 27), **B**, **C**.

## Field test record

Session 1, one network:

1. A ↔ B ceremony. Both launch cardstock. Hosting, joining, playing and
   rejoining all work.
2. A ↔ C ceremony. C launches cardstock and **cannot see a hosted game.**
3. A ↔ B gameplay continues uninterrupted throughout.

Session 2, a different network, hours later:

4. A, B and C all online with the launcher loaded. **A re-establishes nothing.**
5. B ↔ C connect and play a card game normally.

Evidence captured from A: launcher Multiplayer screenshot and connection log
(`2026-08-17T00:51:56Z`, boot at 18:49:06).

---

## Track 1 — Reconnection: the mutual standby deadlock

**Status: root cause confirmed from the log and the state machine. Not related
to parties in any way.**

### What the log shows

```
[18:49:06] boot: launch: last live session 1911m ago, callable auto-reconnect peer: yes → booting multiplayer bridge
[18:49:07] bridge: resume-on-launch: last live session 1911m ago (outside 6h window) — arming quiet standby only
[18:49:07] rdv: standbyAll: 8 stored pair(s)
[18:49:07] rdv: pair 4e823a41-…: episode started — role=caller, epoch=0, key check 77265c75, phase=quiet (standby-only)
   … 7 episodes total, all (standby-only) …
[18:49:08] rdv: pair …: carrier up, subscribed to 3 day-topic(s)   ×7
[18:49:10] mqtt: [hivemq] broker session up in 3254ms (21 subscription(s) re-issued)
```

Transport is **healthy**. Two of three brokers up, all 7 armed pairs subscribed
to their correct day topics (7 × 3 = 21). Nothing failed. The device is
deliberately mute.

### Mechanism

Two gates decide "should we reconnect", and they use **different predicates for
the same intent**:

- **Boot gate** — `index.html:1548`:
  `const boot = recentLive || callable;`
  A callable auto-reconnect peer is sufficient to boot the bridge.
- **Resume gate** — `arcade-p2p.js:2431` (`resumeRendezvous`):
  `const fresh = ts && Date.now() - ts <= RESUME_WINDOW_MS;` (6h,
  `arcade-p2p.js:296`). Only `fresh` reaches `rdv.resumeAll()`. When not fresh,
  `callable` selects only between *staying cold* (`:2435`) and
  `rdv.standbyAll()` (`:2440`). **`callable` can never produce an active
  episode.**

1911m = 31.9h, so A took the standby branch.

A standby episode initiates nothing, by construction:

- `rendezvous-episode-core.js:436` — `SETUP_DONE`: `if (m.standbyOnly) return
  ok([])`. No `armOffer` (caller), no `armRing` (listener). Subscribe only.
- `rendezvous-episode-core.js:497` — `NUDGE`: `if (m.standbyOnly || … ) return
  ok(effects)` where `effects` is `ensureAlive` alone. **A nudge verifies the
  socket and publishes nothing.**
- `rendezvous.js:1439-1441` — standby episodes "initiate nothing until a ring
  (caller role) or an offer (listener role) provokes them."

So the escape from standby is strictly an **inbound** ring or offer. If every
device on a pair launches outside its own 6h window, every device is standby,
nobody publishes, and the pair stays silent indefinitely while both ends sit
subscribed to the right topics. That is the deadlock A was in with both B and C.

The 18:51:50 nudges (suspend detection ~93s, then page-visible) both fired
correctly and could not help — exactly as the NUDGE row specifies.

### Why B ↔ C worked

Not a state difference: almost certainly a human. Either one of them tapped
**📞 Call** (`index.html:2654` → `callKnownPeer` → `resumePair`, which
`rendezvous.js:587` "escalates quiet/standby to fully-active"), or they ran a
fresh ceremony. Worth confirming with B's and C's logs — if either shows an
active (non-standby) resume with no user action, this analysis is incomplete.

### Fix candidates

1. **Let the listener role ring while in standby.** Minimal change, directly
   dissolves the deadlock: one side rings, the ring provokes the caller, the
   normal exchange runs. The subscription is *already* standing on the same
   daily-rotating topics, so the marginal exposure is publishing on a topic you
   already listen to — but it is still the §7.5/§9 privacy trade and needs an
   explicit decision, not an assumption.
2. **Make the two gates agree** — promote `callable` to `resumeAll()`.
   Simplest to reason about; burns a full repair episode on every cold launch
   for every enabled pair (8 pairs here), which is what the window was
   protecting against.
3. **Surface the escape hatch.** `📞 Call` exists but renders only in the
   expanded row (`index.html:2649-2667`); the collapsed list in the screenshot
   shows just the 🔁 auto-reconnect chip. Even a user who knows the system had
   no visible affordance. Worth doing regardless of 1 or 2.

**Independent of which is chosen:** the two gates disagreeing is itself a
defect. The boot gate's log line advertises `callable auto-reconnect peer: yes
→ booting multiplayer bridge`, which reads as a promise the resume gate does not
keep. Whatever the policy becomes, one predicate should express it.

### Decision needed

Which of 1 / 2 / 3 (or a combination), and specifically whether standby may
publish a ring.

---

## Track 2 — Topology: "party" is scoped one layer too high

**Status: hypothesis, not confirmed. Confirmation requires a live capture —
see protocol below.**

### Hypothesis for "C cannot see the hosted game"

`p2p-ui.js:486` — "Start a party" **always mints a fresh party**:

```js
const partyId = opts.partyId || this.peerNode.createParty();
```

The only path that adds a device to an *existing* star is the party card's
"Invite another player" (`index.html:2505`), which passes the live `partyId`
into `show({mode:'host', partyId})` (`p2p-ui.js:458-460`).

If the A↔C ceremony went through "New connection → Start a party", A now holds
**two disjoint parties**: {A,B} and {A,C}. Then:

- a running game binds to exactly one party (`arcade-p2p.js:410`, `gameParties`);
- relay is scoped by the **arrival link's** party (`p2p-core.js:685-702`);

…so C is paired, healthy, reachable, and structurally invisible to the game,
while A↔B gameplay is completely undisturbed. That matches the observation
exactly, including the absence of any error.

### Why it cannot be confirmed from the captured evidence

Party ids are **RAM-only** (`p2p-core.js:259`, `arcade-p2p.js:403-409`); only a
derived key survives in `knownPeers[dev].party`. With nothing connected there is
no party to render, and the captured Multiplayer screen shows **no Parties
section at all** — just `LINKED DEVICES` with four rows.

### Live-capture protocol (do this first, before any redesign)

On one network, in one sitting:

1. A ↔ B ceremony via **New connection → Start a party**. Launch cardstock on
   both, confirm play.
2. On A, open Multiplayer and **screenshot the Parties section** (expect one
   party card).
3. A ↔ C ceremony **deliberately via New connection → Start a party** (repeat
   the original mistake).
4. On A, screenshot Multiplayer again. **Two party cards confirms the
   hypothesis outright.**
5. C launches cardstock — expect "no hosted game".
6. Now on A, from the {A,B} party card, tap **Invite another player** and
   re-pair C through that path. C should now see the game. If it does, the
   hypothesis is proven and the failure is entirely a wrong-door problem.
7. Export A's connection log for the whole sequence.

If step 4 shows **one** party, the hypothesis is wrong and the investigation
should pivot to `gameParties` attachment and `indirectByParty` /
`hubCapsByParty` population for a late-joining member.

### The argument for rescoping regardless of the outcome

The captured screenshot is the strongest evidence in this document. The object
that decided C could not see the game is:

- **invisible** when not connected (no row, no name, no inspector),
- **non-durable** (RAM-only id),
- **non-repairable** (no merge, no move-device-into-party),
- yet **decisive** over game visibility.

Meanwhile the surface the user *can* manage — a flat list of four linked
devices — is already the connection-first model. The party layer is precisely
the part that is not represented there.

Three structural objections, independent of the bug:

1. **The decision happens at the wrong moment.** Party membership is fixed
   during the pairing ceremony; the actual intent ("A, B and C at one table") is
   only known at game launch. Two visually identical doors, and the wrong one is
   unrecoverable without a re-ceremony.
2. **It stores what is derivable.** The star is computable at host time from
   *host's connections* × *who accepted*. Storing it early lets it disagree with
   intent, and the bridge must carry `partyKeys`, `partyByKey`, `gameParties`,
   `partyStatuses`, `indirectByParty`, `hubCapsByParty`, `adoptPartyId`, plus a
   GC sweep timer (`arcade-p2p.js:252-274, 403-426`) — each a place membership
   can drift.
3. **It leaks into the relationship layer.** `leaveParty` (`arcade-p2p.js:2014`)
   calls `setKnownPeerPaused(dev, true)` on every link in the party, directly
   under a docstring asserting "a party is not a relationship" and "Pairings
   (secrets, names, sync/backup flags) all survive". *(Note: this did NOT cause
   the Track 1 failure — the log proves the peers were callable and unpaused —
   but it is a live inconsistency in the same layer.)*

Note that the design document already argues the user's position: the
thin-party principle (`plans/multi-party-2026-07.md:41-57`) defines a party as
"a named ceremony-star and nothing more" and puts seating in the games. The
implementation materialized it one layer higher than the principle asks.

### Proposed model

Keep the relay star as a **runtime-only** fact. It is not optional: games are
sandboxed iframes and cannot create links, so joiner→joiner frames must transit
the host's launcher. Delete "party" as a **user-facing, pre-declared, persisted
object**.

- **Connection** — durable, symmetric, one flat list. Call / Hang Up. No roles.
  The only thing a user manages. *(This already exists and already works.)*
- **Table** — ephemeral, per-game, host-anchored. Host taps Host, picks from
  their connections (or opens to all); invitees get a prompt. The table's link
  set is the relay scope. Dies with the game. Persists nothing.

### Vocabulary for the redesign

Two distinct graphs, currently conflated:

- **Connection graph** — durable, symmetric, sparse, undirected. A–B and A–C;
  B and C non-adjacent.
- **Table** — a host-rooted relay star spanning a subset of the host's **ego
  network** (graph-theory term for a node plus its direct neighbours).

One sentence: *a table is a host-rooted relay star drawn from the host's ego
network; seating does not require players to be adjacent to each other.*
"Sparse star" is fine colloquially but hides that these are two different
graphs with different lifetimes.

### Decisions required before implementation

1. **Relay scope keying — security-critical, settle this first.** Today's
   invariant is that party ids never travel on the wire and a frame's scope
   comes from its **arrival link** (`p2p-core.js:259-265`). Keying scope on
   `gameId` instead would derive it from a value *inside the frame*, i.e.
   member-forgeable. Any table model must keep scope derived from arrival link
   plus a host-side table map, never from frame content. The `relayed`
   stamp/strip anti-spoof (`p2p-core.js:696-702`) has to survive the change
   unchanged.
2. **Can a member invite?** No — forced by physics. If B wants D at A's table, D
   must pair with A first. Decide how that surfaces ("ask the host to connect
   with D") instead of leaving it a dead end.
3. **Do B and C see each other's names?** They must, to be seated
   (`indirectByParty` exists for exactly this). Under "party" the user
   implicitly consented by joining a named group; connection-first has no such
   moment. Does seating need a disclosure?
4. **Does hosting announce to the whole connection list?** That is the free
   association the field test wanted — it also broadcasts presence to the
   MacBook and the old phone. Per-connection opt-in, per-game, or unrestricted?
5. **What may pause auto-reconnect?** Proposed: only an explicit Hang Up on a
   connection. Ending a game must never touch reconnection state (see objection
   3).
6. **Migration** for `knownPeers[dev].party` records already in the field on
   three devices.

---

## Secondary observations

- **8 stored pairs, 7 armed episodes, 4 linked devices.** One pair was skipped
  by `standbyAll`'s filter (`rendezvous.js:1371-1372`: `!enabled`, no
  `lastPeerId`, or `lastSeenAt` older than `standbyMaxAgeMs` = 30d). Four pair
  records have no UI row at all — either repeat ceremonies mint new pairIds
  without retiring old ones, or known-peer entries were removed while pair
  records survived. Not a cause of either failure, but it is state drift in the
  layer Track 2 would rewrite, and it costs 3 broker subscriptions per orphan.
- **mosquitto failed all nine dial attempts** (`test.mosquitto.org:8081`, every
  one a socket error inside ~600ms). emqx and hivemq carried the session fine,
  so this is cosmetic — but it produces roughly half the log volume and will
  distract anyone reading the capture. Consider a per-carrier failure budget
  that stops retrying a broker that has never once succeeded this session.
