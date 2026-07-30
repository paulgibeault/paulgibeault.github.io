# Testing the platform locally

Every check CI runs is a plain CLI command you can run on a laptop — CI calls
the same scripts (`fleet-ci.yml` runs `npm test`, nothing more). This doc maps
the configurations, from "one command, everything" down to "one suite while
iterating".

## One-time setup

```sh
npm install                        # Playwright (the only dev dependency)
npx playwright install chromium    # the browser the acceptance tier drives
```

Node ≥ 24 (see `package.json` engines). The launcher itself is plain static
HTML — this toolchain exists only for testing and staging.

## Configuration A — the full gate: `npm test`

`npm test` runs [`tools/run-ci.mjs`](tools/run-ci.mjs), the exact CI gate, in
four tiers:

1. **syntax** — `node --check` on every tracked `.js`/`.mjs`
2. **deploy-artifact** — [`tools/verify-artifact.mjs`](tools/verify-artifact.mjs)
   stages the real deploy artifact via [`tools/stage.mjs`](tools/stage.mjs) and
   verifies index.html's tags, the service-worker precache list, and the
   published file set agree (identical script fleet-wide)
3. **units** — [`tools/run-units.mjs`](tools/run-units.mjs), see Configuration B
4. **acceptance** — every `tools/*-acceptance.mjs`, discovered not enumerated
   (a new suite runs with zero edits to the runner or workflow), each booting
   its own hermetic static server + headless Chromium

Useful variants:

```sh
node tools/run-ci.mjs p2p sync        # only stages whose name contains a substring
SKIP_BROWSER=1 node tools/run-ci.mjs  # syntax + artifact + units only (no Playwright needed)
```

Two curated lists inside `run-ci.mjs` shape the acceptance tier — check the
source for the current membership:

- `FLAKY` — real-WebRTC suites retried up to 3 attempts (timing-sensitive
  under headless CI; a genuine regression fails all attempts)
- `NOT_YET_IN_CI` — suites that exist but are visibly skipped pending triage
  (reported as `skipped:` in the summary, so they're excluded loudly, not
  invisibly absent)

## Configuration B — units only: `npm run test:units`

No browser, no ports, seconds not minutes. Discovers and runs every
`tools/*-unit.mjs` sequentially — pure-logic suites (validators, codecs,
retention planning, HLC merge rules, repo gates). Naming a file
`tools/<thing>-unit.mjs` is the entire registration step.

Run one directly while iterating:

```sh
node tools/save-validation-unit.mjs
```

## Configuration C — one acceptance suite at a time

Every acceptance suite is hermetic and self-contained: it starts its own
static server over the repo root (ports in the 4784–4807 range) and its own
headless Chromium, then exits 0/1. Nothing needs to be running first.

```sh
node tools/backup-dialog-acceptance.mjs   # or any tools/*-acceptance.mjs
npm run sync-acceptance                   # most suites also have an npm alias
```

Grouped by what they exercise (aliases from `package.json`; the files are the
source of truth):

| Area | Suites |
| --- | --- |
| Save / export / import | `export-roundtrip`, `export-advanced-acceptance`, `save-unit` |
| Game Data dialog | `backup-dialog-acceptance` |
| Local + peer backup | `local-backup-acceptance`, `backup-acceptance` (+ `-unit` pairs) |
| Sync + leaderboards | `sync-acceptance`, `leaderboard-acceptance` (+ `-unit` pairs) |
| Records | `records-acceptance` |
| Storage bridge / store / UI bridge | `bridge-acceptance`, `store-acceptance`, `ui-acceptance` |
| P2P transport | `p2p-acceptance`, `p2p-multiseat`, `p2p-multiparty`, `p2p-reconnect`, `p2p-crosssign` |
| Identity | `user-identity-acceptance` (+ `-unit`) |
| Catalog / configs / SDK | `catalog-acceptance`, `configs-acceptance`, `configs-p2p-acceptance`, `sdk-helpers` |
| Audio graph | `node tools/audio-graph-acceptance.mjs` (real WebAudio, no server) |

Suites bind fixed ports, so run them **one at a time** (the runner already
does; two P2P suites in parallel will collide).

## Configuration D — interactive: launcher + real games

For hands-on testing and for running the per-game integration checklist
against a game you're developing:

```sh
./dev.sh ../<your-game-repo>            # stage launcher + game, one origin
./dev.sh ../my-app ../my-other-app      # several games side-by-side
./dev.sh stop                           # kill the dev server
```

Serves `127.0.0.1:4791` (override: `ARCADE_PORT`). Builds each game if it has
a build script, rewrites production-origin URLs, and serves via
[`tools/dev-server.py`](tools/dev-server.py) — `Cache-Control: no-store` (a
header-less server once served stale modules across sessions) and
`Access-Control-Allow-Origin: *` (opaque-origin game frames fetch as
`Origin: null`, matching GitHub Pages). Only games passed on the command line
are mounted; other launcher tiles 404 by design.

Then, in another shell, the GAME_INTEGRATION §13 checklist runner:

```sh
npm run acceptance -- http://127.0.0.1:4791/<gameId>/    # per-game checklist
node tools/acceptance.mjs --pool http://127.0.0.1:4791/  # iframe-pool checks (needs ≥3 catalog games)
```

`tools/acceptance.mjs` is the one runner with modes; without `--serve` it
expects the URL to already be reachable (that's the dev.sh pairing above).
With `--serve` it is hermetic — this is how CI runs it on a bare checkout,
using committed fixtures instead of real games:

```sh
npm run acceptance:pool     # --pool --serve --catalog tools/fixtures/ci-catalog.json
node tools/acceptance.mjs --serve --catalog tools/fixtures/pergame-catalog.json \
  --mount starter-app=tools/fixtures/starter-app http://127.0.0.1:4799/starter-app/
```

(`--port <n>` picks the hermetic port, default 4799; `--mount id=dir` hosts a
fixture game at `/<id>/`.)

Debugging the launcher↔game handshake interactively: append `?dev=1` to
either URL for postMessage tracing (GAME_INTEGRATION §12; `?dev=0` clears).

## Configuration E — launcher only, no games

For menu / dialog / settings work where games are irrelevant, skip staging and
serve the repo root directly:

```sh
python3 tools/dev-server.py 4791 .
```

The `.claude/launch.json` `arcade-launcher` preview entry runs exactly this.
Game tiles 404 (nothing is staged) — expected; everything launcher-side
(menu, Game Data dialog, Records, Multiplayer, save/export) is fully live.
Seed test data from the console with plain
`localStorage.setItem('arcade.v1.<gameId>.…', …)` writes.

## Port map & collisions

| Port | Owner |
| --- | --- |
| 4791 | dev.sh default **and** the launcher-only preview — one at a time; a forgotten dev.sh server blocks (and masquerades as) the preview. `./dev.sh stop` frees it. |
| 4784–4807 | acceptance suites, one fixed port each (sequential runs only) |
| 4799 | `tools/acceptance.mjs --serve` default |

## What CI adds that local runs don't

Nothing, by design — `fleet-ci.yml`'s test job is `npm test` on the same
scripts. The only deploy-time difference is that CI rewrites `sw.js`'s
`APP_VERSION` on deploy (never hand-bump it; `repo-gates-unit.mjs` Gate D
asserts the line keeps the shape CI's rewrite targets).
