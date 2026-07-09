# p2p/ — WebRTC transport (formerly vendored from QRCodeP2P)

Serverless WebRTC transport (packed QR/link signaling) powering `Arcade.peer.*`.

**Maintained IN THIS REPO as of 2026-07-08.** This tree began as a vendored
copy of https://github.com/paulgibeault/QRCodeP2P (last sync: `06f212b`,
2026-07-06) and has since evolved past it — the v1.10 reconnect-lifecycle
hardening (self-healing MqttCarrier, standby/ring/bye, exchange nonces) lives
here. Do NOT run `tools/sync-p2p.sh` without first reconciling: it copies
upstream files over this tree. End-to-end coverage for the launcher-facing
behavior lives in `tools/p2p-acceptance.mjs` and
`tools/p2p-reconnect-acceptance.mjs`.

`vendor/` holds the two QR libraries (qrcodejs 1.0.0, html5-qrcode 2.3.8) so
the launcher never touches a CDN at runtime: `arcade-p2p.js` loads them as
local scripts *before* `P2PAddon.init()`, whose loader skips any global that
already exists. Do not upgrade these without re-testing the scan flow.
