# Arcade → Sovereign Application Framework — evolution plan

*Synthesis of four read-only architecture reviews (SDK/launcher core, P2P sovereignty layer,
cross-game pattern mining, developer-experience/distribution), 2026-07-10. Companion to
`fleet-hardening-plan.md` (which tracks the security/bug backlog). This doc is forward-looking:
what to build to make the arcade a general, shareable, sovereign local-first app platform.*

---

## Thesis & verdict

The vision: **applications that run locally, keep data under the user's sovereign control, never
phone home, and still feel modern** — with the arcade as the worked example and a template others
can adopt.

**Where it stands:** the *platform engineering* is genuinely strong and ahead of typical hobby
projects — disciplined lifecycle (suspend/resume, managed loop + suspend-aware timers), CSS-applied
settings, prototype-pollution-hardened state, a paranoid versioned/checksummed/rollback import
pipeline, a field-hardened WebRTC + encrypted-rendezvous P2P stack, real Playwright acceptance
harnesses, and unusually good implementer docs. **This is the asset worth sharing.**

**But measured against the vision, it is today a *small-state game console*, not yet a sovereign
*app* platform.** Four things stand between here and there:

1. **It can only hold small game state.** localStorage-only: sync, string-only, ~5 MB shared across
   the launcher *and every app*, silent loss on quota. A journal-with-images, photo, or document
   app is dead on arrival.
2. **It doesn't yet deliver the sovereignty promise concretely.** No per-app export, no encryption
   at rest, no automatic local backup, no `navigator.storage.persist()`, and — the big one — P2P
   moves *messages*, not *state*: your data can't follow you across your own devices without manual
   file export/import.
3. **It assumes a single owner named Paul.** No LICENSE (forking is legally impossible today),
   hardcoded catalog duplicated across three files, personal branding fused into the launcher, no
   SDK versioning, no CI gate, no starter template.
4. **Every game re-hand-rolls the same subsystems** (audio, RNG, dialogs, escaping, tweens,
   particles, SW boilerplate) because the SDK doesn't provide them — so implementations drift and
   bugs recur (e.g. the still-live sowduku XSS; a UTC-vs-local "daily" disagreement between games).

The rest of this doc is the roadmap to close those four, organized as workstreams with a phased
sequence and the keystone items called out.

---

## The keystones (build these first — each unblocks many others)

| Keystone | Unblocks | Where the gap is |
|----------|----------|------------------|
| **App manifest + `catalog.json`** (data-driven catalog) | permissions model, per-app export, deep links, de-branding, forkable fleets, decentralized catalog | catalog is hardcoded `<a>` tags in `index.html:383-427`, mirrored by hand in `profile.html` + `sw.js` |
| **`Arcade.store` / `Arcade.files`** (async per-app IndexedDB/OPFS KV + blob store) | non-game apps, encrypted/large export, backup, state sync | SDK offers only localStorage; IndexedDB exists in-repo but only for RTC certs |
| **`Arcade.sync`** (multi-device state replication over the existing P2P pipe) | the core sovereignty promise; backup-to-peer | no CRDT/merge/replication anywhere; `peer.*` carries ephemeral messages only |
| **LICENSE + framework/content split** | anyone else adopting it at all | no LICENSE file; framework fused into the personal site |

---

## Workstream A — Become a real app platform (beyond games)

**A1. Async + large-object storage.** `Arcade.store.open(name)` → promise KV
(`get/set/del/keys/each`) backed by a per-app IndexedDB DB (`arcade.v1.<appId>`); `Arcade.files`
(`put/get/list/delete`) backed by OPFS or IDB blobs. Both register async exporters the launcher
awaits during bundling (feeds A-export + C-backup + sync). *This is the gate for every non-game app.*

