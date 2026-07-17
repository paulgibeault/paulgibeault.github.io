# Positioning — how Paul's Arcade compares to its neighbors

This document places the platform honestly against the projects a developer
would compare it to. Every comparison below follows the same pattern: the
incumbent's advantage is **distribution, ecosystem, or ceremony-cost** —
network effects and hosted convenience — while this platform's advantage,
where it has one, is **engineering quality under a constraint the incumbents
refuse**: zero servers, zero accounts, zero build step, zero ads, zero
telemetry.

That constraint is the product. Paul's Arcade is not trying to win a game
portal's distribution race or a multiplayer vendor's convenience race. It is
quality personal software: a demonstration that a real game platform —
shared storage, cross-device saves, encrypted P2P multiplayer — can exist
with **no business model attached to the player**. None of the projects
below can make that claim, and for most of them that's not a criticism;
their business models are the reason they exist. Ours is the reason we
don't need one.

The comparisons group by layer, because the platform spans several:

| Layer | This repo | Closest neighbors |
|---|---|---|
| Game SDK + launcher shell | `arcade-sdk.js`, `index.html` iframe pool | [Poki SDK](#poki-sdk), [CrazyGames SDK](#crazygames-sdk) |
| Distribution venue | GitHub Pages, one static origin | [itch.io](#itchio) |
| Multiplayer infrastructure | `p2p/` WebRTC transport, rendezvous auto-reconnect | [Playroom Kit](#playroom-kit), [PartyKit](#partykit) |
| Serverless signaling | `p2p/rendezvous*.js` over public MQTT | [Trystero](#trystero) |
| WebRTC ergonomics | `p2p/p2p-core.js`, `sdp-codec.js` | [PeerJS](#peerjs) |
| Cross-device sync | `arcade-sync-core.js` (HLC + per-key LWW) | [Yjs](#yjs), [Automerge](#automerge) |

---

## Game portal SDKs

### Poki SDK

**[Poki for Developers](https://developers.poki.com/)** — the SDK behind
poki.com, one of the largest web-game portals in the world.

Poki is the closest shape-match to `window.Arcade`: lifecycle signals
(loading, gameplay start/stop), a curated launcher shell around iframed
games, per-game data. Its strengths are overwhelming and have nothing to do
with API design: **distribution and money**. Poki serves tens of millions of
players a month; integrating their SDK gets a game discovered and gets its
developer paid. For a developer deciding where to spend an integration
afternoon, that ends the conversation.

Where we differ:

- **The SDK surface.** Roughly half of Poki's API is ad plumbing —
  `commercialBreak()`, `rewardedBreak()` — because ads are the business.
  `window.Arcade` has no ad surface, no analytics surface, and no consent
  banner, because there is nothing to consent to. The player-facing
  difference is not subtle.
- **Isolation model.** Poki solves game isolation with separate sandbox
  origins (games served from `poki-gdn.com`-style CDN domains). We solve it
  with opaque-origin sandboxed iframes on a single origin, plus the
  storage bridge (`arcade-storage-bridge.js`) that grants each game a
  namespaced slice of storage through a mediated channel. Theirs is the
  boring solution that scales to thousands of untrusted third-party
  submissions; ours is the more interesting one for a curated catalog on a
  static host — no CDN, no second domain, and the launcher retains full
  policy control over every byte a game persists.
- **Who the player is to the platform.** On an ad-funded portal the player
  is inventory. Here the player is the owner: saves export to a local file,
  optionally passphrase-encrypted, and nothing leaves the device unless the
  player points two devices at each other.

### CrazyGames SDK

**[CrazyGames for Developers](https://developer.crazygames.com/)** ·
[SDK docs](https://docs.crazygames.com/)

Structurally the same story as Poki: a large ad-funded portal with an SDK
covering ads, user accounts, cloud data, and in-game purchases. CrazyGames'
distinguishing strengths are its account system (cross-device progress via
*their* accounts) and revenue share for developers.

The account system is the sharpest contrast with this platform. CrazyGames
achieves cross-device saves by owning the identity and the storage;
we achieve them with `arcade-sync.js` — HLC-ordered, per-key
last-writer-wins replication directly between the player's own devices over
an end-to-end-encrypted WebRTC channel. Same player-visible feature,
opposite custody: their answer is "trust us with it," ours is "it never
existed anywhere but your devices."

### itch.io

**[itch.io](https://itch.io/)** — the indie distribution venue.

itch.io isn't an SDK and doesn't compete on architecture at all; it wins
purely on being *the* place indie games live: an existing audience, an
upload pipeline ([butler](https://itch.io/docs/butler/)), pay-what-you-want
economics, and community events (game jams) that no personal site can
replicate. It is also, credit where due, the least extractive of the
distribution players — generous revenue splits, no forced ads.

The difference is scope of ambition. itch.io hosts your HTML5 game in an
iframe and stops there; there is no shared storage contract, no
cross-device saves, no multiplayer transport, no launcher settings that
games respect. This platform is the opposite trade: a catalog of five games
instead of a million, but every one of them gets platform services itch
doesn't offer. The two aren't really rivals — a game could ship on itch
*and* integrate here — but for discovery, itch wins and always will.

---

## Multiplayer infrastructure

### Playroom Kit

**[Playroom Kit](https://joinplayroom.com/)** ·
[docs](https://docs.joinplayroom.com/)

Playroom does the exact user-facing thing our pairing ceremony does — get
two phones into the same game session, including QR-code joins — and does it
with less friction, because a hosted room server means joining is **one
scan, zero tennis**. Add React hooks, hosted state sync, and a genuinely
fast time-to-first-multiplayer, and Playroom is the right answer for the
95% of developers who don't share our constraint.

The price of that convenience is precisely what this platform refuses to
pay: servers, accounts, pricing tiers, and a vendor who can change terms or
disappear. Every session flows through infrastructure the players don't
control and can't inspect.

Where the gap has narrowed since the original assessment: the remaining
friction here is mostly **first-pairing** friction. Once two devices have
paired once, [auto-reconnect](SELF_HOSTING.md) re-signals through a
rendezvous dead-drop with no ceremony at all — and that dead-drop is
*untrusted by construction*: payloads are end-to-end AEAD-sealed with
per-pair ratcheting keys on unlinkable daily-rotating HMAC topics, so the
worst a malicious broker can do is delay or drop. Playroom cannot make that
claim about its room server, structurally — the server has to see the
session to host it. And for players who want zero third parties at all, the
broker and TURN are [self-hostable](SELF_HOSTING.md) from the Multiplayer
dialog, no devtools required.

### PartyKit

**[PartyKit](https://www.partykit.io/)** — open-source realtime
infrastructure on Cloudflare's edge (Durable Objects).

PartyKit is the more general, more serious version of the hosted approach:
a deployment platform for stateful realtime servers, popular in the
local-first and collaborative-app world (it pairs naturally with Yjs).
Strengths: real server-side authority (cheat-resistant game logic,
persistence, presence), global edge scale, and open-source server code you
can read.

Two differences matter. First, architecture: PartyKit is client-server
realtime — every message transits Cloudflare — where our transport is
peer-to-peer WebRTC with helpers (STUN, optional TURN, rendezvous broker)
that never see plaintext. Second, and instructive: PartyKit was
[acquired by Cloudflare in 2024](https://blog.cloudflare.com/cloudflare-acquires-partykit/).
That was a *good* outcome for PartyKit — and it is still the exact
dependency event this platform is designed to be immune to. A platform made
of static files and open protocols cannot be acquired out from under its
players.

---

## Serverless signaling

### Trystero

**[Trystero](https://github.com/dmotz/trystero)** — the closest
philosophical cousin in the list.

Trystero does serverless WebRTC signaling by piggybacking on public
infrastructure — BitTorrent trackers, Nostr relays, MQTT brokers, IPFS,
Firebase, Supabase — the same trick as our MQTT rendezvous carriers
(`p2p/rendezvous-carriers.js`). It wins on **adoption surface**: it's the
established, documented, multi-backend library with community mindshare
that a developer searching "serverless WebRTC" finds first, and its room
abstraction is pleasantly minimal.

Where we differ is protocol rigor at the layer that matters most, the one
carrying key material. `p2p/rendezvous-crypto.js` implements a proper HKDF
key schedule with non-extractable WebCrypto keys, AAD-bound AEAD sealing,
role-bound confirmation MACs, and a transcript-bound ratchet; topics rotate
daily under an HMAC so observers can't link sessions across days. Trystero
encrypts signaling payloads, but its threat model for the shared public
channel is considerably lighter. The full wire spec is in
[p2p/PROTOCOL.md](p2p/PROTOCOL.md) — publishing it for scrutiny is part of
the point. Trystero wins on mindshare; the protocol here is the stronger
artifact, and it's the piece of this repo most worth extracting as a
standalone library.

### PeerJS

**[PeerJS](https://peerjs.com/)** — the legacy incumbent for "WebRTC
without tears."

PeerJS wins on simplicity and a decade of Stack Overflow answers: one
`Peer` object, an ID, a `connect()` call. It loses on requiring a signaling
server (theirs or self-hosted PeerServer), plaintext-to-the-server
signaling, and years of architectural stagnation. It's relevant mostly as
the thing people will compare any WebRTC wrapper to, not as a live
alternative: it solves the easy 80% of the problem and leaves exactly the
parts this repo focuses on — signaling without a trusted server
(`sdp-codec.js` compresses offers into QR-sized payloads), identity pinning
across sessions, and encrypted auto-reconnect.

---

## Sync layer

### Yjs

**[Yjs](https://yjs.dev/)** — the dominant CRDT library for collaborative
apps.

### Automerge

**[Automerge](https://automerge.org/)** — Ink & Switch's CRDT, the research
heart of the [local-first](https://www.inkandswitch.com/local-first/)
movement.

These two are grouped because the comparison is the same. Both are
battle-tested against far nastier merge cases than we face, offer rich data
types (sequences, text, counters, nested maps), and anchor a whole
ecosystem of providers, storage adapters, and editor bindings. If this
platform ever needed real-time *collaborative* state — shared documents,
concurrent text — reaching for Yjs would be correct, not defeat.

Our `arcade-sync-core.js` is a deliberately simple subset: a hybrid logical
clock providing exact causal order, per-key last-writer-wins replication,
digest/diff exchange over the P2P channel. The engineering argument for the
subset is that game saves are checkpoint-shaped, not collaboration-shaped —
concurrent edits to the same save are a conflict to *resolve decisively*,
not merge structurally — and that the entire sync layer stays small enough
to read in a sitting and audit against the storage contract. The honest
caveat from the original assessment stands: nobody outside will give credit
for that restraint unprompted; they'll ask "why not Yjs," and this section
is the answer.

It's worth noting the local-first movement (Automerge's home) is the one
community in this list that shares our values — user-owned data, software
that outlives its vendor. The difference is means: they pursue it with
merge-theory sophistication; we pursue it with radical infrastructural
subtraction.

---

## The honest synthesis

Read down the comparisons and the pattern is uniform:

- **Where they win:** distribution (Poki, CrazyGames, itch.io), ceremony
  cost (Playroom, PeerJS), ecosystem and mindshare (Trystero, Yjs,
  Automerge, PartyKit). These are network effects and hosted convenience —
  real advantages, mostly unbeatable ones, and we are not trying to beat
  them.
- **Where we win:** the rendezvous protocol's cryptographic rigor, the
  opaque-frame privilege-separation model, the cleanliness of an SDK with
  no ad or telemetry surface, and the fact that the *entire platform* is
  auditable static files. Engineering quality is the currency here, and
  it's the only currency a solo static site can mint.

Two conclusions follow, and both are already the plan:

1. **The components stand alone.** `sdp-codec`, the rendezvous protocol,
   and the opaque-frame storage bridge are novel enough to publish as
   libraries and write-ups, where they compete on quality rather than
   distribution.
2. **The platform is the proof, not the portal.** As a game portal, this is
   an also-ran by construction. As a demonstration that a game platform
   with zero servers, zero accounts, zero build, zero ads, and zero
   telemetry is achievable at real quality — with cross-device saves and
   encrypted multiplayer, the features that supposedly *require* the
   servers — it has no competitor on this list, because every incumbent's
   business model forbids making the attempt. That niche is small. It is
   also genuinely ours.
