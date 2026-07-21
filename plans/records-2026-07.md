# Records arc — Arcade.records + launcher Records sheet (#9, #11, #12)

2026-07-20. Three sequential PRs (R1 → R2 → R3), each independently shippable,
same cadence as the multi-party P1→P4 track.

## Context

Porting cozy-solitaire exposed a category mismatch: `Arcade.scores` is
leaderboard-shaped (multi-entrant, top-100, sorted) but "best Klondike draw-1
time" is a single personal record per category with metric-dependent "best"
semantics. Games today shoehorn (`scores.add(cat, { score: -timeMs })` and
re-negate in UI — brittle) or park bests in `Arcade.stats` blobs invisible to
any cross-game view. #9 adds a first-class self-describing `Arcade.records`
namespace; #12 adds the launcher Records sheet that renders every game's
leaderboards + records with zero per-game launcher code; #11 (session timer,
`stats.getOrInit`) is **already implemented** in SDK 3.1.0 — R1 verifies and
closes it.

Decisions already settled in the #9 thread: separate namespace (don't overload
`scores`); storage `arcade.v1.<gameId>.records.<category>`; self-describing
schema so the launcher renders generically; API-only for games (no game-facing
sheet); locale formatting nice-to-have. #12 decisions: no stats section in v1
(records/scores only); empty tabs shown de-emphasized, not hidden; reset is
per-game whole-wipe with confirm; cross-device/shared leaderboards out of scope
(save export + per-game `Arcade.sync` opt-in already cover replication —
`records.*` keys pass `syncEligibleKey` in `arcade-storage-core.js:107` with no
special handling).

## PR R1 — SDK `Arcade.records` (closes #9, closes #11)

Pure storage convention like scores/stats — **no new capability**, no protocol
change. Minor semver bump.

Files: `arcade-sdk.js` (new `recordsApi` after `statsApi` ends at :2363; expose
`records:` in the api object next to `stats:` ~:2941; header docs after :132;
`SDK_SEMVER` '3.1.0'→'3.2.0' at :162), `sdk/v3/arcade-sdk.js` (byte-identical
copy), `sdk/CHANGELOG.md` (top entry), `sw.js` (v47→v48), `GAME_INTEGRATION.md`
§4 (records-vs-scores-vs-stats guidance), tests below.

### API contract

`recordsKey(category)` = `gameKey('records.' + category)`. Constants near
`SCORES_CAP`: `RECORD_LABEL_MAX = 64`, `RECORD_FORMAT_MAX = 32`,
`RECORD_META_MAX = 4096` (JSON bytes).

- `records.set(category, rec)` → stored record. Throws on: bad category
  (parity `scores.add`), non-finite `rec.value`, `rec.direction` not
  'higher'|'lower' (direction is load-bearing — never defaulted). Stored:
  `{ value, direction, ts (rec.ts if finite else Date.now()), label?≤64,
  format?≤32, meta? (plain object ≤4KB else dropped with console.warn — never
  thrown) }`. Unknown `format` strings stored as-is (forward-compat; launcher
  falls back to plain number). Known: 'duration-ms' | 'integer' | 'percentage'
  (0–100). Write via `writeJSON` + `fireKeyChange` so `state.onChange` fires.
- `records.get(category)` → record | null. Shared `validRecord(v)` guard
  (plain object, finite value, valid direction). Fresh object per call —
  `readJSON` re-parses raw strings in both storage modes, so no S-sdk-1
  shared-reference footgun.
- `records.list()` → `{ [category]: record }`. Same enumeration branch as
  `stateApi.keys()` (:1697-1705, lsCache vs localStorage); prefix-filter
  `gameKey('records.')`; only valid records; corrupt JSON reads as absent.
