# Implementation roadmap — sovereign framework, batch 1

*Decisions (2026-07-10): implement **quick-wins + security + storage foundation** now; commit to a
**first-party fleet** trust posture (cross-origin multi-tenancy is a named v2 epic). Everything
beyond batch 1 is captured as a detailed GitHub issue — see the index at the bottom. Companion to
`framework-evolution.md` (the why) and `fleet-hardening-plan.md` (security/bug backlog).*

**Strategy:** land the framework changes first (Phase 0 → Phase 1), each as its own PR gated by
`npm run acceptance`; then refactor the apps to adopt them (Phase 2). Sovereignty features that
build on the storage foundation (sync, backup, encrypted export) are sequenced *after* this batch,
as issues, because they depend on Phase 1 landing first.

---

## Phase 0 — Framework quick-wins + security (days, low risk) — ✅ IMPLEMENTED 2026-07-10

Committed and merged to `main`. All items done; P2P acceptance green
(`node tools/p2p-acceptance.mjs`), JS syntax sweep green.

Order chosen so each PR is independently shippable and bisectable.

### P0.1 — LICENSE + vendored-code licensing · framework repo
- Add a top-level `LICENSE`. **Decision needed (small):** Apache-2.0 (patent grant — sensible given
  the P2P/crypto code) vs MIT (simplest). Default recommendation: **Apache-2.0**.
- Add `license` to `package.json`. Confirm/propagate a license for the vendored `p2p/` tree
  (originates from `paulgibeault/QRCodeP2P`) — add a `p2p/NOTICE` if that repo's license differs.
- **Accept:** `LICENSE` present; `package.json` `license` field set; no unlicensed vendored code.

### P0.2 — `Arcade.html.escape` + safe-render helper · `arcade-sdk.js`
- Add `Arcade.html.escape(str)` (the p2p-chat implementation, `app.js:16-20`, is the reference) and
  a tagged-template `Arcade.html\`…\`` that auto-escapes interpolations.
- **Accept:** unit probe — `escape('"><img src=x onerror=alert(1)>')` yields inert text; tagged
  template escapes interpolations but not the literal.
- *Refactor target for Phase 2:* this is the fix for the **live sowduku stored XSS** and hardens the
  5 other games that build `innerHTML` without escaping.

### P0.3 — Surface storage failures + durability · `arcade-sdk.js`, `index.html`
- `Arcade.state.set()` returns the write-success boolean it currently discards
  (`arcade-sdk.js:694-703`); same for `scores.add`/`stats.update`. Backward-compatible (was
  `undefined`).
- Add `Arcade.storage.estimate()` (wraps `navigator.storage.estimate()`) and
  `Arcade.onStorageError(fn)` fired on any quota-denied write.
- Call `navigator.storage.persist()` once on launcher boot (`index.html`) — today the browser may
  evict the **entire** origin under pressure.
- **Accept:** filling quota fires `onStorageError` and `set()` returns `false`; `persist()` invoked
  on boot (verify via `navigator.storage.persisted()`).

### P0.4 — CI test gate · `.github/workflows/`
- New workflow: stage launcher + a fixture app via `dev.sh`, run `tools/acceptance.mjs` (per-game +
  `--pool`) and `tools/p2p-acceptance.mjs` headless on PRs; **block the Pages deploy on failure.**
- The harnesses already exist — this is wiring. (Also `fleet-hardening` D1, "highest leverage.")
- **Accept:** a PR that breaks an acceptance check fails CI; green PR deploys.

