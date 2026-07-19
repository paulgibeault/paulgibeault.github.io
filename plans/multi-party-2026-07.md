# Multi-party: concurrent independent sessions per game

Field-test driver (2026-07-18): joined to a phone host, Paul could not open a
connection to his MacBook. "New connection" landed on the ceremony modal's
connected dead-end ("You're connected. Only the host can add more players")
instead of a Host/Join screen. Root cause is architectural, not UI: the
transport has one node-global `isHost` and one relay loop, so the whole device
is either the hub of one star or a leaf of one star
(`p2p/p2p-core.js` `createOffer()` role-flip guard; `p2p-ui.js
_renderChoiceButtons()` joiner branch hides both buttons).

## Target model

Three concepts, replacing the single device-global session:

- **Link** — one device↔device WebRTC connection (unchanged; still at most one
  per device pair; identity binding, resilience, replay, rendezvous repair all
  stay per-link).
- **Pairing** — a known-peer relationship usable without any party. Carries
  launcher envelopes only (identity / sync / backup / revoke / rendezvous ext)
  — these are already documented direct-link-only-never-relayed, so nothing
  changes on the wire. Backing up to the MacBook is a pairing, full stop.
- **Party** — a **named ceremony-star and nothing more**: a *disjoint* set of
  links with one hub. Per-party role: **leader** (hub, relays app frames
  within the party) or **member** (leaf, one link to the leader). A device may
  hold many parties plus bare pairings concurrently. `PeerManager.isHost` is
  replaced by per-party role.

Key simplification that avoids any wire-format change: **a link belongs to at
most one party**, so a frame's party resolves from the link it arrived on. The
leader relays an app frame arriving on party link L to the other links of
*that party only*. `relayed` stamping and inbound sanitization (PROTOCOL §5.6)
keep their exact semantics, scoped per-party.

Mixed-version compatibility: a leaf only ever observes its hub link plus
relayed frames — it cannot tell whether the hub or a fellow member holds other
parties. Old joiner ↔ new leader: fine. Old host ↔ new device that also
joins/hosts elsewhere: the old host never learns. PROTOCOL gets a minor
clarifying revision of §5.6, no version negotiation needed.

## Thin-party principle (who owns what)

"Party" does two jobs today conflated in "session"; they split, they don't
move together:

- **Physical (framework-owned, non-negotiable):** links, ceremonies, per-party
  role, relay, `relayed`-stamp anti-spoof, identity binding, exactly-once
  replay. Stars are physical facts created by humans scanning QR codes; games
  cannot create links, and relay necessarily runs in the launcher (games are
  sandboxed iframes — joiner→joiner frames transit the hub's launcher no
  matter who "owns" the party concept). These invariants stay below game code.
- **Logical (game-owned, via existing primitives):** who is *seated* in this
  game, lobbies, teams, spectators. The toolkit already exists — `peers()`
  roster, `onReady` per-game presence, targeted `sendTo`, `caps()` — and a
  game can already run "just A and me" inside a larger party by ignoring
  seats that never ready up. **The platform never grows a per-game membership
  model**; membership stays derived from each game's presence handshake.

Consequences verified in code:

- **One peer CAN play multiple games with you concurrently over one party.**
  Frames are gameId-namespaced (`{arcade:1, gameId, payload}`), and
  `arcade-pool.js` keeps backgrounded games mounted and running (LRU pool),
  so both devices can hold several live games at once over the same links.
- **Same peer in two different parties of yours is impossible** (one link per
  device pair; a link is in one party) — and unnecessary: any set of games
  between two devices runs over whichever single party contains both.
- **Two concurrent instances of the same game on one device is moot** — the
  iframe pool is keyed by gameId, so "each running game attaches to one
  party" is always well-defined.

## Game ↔ party attachment

- A running game binds to exactly one party. Its `Arcade.peer.*` surface
  (status, roster, send, caps) reflects only that party.