- `records.best(category, rec)` → `{ improved, record }`. `rec` is the full
  set() shape (a bare number can't establish direction on first write — this
  resolves the issue sketch's underspecification). No current → set(),
  improved:true. Else **stored direction is authoritative** (scores
  order-sidecar precedent; mismatch warns). 'higher' → `>`, 'lower' → `<`;
  **ties do NOT write** (preserves ts of first achievement). Not improved →
  no storage touch.
- `records.clear(category)` — category required; `removeKey` +
  `fireKeyChange(k, null)`. No clear-all (bulk reset is the launcher's job).

Non-changes to state in CHANGELOG/PR: sync-eligible iff game opts in (4KB meta
cap ≪ 64KB `SYNC_VALUE_MAX`); rides save export automatically (whole
`arcade.v1.<gameId>.` prefix); bridged writes use existing `state.write` path.

### #11 close-out (same PR)

Verify `Arcade.session.start` (:2541, `createSessionTimer` :2378 incl.
`persistKey`) and `Arcade.stats.getOrInit` (:2334) cover the asks; close #11
citing lines + 3.1.0 changelog. Optional one-line rider (implementer's call):
`stats.getOrInit` returns caller's `defaults` by reference when nothing stored
(:2338-2341) — S-sdk-1 wart; `deepMerge(defaults, {})` clones it.

### R1 tests

Behavior via Playwright `tools/sdk-helpers-acceptance.mjs` (`npm run
sdk-helpers`) — SDK is a classic IIFE, no Node harness. Cases: set/get
roundtrip + ts stamp; set throws (empty category / bad value / bad direction);
oversized meta dropped+warn; best first-write / better / worse / **tie (ts
unchanged)** / direction-mismatch warns; list() excludes planted corrupt JSON +
wrong-shape + other-game keys; clear; get returns fresh object; bridged-mode
roundtrip via launcher-mounted frame (`frameFor`) asserting launcher
localStorage holds the key. Ritual gated by existing `tools/sdk-version-unit.mjs`
(Gates A–D) + `tools/check-sw-bump.mjs`.

## PR R2 — Launcher Records sheet (closes #12)

### New `arcade-records-core.js` (pure, DOM-free; precedent arcade-sync-core)

All fns take injected `store` `{length, key(i), getItem(k)}` so units run on a
fake. **Every stored byte is hostile** (games are untrusted frames).

- `collectGameData(store, gameId)` → `{ scores:[{category, order, entries}],
  records:[{category, record}] }`. Per-key JSON.parse in try/catch → skip;
  scores: arrays only, entries filtered to finite `.score`, name→string≤32, ts
  finite|null, **re-sorted by `_scoreOrders` sidecar (don't trust stored
  sort)**, cut to `RENDER_TOP_N = 10`; sidecar must be plain object of
  'asc'|'desc', default 'desc'; records: same `validRecord` rules as SDK;
  `MAX_CATEGORIES_PER_KIND = 50`; prefix match dot-terminated
  (`'arcade.v1.'+gameId+'.'` — no pi-game/pi-game-2 collision).
- `countPopulated(gameData)` → tab badge count.
- `resetKeysFor(store, gameId)` → full keys where post-prefix segment starts
  `scores.`/`records.`/`stats.` or equals `_scoreOrders`. Pure — returns list.
  Never touches `state`, `.ls.`, `_sync`, `_noExport`, `_meta`, other games.
- `formatRecordValue(value, format)`: duration-ms → `m:ss.cc`/`h:mm:ss.cc`
  (negative/NaN → `—`); integer → round+toLocaleString; percentage → ≤1
  decimal + `%`; unknown → toLocaleString ≤2 decimals. `formatDate(ts)`,
  `prettifyCategory(slug)` (fallback when label absent), `relevantKey(gameId,
  key)` (reset + R3 hook predicate).

### New `arcade-records.js` (DOM controller)

`initRecords(host)`; host built in the index.html module block
(capability-injection like `storageHost` :1629): `{ getCatalog, dialog,
showToast, closeLauncherMenu, openGame, isGameMounted, notifyGameKeyRemoved,
onKeysRemoved, store }`. Returns `{ open, close, isOpen, noteStateWritten
(no-op stub until R3) }`. Open/close/Esc/backdrop copies
connectionsDialogController idiom (index.html:2294-2403). Rendering
createElement/textContent **only**.

Reset flow: confirm via `host.dialog` → removeItem each key →
`host.onKeysRemoved` (sync tombstones via `sync.noteLocalWrite(key, null)` so a
paired peer can't resurrect wiped records) → if mounted,
`notifyGameKeyRemoved` per key (`arcade:state.changed value:null` drops them
from the frame's lsCache, else a live game rewrites from stale cache) →
re-render + toast.

### Modified files

- `index.html`: `#menu-records` item (🏆 "Records") near `#menu-multiplayer`
  (:337); static `.records-dialog` shell after connections dialog, same shell
  grammar (`__panel[role=dialog]` › `__header` › `__tabs[role=tablist]` with
  `.records-tab` (icon/label/badge) › `__scroll[role=tabpanel]` with
  Leaderboards `.records-board` rows (rank|score|name|date), Personal records
  `.records-list__row` (label|value|date), `.records-empty` (message + Play) ›
  `__footer` reset button, hidden on empty tabs); new module block after the
  MULTIPLAYER block importing `initRecords` + `gameHref`, sets
  `window.__arcade.records`.
- `styles.css`: `.records-dialog` modeled on `.connections-dialog`;
  `.records-tab--active`, `--empty` (opacity ~.55 — **empty tabs shown
  de-emphasized**), badge, destructive reset styling.
- `sw.js`: precache both new files; v48→v49.
- `package.json`: `"records-acceptance"` script.

Tab behavior: catalog order; one tab per catalog entry **including p2p-chat**
(uniform empty state — preserves zero per-game launcher code); first tab with
data selected on open; roving tabindex + arrow keys (may defer to R3).

### R2 tests

- `tools/records-unit.mjs` (auto-discovered; Map-backed fake store): collect
  happy path asc+desc; corrupt JSON / non-array / NaN-score filtering;
  mis-sorted asc re-sorted before top-10 cut; bad records rejected, unknown
  format kept; 50-cap; countPopulated; resetKeysFor exact include/exclude
  (incl. pi-game vs pi-game-2 trap); every formatRecordValue branch.
- `tools/records-acceptance.mjs` (Playwright, serveRepo + createRecorder,
  ci-catalog fixture): seed via addInitScript (game A scores+records, B empty,
  C garbage JSON + `<img onerror>` payload in a name); menu → Records; tab
  count == catalog; A badged, B --empty; C renders, no page errors, hostile
  name inert; A shows ≤10 rows + `1:42.13` formatting; Play mounts frame;
  reset cancel no-op, ok removes exactly scores/records/stats/_scoreOrders,
  leaves state keys, panel flips empty.

## PR R3 — Live updates + polish

- `index.html` :1639 `onStateWritten`: after the sync call, fan out
  `window.__arcade.records?.noteStateWritten(gameId, key, value)` — every
  bridged write funnels through `handleBridgedStateWrite`
  (arcade-storage-bridge.js:96) → this hook; same-window storage events never
  fire, so this is the whole mechanism.
- `noteStateWritten`: ignore unless open AND `relevantKey`; ~150ms debounce;
  re-collect only that game; refresh badge; re-render iff active tab. Zero
  cost when closed. Optional: refresh on `onImportCommitted` (:1640).
- Polish: arrow-key tabs (if deferred), `aria-live="polite"`, reduced-motion-
  safe row flash. `sw.js` v49→v50.
- Tests: extend records-acceptance — sheet open, mount fixture game,
  `frame.evaluate(() => Arcade.records.set(...))`, assert live row + badge
  update; unit cases for `relevantKey`.

## Risks / edge cases

Hostile stored data (validate per-key, textContent-only, caps, slices; meta
never rendered in v1). Enumeration cost bounded by origin quota, debounced in
R3. Reset-vs-sync resurrection → tombstones. Reset-vs-mounted-frame lsCache →
state.changed push. Catalog load failure → "catalog unavailable" message.
best() first-write direction → full-record shape. Ritual drift fully gated.

## Verification (per PR)

`npm test` (units incl. sdk-version + check-sw-bump gates) → targeted
acceptance (`npm run sdk-helpers` for R1; `npm run records-acceptance` R2/R3)
→ manual: serve repo, play a seeded game, open Records sheet, check
formatting/badges/reset/live-update on a real phone-sized viewport.

## Follow-ups (out of scope)

cozy-solitaire migration `Arcade.stats` bests → `Arcade.records`
(cozy-solitaire#6, other repo); sowduku keyed hiScores (sowduku#3); stats
manifest / `Arcade.stats.declareSchema` (issue #12 option c, later); locale
duration formatting via `Arcade.settings`.
