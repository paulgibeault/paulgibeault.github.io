# p2p/ — WebRTC transport

Serverless WebRTC transport (packed QR/link signaling) powering `Arcade.peer.*`.

**Maintained in this repo.** This tree began as a vendored copy of
`paulgibeault/QRCodeP2P` (now archived) and became the transport's sole home
in 2026-07: the v1.10 reconnect-lifecycle hardening (self-healing
MqttCarrier, standby/ring/bye, exchange nonces) and the v1.11 targeted sends
(`PeerManager.sendTo`, `noRelay` app-frame flag, host-side stripping of
forged inbound `relayed`) were developed here and never ported back. The
authoritative protocol spec lives beside the code in `p2p/PROTOCOL.md` —
keep it in lockstep with any wire-format or state-machine change.

End-to-end coverage for the launcher-facing behavior lives in
`tools/p2p-acceptance.mjs`, `tools/p2p-reconnect-acceptance.mjs`, and
`tools/p2p-multiseat-acceptance.mjs`.

`vendor/` holds the two QR libraries (qrcodejs 1.0.0, html5-qrcode 2.3.8) so
the launcher never touches a CDN at runtime: `arcade-p2p.js` loads them as
local scripts *before* `P2PAddon.init()`, whose loader skips any global that
already exists. Do not upgrade these without re-testing the scan flow.