**A2. Capability / permission model.** Today every app is mounted
`sandbox="allow-scripts allow-same-origin allow-downloads"` with no `allow=` policy — so apps
**cannot** use camera/mic/geo/notifications even with user consent, **and** the sandbox is
decorative (any app can read every other app's storage and reach `window.parent`). Add a
manifest-declared `permissions:[]` that the launcher translates into the iframe `allow=` attribute
*after* a user grant, persisted under `arcade.v1._meta.grants`. Sketch:
`Arcade.permissions.request('camera') → Promise<'granted'|'denied'>`. **See the strategic decision
below — this interacts with the same-origin trust boundary.**

**A3. Launcher-mediated UI bridge** (today `ui` is toast-only): `Arcade.ui.confirm(msg)` /
`Arcade.ui.prompt` (the sandbox no-ops native `window.confirm` — this is why three games hand-rolled
"arm-to-confirm"), `Arcade.ui.setTitle`, `Arcade.ui.onBeforeQuit(fn→Promise<bool>)` so a
mid-edit journal can veto the quit button, an open-file broker (apps get `allow-downloads` but no
*open* path), and a share-sheet.

**A4. Fix silent data loss + durability** (cheap, sovereignty-critical): `Arcade.state.set()` must
return the write-success boolean it currently discards (`arcade-sdk.js:694-703`); add
`Arcade.storage.estimate()` and `Arcade.onStorageError(fn)`; **call `navigator.storage.persist()`**
on launcher boot (one line — today the browser may evict the entire origin under pressure).

**A5. Routing / deep links.** Parse `#app=<id>` on boot → `showGame()`; update the fragment on
launch/quit so apps are bookmarkable and installed PWAs re-open where the user left off.

**A6. Neutral vocabulary.** Present `appId`/`Platform.*` names with `gameId`/`Arcade.*` as aliases;
add an app-integration doc twin to `GAME_INTEGRATION.md`. Cheap now, expensive after more
integrations calcify the game vocabulary.

## Workstream B — Deliver sovereignty concretely

**B1. Per-app + encrypted export.** The launcher's import/export is excellent but *all-or-nothing
and plaintext*. Section the bundle `apps:{<appId>:{…}}`; add "export this app only"; add optional
`crypto.subtle` AES-GCM passphrase wrapping. Reconsider the checksum *hard-reject* of hand-edited
saves (`index.html:1474`) — "you may not edit your own data" conflicts with the sovereignty value;
warn-and-override instead.

**B2. Automatic local backup.** Today a backup fires only as a side effect of *importing*. Add a
rolling snapshot of the export bundle into IndexedDB on boot when >24 h stale, plus an optional
File System Access "backup folder" grant on Chromium for true on-disk periodic export.

**B3. Multi-device state SYNC (the crown-jewel feature).** Reuse the existing exactly-once P2P
channel to replicate `Arcade.state`. Per-key last-writer-wins with hybrid logical clocks (deviceId
as tiebreaker) covers ~90% of app saves with **zero new dependencies** — matching the stack's
zero-dep ethos; a real CRDT is only needed for concurrent structural edits. Persist a per-pair
replication cursor in IndexedDB so sync survives restarts (unlike the RAM-only outbox). Expose
`Arcade.state.set(key, v, {sync:true})` + `Arcade.sync.onConflict`. The `{exportable:false}` flag is
a natural "don't sync this" companion.

**B4. Backup-to-trusted-peer.** All parts exist unconnected: checksummed bundles, `sendBlob`,
`knownPeers` trust flags. Add `knownPeers[deviceId].backupTarget` (consent-prompted both sides),
a launcher-to-launcher `kind:'backup'` envelope that bypasses game routing, N generations kept in
IndexedDB keyed by sender. "My phone backs up to my laptop whenever they're paired" — no cloud.

**B5. User identity above device identity + recovery.** Today identity = per-device deviceId +
~monthly-rotating DTLS fingerprint + pairwise secrets; **device loss = total loss**, and every
device pair needs its own manual ceremony. Add a user-level Ed25519 signing key (WebCrypto) that
cross-signs each device's fingerprint; recovery = export the user key as a mnemonic/QR (fits the
project's printed-pairing-card aesthetic); add an authenticated `revoke(deviceId)` frame. Bonus:
a cert rotation re-signed by the same user key needs no scary "fingerprint changed" toast.

**B6. Self-hostable broker + TURN.** The carrier interface is already cleanly swappable in code, but
broker/STUN URLs are hardcoded and there is **no TURN at all** (so symmetric-NAT pairs can't connect
off-LAN). Read `arcade.v1._meta.rdvBrokers` (+ optional TURN/STUN) with current values as default;
add an "advanced" field in the Multiplayer dialog and a "self-host mosquitto-over-WSS" docs page.
Cheap, high sovereignty value; topics are broker-agnostic so mixed fleets interoperate.

## Workstream C — Make it adoptable by others

**C1. Add a LICENSE** (MIT/Apache-2.0) and propagate one to the vendored `p2p/` (from
`QRCodeP2P`). *Nothing else matters until this exists — today forking is legally impossible.* Hours.

**C2. Data-drive the catalog** — this is keystone #1. `catalog.json`
(`{id,name,subtitle,url,icon,permissions,version}`) rendered into the grid; kills the
`index.html`/`profile.html`/`sw.js` triplication (the code already counts games generically via
`data-game-id`). Foundation for forks, remote catalogs, permission sheets, deep links.

**C3. CI test gate** (also `fleet-hardening` D1, "highest leverage"): a workflow that stages the
launcher + a fixture app via `dev.sh`, runs `acceptance.mjs` (per-game + `--pool`) and
`p2p-acceptance.mjs` headless, and blocks the Pages deploy. The harnesses already exist — pure
wiring. Protects every other item here from silent regression.

**C4. De-brand / parameterize the launcher** — one config object (fleet name, origin, theme,
manifest fields); replace the 7 hardcoded `paulgibeault.github.io` URLs with relative/derived ones;
move the personal `profile.html` out of the framework's concern.

**C5. Starter template + generator** — `tools/templates/starter-app/` (SDK init, state,
suspend/resume, settings hooks, scoped manifest + the existing `game-sw.js`) that passes
`acceptance.mjs` out of the box, plus `./dev.sh new <appId>`. Today zero-to-integrated is "read
600 lines and copy Paul's games."

**C6. Version the SDK surface.** Games load `/arcade-sdk.js` live off the launcher with no pinning
— one breaking deploy bricks the whole fleet simultaneously (fine for 7 owned games, fatal for an
ecosystem). Publish at `/sdk/v2/arcade-sdk.js` with the evergreen alias, adopt semver + CHANGELOG,
implement the handshake version *negotiation* already deferred in `ARCADE_PLATFORM.md:350`.

**C7. Split framework from content** (long pole; needs B13 refactor first). An `arcade-framework`
repo (SDK, p2p, launcher shell, tools, docs) that `paulgibeault.github.io` becomes the first
*consumer* of. This is what turns "fork and hack" into "run your own fleet."

**C8. PWA polish** — maskable icons, manifest `shortcuts`/screenshots/`share_target`,
`beforeinstallprompt` UX, fix the `manifest.json` scope-vs-per-game-manifest collision, surface
"install this app" per card, and decide the installed-app-loses-launcher-services story.

## Workstream D — Standardize by lifting game patterns into the SDK

The pattern-mining pass found ~3,000 LOC of duplicated subsystems across the seven games, several
already coupled to SDK settings (proving the seam) and several actively buggy. Ranked by
frequency × size × bug-risk:

| Rank | Promote to SDK | Games affected | Why now |
|------|----------------|----------------|---------|
| 1 | **`Arcade.rng` + `Arcade.daily` + `Arcade.share`** | 5 | 3 divergent mulberry32 copies; **live UTC-vs-local "daily" bug** between games; sharing/replay is core to the arcade identity |
| 2 | **`Arcade.html.escape`** (+ tagged template) | 6 (only p2p-chat has one) | cheapest, highest-leverage safety fix — user-authored packs/codes now cross devices; **the still-open sowduku XSS is exactly this** |
| 3 | **`Arcade.ui.confirm` / dialog+sheet** | 3+ | the *sandbox itself* broke `window.confirm`, so games reinvented arm-to-confirm; destructive-action safety |
| 4 | **`Arcade.audio.cue/play`** (ctx unlock, resume, volume, suspend) | 2 (+ all future) | highest bug-density plumbing; both copies already honor `settings.audioVolume()` |
| 5 | **`Arcade.tween` + `Arcade.fx.burst`** | 4–6 | two near-twin tween modules + four particle systems, each re-gating reducedMotion and running a private rAF that fights the SDK loop (~450 LOC) |
| 6 | **`Arcade.canvas.autosize`** (DPR cap + resize debounce) | 4 | the divergences are the classic blur/perf regressions |
| 7 | **SDK-shipped SW template + build-time manifest injection** | 3 | hand-maintained asset lists = documented silent-offline-failure hazard |
| 8 | **`Arcade.peer.sendBlob` chunking** | 1 (flagship) | already tracked; transport concern (progress, interrupted-queue interaction) every future multiplayer app needs |

**Runners-up:** `Arcade.ui.guide` (lift si-syn's `guide.js` almost verbatim — already
suspend-aware), `Arcade.firstRun(key)`, `Arcade.fmt.{duration,clock,bytes}`,
`Arcade.telemetry.log`, `Arcade.undo.create`, `Arcade.ui.safeArea()` (moon-lit hardcodes the
launcher's 56 px topbar), and two adoption cleanups (sowduku's redundant toast; **nobody uses the
SDK's managed loop** — worth checking it offers the dirty-flag/idle mode moon-lit/cozy/hecknsic all
rebuilt).

Migrate opportunistically, cleanest games first (cozy-solitaire, pi-game) as references — not a
forced rewrite. Each promotion is a small SDK addition + a per-game adoption PR.

---

## The one strategic decision to make explicitly

**Is this a first-party fleet (Paul writes every app) or a true multi-tenant platform (third parties
ship apps)?** The whole trust model hinges on it, and today it's *implicit*:

- Same-origin + `allow-same-origin` means **namespacing is a convention, not a boundary** — any
  mounted app can read/write every other app's storage, reach the launcher, and even **use the P2P
  pairing keys and device identity directly** (the key stores are same-origin IndexedDB). A
  malicious app could impersonate the device on the rendezvous dead-drop or launder fingerprint pins.
- `fleet-hardening-plan.md` correctly **defers** "games on a separate origin" as its own initiative
  — which is right *if this stays first-party*.

**Recommendation:** for now, **declare first-party-only explicitly** in the docs and trust model
(honest, and everything works). Treat true multi-tenant (cross-origin app isolation, storage brokered
over postMessage, per-app permission sandbox) as a **named future epic** gated behind C2/C6/C7 — it
is the real "break dependence on app stores" endgame, but it invalidates the same-origin storage
model and shouldn't be back-doored in. Make it a deliberate v2, not an accident.

---

## Security items to fold into `fleet-hardening-plan.md` (found beyond the #21 list)

- **Fingerprint pin overwritten before re-trust** (`arcade-p2p.js:226-228`): an imposter's
  fingerprint overwrites the stored pin even when the user *declines*; suspicion is RAM-only, so a
  reload silently trusts the imposter. #21's A4 gates the *mint*, not the *pin rotation*. **Real
  auth bug — add to #21.**
- **Same-origin apps can use the P2P key stores** (see strategic decision above) — elevate from
  "deferred" at least to "documented trust boundary + move key stores out of app reach."
- **No carrier-level inbound size cap:** public MQTT brokers accept arbitrarily large PUBLISH; the
  parser buffers them and `MultiCarrier` retains up to 64 payloads/topic. #21's #8 caps decrypt
  *attempts*, not bytes buffered. Add a ~4–16 KB max-blob guard at the parser.
- **Blob transfer can silently wedge** on queue overflow with no integrity check or abort frame
  (extends #21 #5's missing-TTL) — add a per-blob hash + `blob-abort`.
- **Handshake 300 ms race** (`arcade-sdk.js:95`): a framed app on a slow boot can resolve `ready`
  as standalone then flip to framed — `context.framed` changes after `ready` with no doc warning.
- **Eviction suspend-hint is a no-op** (`index.html:787-789`): async `postMessage` then synchronous
  `about:blank` — the flush hint can never be processed. Will bite any app that defers persistence
  to suspend-time.

---

## Suggested sequence

1. **Now, cheap, high-leverage:** C1 LICENSE · C3 CI gate · A4 storage-error/persist() · D2
   `html.escape` (+ fixes the live sowduku XSS) · the fingerprint-pin + inbound-size security items.
2. **Foundation:** C2 `catalog.json` · A1 `Arcade.store`/`files` · A3 UI bridge · D1 rng/daily/share.
3. **Sovereignty payload:** B1 per-app+encrypted export · B2 auto-backup · **B3 state sync** ·
   B4 backup-to-peer.
4. **Adoption:** C4 de-brand · C5 starter template · C6 SDK versioning · B5 user identity ·
   B6 self-host broker/TURN.
5. **Long poles / v2:** C7 framework/content split (after B13) · A2 full capability model ·
   C8 PWA · the multi-tenant cross-origin epic.

Continue lifting Workstream-D patterns opportunistically throughout.