- Parties are **game-agnostic**: connect the household's devices once, play
  several games over the same party. Attachment policy is local-only:
  - one live party → auto-attach (today's behavior, zero new UX);
  - multiple parties → launcher shows a one-tap picker at game launch
    (party named by its leader), remembered while the party lives.
- **SDK star-selection hook** (small, cap-gated): games that care can
  introspect and choose instead of relying on the picker —
  `Arcade.peer.party()` → `{ id, role: 'leader'|'member', leaderName }` (the
  attached party), `Arcade.peer.parties()` → the list a game could attach to,
  `Arcade.peer.attach(partyId)` → request re-attachment (launcher confirms;
  resolves to the resulting party). Feature-detected via `caps()` like every
  other extension.
- Later, additive optimization (not correctness): presence-scoped relay
  filtering — the hub stops fanning game-X frames to seats that never
  readied X. Invisible to games.

## UI: teaching the physical topology to a lay user

Design stance: **show the topology structurally and teach it at the moment of
action — never with a network diagram or transport vocabulary.** Words like
host/joiner, hub, star, relay, link never appear; the only nouns are *party*,
*party leader*, and *linked devices*.

The three facts a lay user actually needs, and where each one lives:

1. **"A party happens through the leader's device."**
   - Structure carries it: the party card lists the leader first — crown
     badge, "Party leader" tag — with members indented beneath. The vertical
     hierarchy *is* the topology; no diagram.
   - Party is named by its leader: "Dana's party".
   - Moment of action: a member whose leader link is repairing sees
     "Reconnecting to Dana — the party runs through their device." A leader
     closing/leaving with an active party confirms: "You're the party leader —
     leaving ends the party for everyone." A member leaving: "Leave the
     party? The others keep playing."
2. **"New players scan the LEADER's screen."**
   - "New connection" always opens two big buttons whose captions teach the
     physics: **Start a party** — "friends join by scanning your screen" /
     **Join a party** — "scan the party leader's screen."
   - "Invite another player" appears only on the leader's device, captioned
     "new players scan your screen."
3. **"Linked devices are separate from parties."**
   - Saved connections stay a distinct "Linked devices" section with the
     existing phone-call metaphor (Call / Hang Up) plus purpose chips
     (💾 backup, 🔄 sync, 🔁 auto-reconnect). No roles here, ever — a pairing
     is symmetric.

Dialog layout (Multiplayer):

    [ Your device name ______ ]
    ( ⚇ New connection )                ← ALWAYS the Start/Join choice screen
    Parties
      ┌ 👑 Dana's phone  · Party leader   🟢
      │   ├ Sam's tablet                  🟢
      │   └ This device                   🟢
      │   Playing: Sowduku
      │   [Invite another player]* [Leave party]     *leader's device only
    Linked devices
      💻 MacBook   🟢 Connected   💾 🔁   [Hang Up]
      📱 Old phone  📵 Hung up        🔁   [Call] [New invite code]

Interaction rules:

- **"New connection" never shows status.** It is a verb — it always opens the
  Start/Join choice. The connected dead-end screen and its guard error are
  deleted.
- **Rows are the manage surface.** Tapping a party or linked-device row opens
  its detail (status, per-member health dots, the row actions that already
  exist today). Status screens are only reachable this way.
- Per-member health: the existing 🟢/🟡 dots only. No quality numbers, no
  paths, no fingerprints (those stay in the Connection log for debugging).
- Menu badge stays the aggregate ("2 connected").

Deliberately omitted from UI (helps nobody using the feature): relay paths,
who-forwards-what, per-link fingerprints, ICE/carrier state, the word
"topology". All of it remains available in the Connection log.

## Phases

1. **Core (p2p/)** — party objects in `PeerManager` (partyId on link init;
   per-party role; relay loop iterates party members), delete the role-flip
   guard in favor of per-party invariants (create-new-party always allowed;
   invite-into-party only as its leader), `statusSummary()` grows per-party
   breakdown, PROTOCOL.md §5.6 revision, unit tests (relay isolation between
   parties is the critical property: a frame must never cross parties, and a
   leader that is also a member elsewhere must never re-relay).
2. **Bridge (arcade-p2p.js)** — the heavy lift: per-party `hostCaps`,
   `indirectPeers`, seats/roster, status aggregation (menu badge stays
   aggregate; per-game status filtered by attached party). Per-game
   attachment (auto/picker/SDK hook) and per-game status/roster delivery.
   Persist party membership on the session stash + knownPeers so a rendezvous
   repair re-adopts a link into its party after interruption/restart. Watch
   the B-p2p-1 bug class (bindings outliving links) — every formerly-global
   map needs an explicit party-death story. No platform membership model
   (thin-party principle).
3. **Launcher UX (index.html + p2p-ui.js)** — the UI section above:
   New-connection routing, Parties + Linked devices sections, manage-on-row,
   leader-aware copy at the three teaching moments, game-launch party picker.
4. **QR polish (independent, small)** — size by min viewport dimension +
   raise the 360px cap; dedupe `#p2p-qr-canvas` (16px) vs `.p2p-qr-frame`
   (14px) frame rules; quiet zone → ~24px; standardize instruction copy
   across invite/answer/reconnect. Stretch: base45/alphanumeric-mode payload
   encoding (~2 QR versions smaller; version-gated sdp-codec change).

## Out of scope (explicitly)

- One physical device participating in two of MY parties over a single link
  (a link belongs to one party; the second party needs its own ceremony —
  consistent with one-link-per-device-pair, and unnecessary per the
  thin-party consequences above).
- Party reassembly of a NEVER-paired member after full browser restart
  (rendezvous already requires opt-in pairing; unchanged).
- Multi-party for games' own protocols — games keep the role-light
  `Arcade.peer` API; hub-spoke stays platform-owned. Games own *seating*,
  never *topology*.
- A platform-level per-game membership/lobby model (presence already covers
  it; see thin-party principle).
