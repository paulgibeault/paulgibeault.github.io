# Vendored: QRCodeP2P

Serverless WebRTC transport (packed QR/link signaling) powering `Arcade.peer.*`.

- **Upstream:** https://github.com/paulgibeault/QRCodeP2P — develop and test
  transport changes THERE (it has the unit/e2e/cross-engine suites), then sync.
- **Synced from commit:** `bbfd170` (2026-07-06)
- **Re-sync:** `./tools/sync-p2p.sh` (copies modules, records the commit here)

`vendor/` holds the two QR libraries (qrcodejs 1.0.0, html5-qrcode 2.3.8) so
the launcher never touches a CDN at runtime: `arcade-p2p.js` loads them as
local scripts *before* `P2PAddon.init()`, whose loader skips any global that
already exists. Do not upgrade these without re-testing the scan flow.
