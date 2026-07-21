# Arcade SDK changelog

The SDK publishes at two launcher-origin URLs:

- **`/sdk/v<major>/arcade-sdk.js`** — major-pinned. This URL keeps serving its
  major line even after a breaking major ships, so a pinned game can never be
  bricked by a launcher deploy. **Games should pin this URL.**
- **`/arcade-sdk.js`** — evergreen alias, always the newest major. Kept for
  the existing fleet and for casual standalone use.

`/arcade-sdk.js` (repo root) is the canonical source file; `sdk/v<major>/` is
a byte-identical checked-in copy while that major is current.
`tools/sdk-version-unit.mjs` gates the whole scheme in CI: copy in sync,
`SDK_SEMVER` major == `VERSION` == newest changelog entry's major, no
directory for an unshipped major.

**Release procedure** (any behavior-visible SDK change):

1. Edit `/arcade-sdk.js`; bump `SDK_SEMVER` (patch = fix, minor = additive
   feature, major = breaking — see below).
2. `cp arcade-sdk.js sdk/v3/arcade-sdk.js` (current major's directory).
3. Add an entry at the top of this file.
4. Bump `CACHE_NAME` in `sw.js` (both SDK paths are precached).

**Breaking change (new major N)**: the old directory `sdk/v<N-1>/` is frozen
as-is (its last release keeps serving forever), `VERSION`/`SDK_SEMVER` bump to
`N.0.0`, a new `sdk/v<N>/` directory is created, and the evergreen alias moves
with it. Compatibility is still negotiated at runtime by `welcome.caps` —
semver is for humans and URLs, never checked on the wire.

---

## 3.3.0 — 2026-07-20

Score entry attribution for shared leaderboards (#leaderboards). `Arcade.scores.add`
now stamps two internal fields on each entry so peer boards can be union-merged
across linked devices without dropping distinct plays or double-counting:

- `dev` — the device id that set the score (read from the paired-device
  identity; omitted on a standalone page that never paired). Never minted here.
- `eid` — a random per-entry id (8 base64url chars), so two entries in the same
  millisecond stay distinct.

Games don't set these and don't need to change: `scores.add(category, { score, … })`
is unchanged, and `scores.list/best` ignore the extra fields. The launcher's new
shared-leaderboard engine merges boards from peers (with the per-peer sync opt-in
on both sides) into the real `scores.*` keys — so a game just keeps reading its
own leaderboard and sees everyone's entries. Scores are carved out of `Arcade.sync`
(which is last-writer-wins and would clobber a board wholesale).

## 3.2.0 — 2026-07-20

Personal records API (`Arcade.records`, issue #9). A self-describing per-category
personal best, distinct from `Arcade.scores` (a sorted top-N leaderboard): one
record per category, each carrying its own `direction` so "best" is meaningful
without out-of-band knowledge. This replaces the brittle
`scores.add(cat, { score: -timeMs })`-then-re-negate workaround for
lower-is-better metrics. Purely local storage convention (no new welcome cap):

- `Arcade.records.set(category, { value, direction: 'higher'|'lower', label?, format?, meta? })`
  — `format` ∈ `'duration-ms' | 'integer' | 'percentage'` (unknown values stored
  as-is for forward-compat); oversized (>4 KB) or non-object `meta` is dropped
  with a warning, never thrown.
- `Arcade.records.best(category, rec)` — writes only if `rec.value` beats the
  stored record under the stored direction; ties do not write (the first-set
  timestamp is preserved). Returns `{ improved, record }`.
- `Arcade.records.get(category)` → record | null (a fresh object each call).
- `Arcade.records.list()` → `{ [category]: record }`, malformed entries skipped.
- `Arcade.records.clear(category)`.

Stored one key per category at `arcade.v1.<gameId>.records.<category>`, so records
ride save-export and (when the game opts into `Arcade.sync`) replication with no
special handling. The launcher's Records sheet reads these generically.

## 3.1.0 — 2026-07-18

Multi-party star selection (`plans/multi-party-2026-07.md` Phase 2). A device
can now hold several concurrent parties (independent connection stars); a
running game is attached to exactly one, and its whole `Arcade.peer.*`
surface reflects only that party. Additive API, gated by the new
`peer.party` welcome cap:

- `Arcade.peer.party()` — the attached party (`{id, role, leaderName,
  status, peers}`) or null.
- `Arcade.peer.parties()` — every party this game could attach to.
- `Arcade.peer.attach(partyId)` — request re-attachment; resolves to the
  resulting party or null if refused.

With a single party the launcher auto-attaches and existing games keep
working unchanged — these calls are only for games that want to choose.
Roster entries now also carry a session-scoped `partyId` field (additive).

## 3.0.0 — 2026-07-17

First versioned release. Establishes the `/sdk/v3/` pinned path, the evergreen
alias contract, and this changelog. Adds `Arcade.context.sdkVersion` (the
semver string). No behavior changes otherwise: v3 is the SDK generation that
introduced bridged storage mode (opaque-origin frames), already fleet-wide.
