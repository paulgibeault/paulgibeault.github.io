# Durability unification behind the sync journal — design

**Status:** Proposed (design-only PR; implementation staged as PRs 6–8 below)
**Scope:** `arcade-sync.js` / `arcade-sync-core.js` (journal), `arcade-save.js`
(bundles), `arcade-backup.js` (peer backup), `arcade-local-backup.js` (local
backup), `arcade-storage-bridge.js` (the write seam).
**Origin:** deferred item 3 of PR #71's architecture review; roadmap in
`~/.claude`-side planning, sequenced after the transport/state-machine track
(PRs #72–#76).

## 1. What exists today — four engines, two data models

| engine | covers | unit of work | change detection | trust boundary |
|---|---|---|---|---|
| **Sync** (`arcade-sync.js`) | `_sync`-opted localStorage keys only | per-key HLC record `{h, x, del, t}` | HLC + content hash | paired peer, mutual opt-in, live wire |
| **Save file** (`arcade-save.js`) | ALL safe arcade localStorage keys + `Arcade.store` IDB rows + `Arcade.files` blobs | whole bundle | none (human-triggered) | the human |
| **Peer backup** (`arcade-backup.js`) | whole bundle (via `exportBundleString`) | whole bundle | whole-bundle checksum vs per-peer `acked` (`arcade-backup.js:165, 263`) | paired peer, mutual opt-in, offer/accept/chunk/ack |
| **Local backup** (`arcade-local-backup.js`) | whole bundle | whole bundle | build-then-compare checksum (`planGenerationStore`) | same device |

The **journal** (sync's `records` map + `arcade-sync` IDB) is the only
component with per-key provenance — HLC stamps, content hashes, tombstones —
but it sees only the `_sync`-opted subset. The three bundle consumers ship
and store full snapshots with no provenance at all, which costs:

- **Reconnect churn moves/rebuilds whole bundles.** Peer backup dedupes on
  the whole-bundle checksum: one changed key re-ships everything (bounded by
  `BACKUP_MAX_CHARS` = 32 MB). Local backup *builds* the full bundle
  (localStorage scan + every store DB dump + every OPFS blob read + base64)
  every 24 h just to discover nothing changed.
- **Restores can resurrect deletions on third devices.** A bundle carries no
  tombstones. Restoring onto a fresh device then syncing with a third paired
  device pulls back keys the user deleted after the bundle was taken —
  `planFromDigest` sees them as brand-new.
- **No delta path exists or can exist** without per-key provenance on both
  ends of a transfer.

Everything a game writes flows through one seam —
`handleBridgedStateWrite` → `host.onStateWritten` → `noteLocalWrite`
(`arcade-storage-bridge.js:114`, `arcade-sync.js:609`) for localStorage, and
`handleStoreOp` / the file ops for IDB/OPFS — so journaling more than the
`_sync` subset is a policy change, not a plumbing project.

## 2. Decisions (summary)

| tension | decision |
|---|---|
| **T1** journal coverage vs bundle coverage | **Two-tier hybrid.** Tier 1: journal every bridged **localStorage** write (a new `local` record class beside `sync`). Tier 2: stores/files are **not** per-write journaled; bundles gain a per-section content-hash **manifest** instead. |
| **T2** bundles carry no HLC | **Additive, self-checksummed `journal` + `manifest` sections at `schemaVersion: 2`** — no schema bump, no flag day (same trick as `welcome.caps` and the SDP-codec extras trailer: old readers ignore unknown top-level fields by construction). |
| **T3** restore semantics | **Restore-wins stays** for valued keys (fresh local re-stamp, clock first seeded past the bundle's max HLC). Bundle **tombstones are adopted at their original HLC**, never re-stamped. |
| **T4** delta protocol vs tombstone cap | Deltas keyed off the **per-peer acked base checksum** (not sync cursors). A GC **eviction watermark** forces full-transfer fallback whenever the base predates an evicted tombstone. Receiver **materializes the full bundle and verifies the offered checksum** — the existing bait-and-switch gate carries over intact. |

## 3. T1 — coverage: the two-tier journal

### Tier 1: all bridged localStorage writes

`noteLocalWrite` currently early-returns for keys without a `_sync` opt-in
(`arcade-sync.js:615-621`). It will instead stamp **every**
`syncEligibleKey`-passing write into the journal, in one of two record
classes:

- `sync` — today's records, exactly as they are. Replicated live.
- `local` — same shape `{h, x, del, t}`, **never replicated**. Exists so
  bundles/deltas know what changed and when, and so deletions of non-synced
  keys leave tombstones a bundle can carry.

**The classes live in separate maps and separate IDB row prefixes**
(`k|` stays sync; `j|` is local), and every wire-facing path keeps reading
only the sync map. This is a security invariant, not a style choice:
`handleInboundReq` answers any key present in its map
(`arcade-sync.js:461-464`), so a shared map would let a malicious-but-paired
peer **exfiltrate non-synced keys by requesting them**. With separate maps,
the wire paths (`sendDigestTo`, `buildDiffEntries`, `handleInboundReq`,
`reconcileDigest`) cannot leak a `local` record even by bug, because they
never see one. `tools/sync-unit.mjs` pins this: a `req` for a journaled
non-synced key returns nothing; digests never include `local` records.

Cost discipline (the documented `noteLocalWrite` posture is "cheap for the
common case", `arcade-sync.js:605-608`):

- The cheap gate becomes: synced key → today's path; else → enqueue for the
  journal. Hashing (`sha256Hex`, values ≤ 2 MB bridge cap) and the IDB put
  are **coalesced on a microtask/idle flush** — a game hammering
  `state.set` in a loop journals the final value once per key per flush.
- The `arcade-sync` DB stays lazily opened, but any device where a game
  writes state will now open it. That is the same activation profile as the
  local-backup engine (runs every boot by design) — acceptable, and the
  no-P2P visitor who never launches a game still never opens it.
- A `_noExport`-listed key (`arcade-save.js:326-341`) is skipped entirely:
  if it never enters a bundle, its provenance buys nothing.

### Tier 2: stores and files — manifest, not journal

Per-write journaling of `Arcade.store` rows and `Arcade.files` blobs is
rejected: it would put a hash on the write path of multi-MB blobs, and the
row count is app-controlled and unbounded (a journal entry per store row
could dwarf the data). Instead, `buildBundle` records a **manifest**: one
content hash per store DB and per file (already-computed material — the
bundle serializes every row/blob anyway, so hashing at build time is
marginal). Change detection and deltas for these sections operate at
whole-DB / whole-file granularity, which matches how they actually change
(blobs are replaced, not edited).

## 4. T2 — bundle format: additive sections, schemaVersion stays 2

`validateSaveBundle` reads only the fields it knows and passes unknown
top-level fields through untouched (`arcade-save.js:55-118`); the checksum
covers exactly `data`/`stores`/`files`. Meanwhile a `schemaVersion: 3`
bundle would be **hard-rejected as `not-a-save` by every existing device**
(`parsed.schemaVersion <= SAVE_SCHEMA` gate), and the peer-backup protocol
has no schema negotiation — a v3 sender would strand mixed-version pairs in
an offer/validate-fail/re-offer loop. So:

```jsonc
{
  "format": "pauls-arcade-save", "schemaVersion": 2,   // unchanged
  "checksum": "…",                                      // unchanged: data+stores+files
  "data": { … }, "stores": { … }, "files": { … },       // unchanged
  "journal": {                                          // NEW, optional
    "v": 1,
    "clock": "<max packed HLC at build time>",
    "records": { "<fullKey>": { "h": "…", "x": "…", "del": 0|1, "t": 0 } },
    "checksum": "<sha256 over canonical JSON of clock+records>"
  },
  "manifest": {                                         // NEW, optional
    "v": 1,
    "stores": { "<dbName>": "<hash>" },
    "files": { "<dir>/<name>": "<hash>" },
    "checksum": "<sha256 over canonical JSON of stores+files>"
  }
}
```

- `journal.records` is **bounded**: only keys present in `data` plus
  tombstones (≤ `SYNC_TOMBSTONE_CAP_PER_APP` = 512/app by construction).
  Both record classes are included — class is a device-local property, not
  a bundle property.
- The new sections are **self-checksummed** rather than folded into the
  outer checksum, so v2 receivers verify exactly what they always verified.
  The outer checksum was never an authenticity mechanism (DTLS in transit,
  AES-GCM at rest, the human for files); a tampered journal section can at
  worst skew provenance, and §5 makes restore robust to that.
- Old device imports new bundle: identical behavior to today (sections
  ignored). New device imports old bundle: no journal → today's restore
  path. Nothing to negotiate.

## 5. T3 — restore semantics: restore-wins stays, and gets teeth

`noteImportCommitted` deliberately re-stamps every imported synced key with
a fresh local HLC (`arcade-sync.js:630-652`): a human restoring a backup is
a deliberate "now" edit that must beat older remote edits **and** override
tombstones (resurrection-by-restore is a feature — it is the only undelete
the system has). That stays, with two additions when the bundle carries a
journal:

1. **Clock seeding.** Before re-stamping, feed `journal.clock` through
   `hlcRecv`. Without this, a restored device with a skewed-behind wall
   clock could mint "fresh" stamps that lose LWW to edits the *original*
   device made after the bundle was taken — silently violating
   restore-wins. (No journal ⇒ no seed ⇒ exactly today's behavior.)
2. **Tombstone adoption.** `journal.records` entries with `del: 1` whose
   key is absent from `data` are adopted **at their original HLC** into the
   matching record class. Never re-stamped: a re-stamped tombstone would
   beat edits made *after* the bundle was taken and delete live remote
   data. At original HLC it loses to any newer write — plain LWW. This is
   what closes the fresh-device resurrection hole in §1: the restored
   device now *knows* about pre-bundle deletions and refuses to pull them
   back from a third peer.

Restores of bundles with a journal remain interactive-import compatible:
gates 4–10 (`importParsedBundle`) run unchanged; the journal work happens
inside the existing `host.onImportCommitted` hook, extended to receive the
bundle's journal section.

## 6. T4 — delta peer-backup protocol

Wire stays `{arcade:1, kind:'backup', v:1, …}` with **additive ops** (the
envelope validator rejects unknown ops, so a new-op frame to an old device
is dropped — the sender detects the missing response and falls back to a
full transfer; no version negotiation needed):

```
offer   {op:'offer', id, checksum, chars, parts, exportedAt,
         deltaFrom?: <base checksum>}                      // NEW field, ignored by old receivers
accept  {op:'accept', id}                                  // unchanged ⇒ full transfer
        {op:'accept-delta', id, base: <checksum>}          // NEW ⇒ sender ships a delta
chunk / ack                                                 // unchanged framing; delta rides the same chunks
```

- **Base identity = the per-peer acked checksum** the sender already
  persists (`a|` rows, `arcade-backup.js:449-451`) and the receiver's
  stored generations already carry. Sync's per-device cursors are *not*
  reused: they answer "what has this peer observed of my live records",
  which is neither necessary nor sufficient for "which stored bundle does
  this peer hold". The engines stay decoupled.
- **Delta content** (a JSON document riding the existing chunk frames):
  changed/added `data` keys with values, removed keys, tombstone additions
  (all derived by diffing current journal records against the base
  bundle's `journal.records`), plus whole store-DBs / files whose
  `manifest` hash changed. A base bundle without journal/manifest sections
  ⇒ no delta possible ⇒ full transfer.
- **Receiver materializes, then verifies.** The receiver loads its stored
  base generation (already sealed-at-rest per sender), applies the delta,
  re-serializes, and **must** arrive at a bundle whose own checksum equals
  the offer's `checksum` — then runs the full `validateSaveBundle` gate
  before storing, exactly like a full transfer (`arcade-backup.js:402-418`).
  Failure ⇒ drop delta, request full (`accept`). The offer's checksum
  remains the single source of truth; a delta can never smuggle state a
  full transfer couldn't.
- **Tombstone-cap interaction (the correctness rule).** Cap-only GC evicts
  the oldest tombstones past 512/app (`gcTombstones`,
  `arcade-sync.js:202-221`). A delta computed against a base older than an
  evicted tombstone **cannot express that deletion** — the diff sees "key
  absent in both" and silently resurrects it in the materialized bundle.
  Rule: GC maintains a persisted **eviction watermark** = max `t` (and max
  `h`) ever evicted, per app. An offer includes `deltaFrom` only if the
  base bundle's `journal.clock` is ≥ the watermark; otherwise it offers a
  full transfer. Conservative and cheap: the watermark only moves when an
  app exceeds 512 live tombstones, which is already the documented
  residual-risk regime.
- Generations remain full bundles at rest (a delta is a *transfer*
  optimization, never a storage format) — restore, encrypt-at-rest, and
  the generation index are untouched.

## 7. Security invariants (must survive all three PRs)

1. **`local`-class records never cross the wire.** Separate maps/prefixes;
   wire paths read the sync map only; pinned by unit test (§3).
2. **A delta can produce only what a full transfer could.** Materialize →
   outer checksum match → full `validateSaveBundle` → store. No new parse
   surface before validation; `IMPORT_PROTECTED_KEYS` untouched.
3. **Restore never weakens.** All restores keep riding `importParsedBundle`
   gates 4–10 — the journal work is post-commit bookkeeping.
4. **Bundle journal is advisory, not authoritative.** A tampered/absent
   journal section degrades to today's behavior (no seed, no tombstones, no
   delta); it can never grant write authority the bundle body lacks.
5. **Lazy posture holds for the no-game visitor.** No IDB open, no scan,
   until a bridged write or a durability feature actually runs.

## 8. Staged implementation

**PR 6 — journal foundation (M-L).** Two-tier journal (§3): `local` record
class, coalesced flush, separate maps/prefixes + the exfiltration pin;
bundle `journal` + `manifest` sections (§4) emitted by `buildBundle` and
carried through `exportBundleString`; GC eviction watermark persisted.
*No behavior change to any backup/restore flow* — groundwork only.
Gates: `sync-unit` (classes, req-refusal, watermark), `save-validation-unit`
(additive sections, self-checksums, old-bundle acceptance), sync + backup
acceptance unchanged-green.

**PR 7 — consumers read the journal (M).** Restore-side T3 mechanics (clock
seeding, tombstone adoption) in the shared import hook; local backup skips
the 24 h full-bundle build when journal max-HLC + manifest match the newest
generation's (build-avoidance, not just store-avoidance — today it
serializes everything, then compares, `arcade-local-backup.js:117-143`).
Gates: `local-backup-unit`, backup acceptance + a new restore-resurrection
scenario (delete on A → backup B restores on fresh C → C must not pull the
deleted key from A).

**PR 8 — delta peer-backup (L).** §6 wire: `deltaFrom`/`accept-delta`,
delta build/apply, materialize-and-verify, watermark fallback, old↔new
fallback-to-full. Gates: `backup-unit` (delta apply, checksum-mismatch
drop, watermark refusal), backup acceptance (delta round trip; forced
fallback when the receiver plays old).

## 9. Non-goals

- **One merged engine.** Sync, peer backup, and local backup keep distinct
  trust postures and consent flows; unification is of *provenance*, not of
  engines.
- **Per-write journaling of stores/files** (§3 Tier 2 rationale).
- **Any change to the live sync wire protocol** (`digest`/`req`/`diff` are
  untouched at every stage).
- **Cloud anything.**
- **Bundle schemaVersion 3.** Nothing here needs it; the additive pattern
  is the compatibility strategy of record (caps, codec trailer, now
  bundles).
