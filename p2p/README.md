# p2p/ — WebRTC transport

Serverless WebRTC transport (packed QR/link signaling) powering `Arcade.peer.*`.

**Maintained in this repo.** This tree began as a vendored copy of
`paulgibeault/QRCodeP2P` (now archived) and became the transport's sole home
in 2026-07: the v1.10 reconnect-lifecycle hardening (self-healing
MqttCarrier, standby/ring/bye, exchange nonces), the v1.11 targeted sends
(`PeerManager.sendTo`, `noRelay` app-frame flag), the v1.12 extras trailer,
the v1.13 parties work and its **v1.14 removal**, and the removal of the
rendezvous key ratchet were all developed here and never ported back.
**Treat the archived QRCodeP2P repo's protocol docs as historical** — they
still describe the removed ratchet as live. The authoritative protocol spec
lives beside the code in `p2p/PROTOCOL.md` — keep it in lockstep with any
wire-format or state-machine change.

**What this transport does NOT do, as of v1.14: forward a frame from one link
to another.** There is no hub and no relay; a node dispatches every app frame
to its own listeners and re-emits it nowhere (§5.6). Which games may exchange
frames over a given link is decided one layer up, by the launcher bridge's
open-game scopes (`arcade-p2p.js`) — the transport knows about links, not
games. If you are reading this file to find the fan-out code, it is gone on
purpose: `plans/tables-2026-08.md` records the evidence that no game in the
fleet consumed it.

End-to-end coverage for the launcher-facing behavior lives in
`tools/p2p-acceptance.mjs`, `tools/p2p-reconnect-acceptance.mjs`,
`tools/p2p-multiseat-acceptance.mjs`, `tools/p2p-multiparty-acceptance.mjs`
(the scope-acceptance suite — the name is historical) and
`tools/p2p-invite-ux-acceptance.mjs`.

`vendor/` holds the two QR libraries (qrcodejs 1.0.0, html5-qrcode 2.3.8) so
the launcher never touches a CDN at runtime: `arcade-p2p.js` loads them as
local scripts *before* `P2PAddon.init()`, whose loader skips any global that
already exists. Do not upgrade these without re-testing the scan flow.
