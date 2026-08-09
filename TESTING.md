# Testing the platform locally

Every check CI runs is a plain CLI command you can run on a laptop — CI calls
the same scripts. For this repo that is `npm test` plus the fleet contract
gates, which `fleet-ci.yml` runs against every caller including this one. This
doc maps the configurations, from "one command, everything" down to "one suite
while iterating".

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

Nothing inside `run-ci.mjs` enumerates the acceptance tier. Every
`tools/*-acceptance.mjs` runs, and the one behavior that varies is derived from
the suite itself: a suite that imports `lib/p2p-test-harness.mjs` negotiates
real WebRTC, so it retries up to 3 attempts (timing-sensitive under headless
CI; a genuine regression fails all attempts). Anything else gets one attempt.

Retries are therefore a property of what a suite *does*, not of a list someone
remembered to update — the previous hand-kept list had drifted to five names
while nine suites were on the harness.

In CI (and only in CI), every other browser suite gets a single retry as well:
shared runners vary enough between runs that a launcher boot which fits a wait
budget at one moment misses double that budget minutes later. A genuine
regression still fails every attempt. Locally there are no retries at all —
flakiness at the desk should be loud enough to get studied, not absorbed.

The one exception is `MANUAL_ONLY`: suites that pass locally but cannot run on
CI hardware, skipped **only when `CI` is set** and always with the evidence
written beside the entry (currently just `p2p-multiparty` — its relayed-gossip
check starves on a 2-core runner). Locally, `npm test` still runs them; the CI
summary prints each one with its reason, so the exclusion stays loud.

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

## Configuration F — the fleet contract gates, on any repo

[`tools/contract-gates.mjs`](tools/contract-gates.mjs) is the §5/§6d
power-saver contract as three static gates (no browser, no network, zero
dependencies). `fleet-ci.yml` runs it against **every** caller, so this is the
one check a game repo cannot run from its own checkout — point it at the repo
instead:

```sh
node tools/contract-gates.mjs .                  # this repo
node tools/contract-gates.mjs ../some-game       # any fleet app's checkout
node tools/contract-gates.mjs --self-test        # the fixture corpus
```

It reads the target's own `git ls-files`, so it wants a real checkout rather
than a directory of files, and it exits `2` — not `0` — if that turns up
nothing to scan, because "no files" is a broken invocation rather than a pass.

Exit codes: `0` clean, `1` violations found, `2` the gate could not run.

`npm test` covers all of this here via `tools/contract-gates-unit.mjs`, which
runs the fixtures, this repo, and three throwaway git checkouts that drive the
real CLI — the exit code is what the pipeline reads, so it is what the suite
asserts on.

## Configuration G — render smoke: does the artifact draw?

[`tools/render-smoke.mjs`](tools/render-smoke.mjs) loads a **staged artifact**
in a real visible browser and asserts the screenshot's pixels are not
near-uniform. Also launcher-owned, also run per caller by `fleet-ci.yml` —
**warn-only for now**, so it annotates rather than failing a build.

Stage first, the way the deploy does, then point it at `dist/`:

```sh
node tools/stage.mjs dist                              # or: npm run build
node tools/render-smoke.mjs dist --sdk .               # this repo
node tools/render-smoke.mjs ../some-game/dist --sdk .  # any app's artifact
```

`--sdk` matters more than it looks. Games load `/arcade-sdk.js` by absolute
path, so serving an app's `dist/` alone 404s it and the app boots a degraded
path no player takes — measured on a real game, 230 distinct colours against
1026 with the SDK in place. Point it at a launcher checkout.

Other flags: `--hints <file>` for an app's own `tools/smoke.mjs` declaration,
`--warn` to annotate instead of failing, `--shot <file>` to keep the
screenshot, `--label` and `--port`.

Exit codes: `0` drew, `1` near-uniform frame, `2` no such artifact — a missing
`dist/` is a staging bug, not a rendering bug, and conflating them sends
someone hunting in the wrong file.

`tools/render-smoke-acceptance.mjs` runs in the acceptance tier and pins the
checker itself against a planted blank, a gated fixture and the starter app.

## Port map & collisions

| Port | Owner |
| --- | --- |
| 4791 | dev.sh default **and** the launcher-only preview — one at a time; a forgotten dev.sh server blocks (and masquerades as) the preview. `./dev.sh stop` frees it. |
| 4784–4808 | acceptance suites, one fixed port each (sequential runs only) |
| 4799 | `tools/acceptance.mjs --serve` default |
| 4860 | `tools/render-smoke.mjs` default — deliberately outside the block above, so smoking an artifact by hand never collides with a suite that is up |
| 4861–4869 | `tools/render-smoke-acceptance.mjs`, one per fixture run |

## What CI adds that local runs don't

Almost nothing, by design — but no longer literally nothing, so the two
differences are worth knowing.

**The fleet contract gates run as their own step**, before `npm test` and
before any install. They are launcher-owned and run against *every*
`fleet-ci.yml` caller, so for a game repo they are the one part of the gate
that does not live in that repo. For this repo they are also covered by
`npm test`, via `tools/contract-gates-unit.mjs` — so a laptop run does check
them here. See Configuration F.

**Render smoke runs last, and only warns.** It stages the artifact and checks
it draws something. Warn-only until it earns a track record on shared runners,
so it annotates and exits 0 — a red build never comes from here today. Its
own checker is covered by `npm test` (`render-smoke-acceptance.mjs`); smoking
a *staged artifact* is the part a laptop run skips. See Configuration G.

**CI rewrites `sw.js`'s `APP_VERSION` on deploy** — never hand-bump it;
`repo-gates-unit.mjs` Gate D asserts the line keeps the shape CI's rewrite
targets.