### P0.5 — Security fixes (implement now, from the P2P review) · `arcade-p2p.js`, `p2p/`
- **Fingerprint-pin overwrite:** `recordPeerIdentity` (`arcade-p2p.js:226-228`) must **not** overwrite
  the stored pin when the user declines re-trust; persist suspicion (`pinPendingFingerprint`) instead
  of the RAM-only `fingerprintSuspects` Set. *(This is a real auth bug — also append to issue #21.)*
- **MQTT inbound size cap:** reject PUBLISH payloads over ~16 KB at the parser
  (`p2p/rendezvous-carriers.js` ~113-154) before buffering/dedup; legit sealed blobs are ≤~2 KB.
- **Accept:** a declined-imposter fingerprint does not become the trusted pin after reload; an
  oversized MQTT publish is dropped without buffering.

---

## Phase 1 — Storage foundation (the gate for non-game apps) · `arcade-sdk.js`, `index.html`

> **Status 2026-07-10:** P1.1 (`Arcade.store`) + P1.2 (`Arcade.files`) shipped (PR #45, merged).
> **P1.3 export wiring DONE** — the launcher enumerates per-app IndexedDB/OPFS and includes
> `stores`/`files` in the save bundle (schema v2); import restores them; P2P key stores are
> excluded. Verified by `tools/export-roundtrip-acceptance.mjs` (seed→export→wipe→import, asserts
> `qrp2p-*` untouched) and wired into CI. **Docs refreshed** (GAME_INTEGRATION §3/§3a/§7b/§13 +
> ARCADE_PLATFORM SDK-shape/storage/save-format/trust-model).
>
> **Status 2026-07-12 — #43 CLOSED (boundary made real):** the "dedicated worker / partitioned
> handle" idea was unimplementable — IndexedDB is origin-scoped, so any persistence root the
> launcher can reach, a same-origin app could reach too. The real fix shipped instead: game
> iframes are sandboxed **without `allow-same-origin`** (opaque origin ⇒ no origin storage at
> all, key stores included) and the SDK transparently bridges `state/store/files/storage` over
> postMessage to the launcher, which enforces per-app namespacing at the boundary. Same
> `arcade.v1.*` names, so saves/export are untouched. Enforced in CI by
> `tools/bridge-acceptance.mjs`; all five staged games verified booting + persisting bridged.

### P1.1 — `Arcade.store` (async per-app KV over IndexedDB)
- `Arcade.store.open(name?) → { get, set, del, keys, each, clear }` (promise-based), backed by a
  per-app IndexedDB database `arcade.v1.<appId>` (default store `kv`). Namespaced like the existing
  localStorage prefix; the repo already uses IndexedDB for RTC certs, so the dependency is proven.
- **Accept:** values survive reload; two apps' stores are isolated; `keys()` enumerates.

### P1.2 — `Arcade.files` (blob store)
- `Arcade.files.put(name, blob) / get(name) / list() / delete(name)`, backed by OPFS where available,
  IDB-blob fallback otherwise. This is what a notes/photo/document app needs; base64-into-localStorage
  is not viable.
- **Accept:** a multi-MB blob round-trips; `list()` returns names+sizes; survives reload.

### P1.3 — Wire both into export + document the trust boundary
- The launcher export bundler (`index.html:1368-1397`) awaits async exporters registered by
  `store`/`files` so their data is included in save export/import (full-fidelity backup).
- **First-party trust boundary (per the chosen posture):** document in `ARCADE_PLATFORM.md` /
  `GAME_INTEGRATION.md` that **apps are first-party and fully trusted** (same-origin, shared storage
  is a convention not a sandbox). As hardening under that posture, **move the P2P key stores
  (`qrp2p-rendezvous`, `qrp2p-identity`) out of casual app reach** (e.g. a dedicated worker /
  partitioned handle) so a game can't drive the rendezvous protocol with the device identity.
- **Accept:** an app's `store`/`files` data appears in the export bundle and re-imports faithfully;
  docs state the trust model explicitly.

> **Note:** async `store`/`files` in the export path also **unblocks** the deferred sovereignty
> issues (encrypted per-app export, auto-backup, state sync, backup-to-peer) — they all consume
> these exporters. That's why this foundation lands before them.

---

## Phase 2 — Refactor the apps to adopt batch-1 framework features

Small, per-repo PRs. Do the cleanest hand-rollers first (cozy-solitaire, pi-game) as references.

| App | Adopt | Priority |
|-----|-------|----------|
| **sowduku** | `Arcade.html.escape` at all 4 `innerHTML` sinks → **fixes the live stored XSS**; also the migration sentinel | **HIGH — do first** (folds into the already-planned sowduku #4) |
| si-syn, pi-game, hecknsic, cozy, moon-lit | `Arcade.html.escape` wherever they build `innerHTML` with dynamic/user text | MED |
| all games with a `state.set` hot path | `onStorageError` toast + honor the new `set()` boolean | LOW |
| p2p-chat | drop its private `escapeHtml`, use `Arcade.html.escape` | LOW (cleanup) |
| (optional reference) | one game demonstrates `Arcade.store`/`files` for larger data | LOW — proves the seam |

Games are small-state, so `store`/`files` adoption is optional for them — the payoff is future
non-game apps. A short reference adoption (e.g. sowduku moving its pack library to `Arcade.store`)
is worth one PR to validate the API.

**Gate:** every app PR must pass `npm run acceptance` (now enforced by P0.4 CI once both land).

---

## Deferred → GitHub issues (all in `paulgibeault/paulgibeault.github.io`, filed 2026-07-10)

Captured in detail per the instruction. Sequenced *after* batch 1; the sovereignty group depends on
Phase 1 storage landing first.

**Sovereignty (depends on Phase 1 storage):**
- ✅ [#28](https://github.com/paulgibeault/paulgibeault.github.io/issues/28) `Arcade.sync` — multi-device per-key LWW state replication over P2P *(crown jewel)* — **DONE** (merged #62)
- [#29](https://github.com/paulgibeault/paulgibeault.github.io/issues/29) Per-app + passphrase-encrypted export; reconsider the hand-edit checksum hard-reject
- ✅ [#30](https://github.com/paulgibeault/paulgibeault.github.io/issues/30) Automatic local backup (rolling IDB snapshot + File System Access folder) — **DONE** (`arcade-local-backup.js`/`arcade-local-backup-core.js`, PR #65)
- ✅ [#31](https://github.com/paulgibeault/paulgibeault.github.io/issues/31) Backup-to-trusted-peer — **DONE** (merged #64)
- [#32](https://github.com/paulgibeault/paulgibeault.github.io/issues/32) Cross-device user identity (Ed25519 cross-sign) + recovery + `revoke(deviceId)`
- ✅ [#33](https://github.com/paulgibeault/paulgibeault.github.io/issues/33) Self-hostable broker + TURN config (`_meta.rdvBrokers`) — **DONE** (G-res-1: `_meta.rdvBrokers` override landed in #54; the cheapest resilience win, promoted out of the deferred pile). TURN config still open.

**Platform surface:**
- ✅ [#34](https://github.com/paulgibeault/paulgibeault.github.io/issues/34) Data-driven catalog (`catalog.json`) — **DONE**: grid + profile cards + SW icon precache all render from it; fixture catalog unblocked the --pool CI gate
- [#35](https://github.com/paulgibeault/paulgibeault.github.io/issues/35) `Arcade.ui` dialog bridge (confirm/prompt/setTitle/onBeforeQuit/open-file/share)
- ✅(½) [#36](https://github.com/paulgibeault/paulgibeault.github.io/issues/36) Deep links (`#app=<id>`) — **DONE**; the neutral `appId`/`Platform.*` vocabulary half remains open

**Pattern lifts (games → SDK):**
- ✅ [#37](https://github.com/paulgibeault/paulgibeault.github.io/issues/37) `Arcade.rng` + `Arcade.daily` + `Arcade.share` — **DONE** SDK-side (local-midnight daily rule is the platform contract); game adoption is per-repo follow-up
- [#38](https://github.com/paulgibeault/paulgibeault.github.io/issues/38) `Arcade.audio`
- [#39](https://github.com/paulgibeault/paulgibeault.github.io/issues/39) SDK pattern-lift batch: `tween`/`fx.burst`, `canvas.autosize`, SW template, `ui.guide`, `firstRun`, `fmt.*`, `undo`, `telemetry`, `ui.safeArea`

**Adoptability:**
- [#40](https://github.com/paulgibeault/paulgibeault.github.io/issues/40) Adoptability epic — de-brand, starter template, SDK versioning, framework/content split, PWA polish

**Security / robustness (not in batch 1):**
- ✅ [#41](https://github.com/paulgibeault/paulgibeault.github.io/issues/41) P2P robustness follow-ups: blob integrity/abort — **DONE** (closed by #51: per-blob hash + `blob-abort` + TTL). Handshake race and eviction suspend-hint addressed in the #54 remediation.
- ✅ [#43](https://github.com/paulgibeault/paulgibeault.github.io/issues/43) Document first-party trust boundary + move P2P key stores out of app reach *(Phase-1 P1.3)* — **DONE** (closed)

**v2 epic:**
- [#42](https://github.com/paulgibeault/paulgibeault.github.io/issues/42) Cross-origin multi-tenant app isolation + capability/permission model + user-added app URLs
  *(explicitly deferred by the first-party decision; the "break dependence on app stores" endgame)*

> Batch-1 security fixes (P0.5) are handled in this effort, not issue-ified: the **fingerprint-pin
> overwrite** is also appended to the existing security tracker **#21**; the **MQTT inbound size cap**
> lands with it.
