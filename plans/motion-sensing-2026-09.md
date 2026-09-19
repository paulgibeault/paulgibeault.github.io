# Motion sensing — `Arcade.motion`, design and work packages

*2026-09-18. Prompted by "can I physically tilt my phone to use Sand Art's
Tilt?" and then "plan an arcade feature for gyro sensing that games can tap
in to." First consumer: Sand Art's Tilt chip (sand-art#3, kernel rule R17).*

Design stance, in one paragraph: a phone knows which way down is, and a
game should be able to ask without learning Euler angles, iOS permission
rituals, or the sandbox. So motion ships the way files and dialogs did: the
**launcher owns the sensor and the consent**, the **SDK owns the maths and
the lifecycle**, and a game gets one small stream — *gravity in the axes of
its own screen* — that pauses itself when the game is hidden. Motion is an
input like any other: never the only way to do something, off until asked
for, and cheap when idle (the sensor is not listened to unless an active
game has started it).

## Decisions — 2026-09-18 (Paul)

1. **Brokered** (§1, route B): the launcher owns the sensor and the consent;
   standalone listens directly; one SDK surface.
2. **Consent is remembered per game, with a clear and easy way to turn it
   off.** One *Motion* section in the launcher menu holds it all: a master
   switch and, under it, every game that has asked, each with its own
   toggle. That answers the open question about a global switch too — it is
   the top row of the same place, not a separate setting to find.
3. **Gravity first, true gyro soon** (WP6 is scheduled, not hypothetical).
   WebAssembly for the processing was offered; §7 says when it would and
   would not earn its place.

## Status — 2026-09-18, implementation pass (same PR)

| WP | State |
|---|---|
| WP0 | Probe built and **run on iPhone Safari (2026-09-19)** — §0 table. Still owed: the grant's lifetime after Allow (reload / new tab), the installed PWA, angles 270/180, and an Android phone. #169 stays open for those. |
| WP1 | Done — `arcade-motion-core.js`, `tools/motion-unit.mjs`. |
| WP2 | Done — `arcade-motion-bridge.js`, router case + cap, *Motion* menu section, top-bar mark. |
| WP3 | Done — SDK 3.17.0, GAME_INTEGRATION §7f/§5/§13/§14, ARCADE_PLATFORM, changelog. |
| WP4 | Done — `tools/motion-acceptance.mjs` (auto-discovered by `run-ci.mjs`). |
| WP5 | Done as a draft — [sand-art#13](https://github.com/paulgibeault/sand-art/pull/13), gated on `available()`; merge after this deploys. On-phone check owed. |
| WP6 | Not started, by design: its KATs are the traces WP0 records (#170). |

**What the review of this plan changed** (each is reflected in the sections
below):

1. **The parked red test was a wrong fixture, not an open convention.** It
   fed `γ = +90` at angle 90, i.e. "the device's right edge is down" — but at
   angle 90 the device's top points to the player's *left*, so its right edge
   is *up* and the device reports `γ = −90`. The spec, Android's
   `Surface.ROTATION_90` and iOS's `window.orientation = 90` all agree on
   that. The maths was right; the unit tier now pins the corrected cases for
   all four angles. WP0 still confirms it on glass, but it is no longer a
   blocker for WP1.
2. **§3 and §6 disagreed about storage** (`_meta.motion.<gameId>` vs one
   `_meta.motion` record). One record, §6's shape.
3. **The wire needed a third message.** "A row flipped Off ⇒ `available()`
   false at once" cannot ride `settings.changed` (that is global, the row is
   per game): `arcade:motion.state { enabled }`, plus `welcome.motion.enabled`
   at handshake. It goes to *every mounted frame*, since the master switch
   changes `available()` for a game that has never asked.
4. **Suspend is not on the wire.** The launcher already knows the active app
   and the page's visibility, so it attaches and detaches its one listener
   itself; the SDK additionally drops any sample that arrives while
   suspended. No stop/start round-trip per app switch, and no race with one.
5. **The gesture must be the click itself.** `host.dialog` resolves in a
   microtask after the OK click; iOS wants `requestPermission()` inside the
   gesture. The launcher dialog gained `opts.onOk`, run synchronously in the
   click handler. (The probe had the same bug in its first draft.)
6. **The §8 iOS-lifetime risk is handled both ways, not deferred to WP0:**
   a remembered Allow first tries `requestPermission()` with no gesture; if
   Safari rejects, a one-tap toast is the gesture. WP0 only tells us which
   path iOS users will actually see.
7. **`available()` needs a sensor heuristic.** Desktop Chrome defines
   `DeviceOrientationEvent` and never fires it, and #168 requires
   `available()` false on a desktop. Rule: event defined ∧ secure context ∧
   a touch screen. A touch laptop passes it and gets `'unavailable'` from
   `start()` after the 1.5 s wait.
8. **Games need to hear about a revocation:** `Arcade.motion.onChange(fn)` →
   `{ available, running }`, and `running()`.
9. **Shape rules live in the core** (`validateMotionOp`) rather than
   `arcade-envelope.js`, so the whole feature's pure half is one file with
   one unit suite.
10. **Cut after a value review (2026-09-18):** `Arcade.settings.motion()` —
    no consumer, and `available()` + `onChange` already carry both switches,
    so it would have been permanent public surface for nothing; and the
    "last used" stamp — a localStorage write per start for a tooltip touch
    users never see. `at` stays as "when answered".
11. **Desk findings worth keeping** (Chromium 147, headless): an opaque
    sandboxed frame *without* `allow` receives zero orientation events; with
    `allow="accelerometer; gyroscope; magnetometer"` but no granted
    permission it receives exactly one all-null event. The bridge and SDK
    therefore treat null angles as "no sensor", never as a sample.

## 0. What is true today (code-verified)

- The game frame is `sandbox="allow-scripts allow-downloads"` with
  `allow="autoplay; fullscreen; gamepad; screen-wake-lock; clipboard-write"`
  (`arcade-pool.js:136`). No `accelerometer`/`gyroscope`: a framed game gets
  **no** `deviceorientation`/`devicemotion` events at all.
- Nothing in the SDK, the launcher or GAME_INTEGRATION mentions motion.
- iOS Safari delivers motion only after
  `DeviceOrientationEvent.requestPermission()` resolves `'granted'`, and
  that call must come from a user gesture. Android Chrome asks nothing.
- The platforms disagree on the sign of
  `devicemotion.accelerationIncludingGravity`; they agree on
  `deviceorientation`'s `beta`/`gamma`. Gravity in the device's frame is
  `(cosβ·sinγ, −sinβ, −cosβ·cosγ)`; the screen's rotation
  (`screen.orientation.angle`) must then be taken out, because games draw
  upright on the *screen*, not the device.
- A parked Sand Art branch (`phone-tilt`, local) already has this maths and
  an 8-direction follower with hysteresis as a pure module with tests; its
  one red test is the landscape case — a wrong fixture (Status, item 1), now
  corrected in `tools/motion-unit.mjs`; WP0 confirms on hardware.

**WP0 findings** (from `/motion-probe.html`; iPhone column measured
2026-09-19, iOS 18.7 / Safari 27.0 — the rest still owed):

| | iPhone Safari | iPhone installed PWA | Android Chrome |
|---|---|---|---|
| arrow points at the floor at angle 0 / 90 / 180 / 270 | **0 ✓, 90 ✓** (top to the left: angle 90, γ ≈ −84 — the convention the unit tier pins); 270 and 180 not yet held | | |
| `screen.orientation` present; `window.orientation` | both present (`portrait-primary`, 0) | | |
| `requestPermission()` before any grant, no gesture | rejects `NotAllowedError` | | n/a |
| …from a tap | `granted` (orientation and motion) | | n/a |
| …in a **new tab**, 11 min after a grant, no gesture | **rejects `NotAllowedError`** — the grant does not carry a gesture-less call; from a tap it is `granted` again (whether iOS re-shows its own prompt: to confirm). Same-tab reload still untested. | | n/a |
| `deviceorientation` / `devicemotion` events per second | 59.8 / 59.8 | | |
| sign of `accelerationIncludingGravity` | **gravity itself** (upright: y ≈ −9.5; on its left edge: x ≈ −9.7) — `aigSign +1` | | expected opposite |
| `interval` units | **seconds** (0.01667) | | expected ms |
| sandboxed frame, no `allow`: events | **0**; `requestPermission()` from inside → `denied` | | |
| sandboxed frame, with `allow`: events; ask from inside | **0**; → `denied` — delegation does not work | | |

What this settles:

- **Brokering is not a preference on iOS, it is the only route.** Even with
  `allow="accelerometer; gyroscope; magnetometer"` an opaque sandboxed frame
  gets no events and its own `requestPermission()` is refused. §1's route A
  is dead on iPhone regardless of the privacy argument.
- **The maths is right on glass, and against a second sensor.**
  `tools/fixtures/motion/ios-safari-18_7-landscapes.json` pairs the OS's
  orientation angles with the raw accelerometer on a still hand;
  `motion-unit.mjs` requires our formula's device-frame gravity to match
  `accelerationIncludingGravity` within 0.08 per axis (worst seen: 0.047),
  and pins angle 90 ↔ γ ≈ −84 ↔ "down the screen".
- **The §8 lifetime risk is real, so the one-tap path is live code.** A
  remembered Allow still needs a top-level gesture on each fresh page: the
  game's tap happens inside the frame and does not count, so the bridge's
  gesture-less `requestPermission()` rejects and the "Tap to enable motion"
  toast is what a returning iPhone player actually sees. Candidate
  improvement, pending one observation (does iOS re-show its system prompt
  on that tap?): spend the *tile tap that launches the game* as the gesture
  for games whose row is Allowed, so the chip works first time.
- Second run (04:42Z) also laid the phone flat: a.i.g. z = −10.77 face up —
  gravity itself, confirming `aigSign +1`. Its frames again saw 0 events.
- **For WP6:** iOS `interval` is in seconds and its a.i.g. is gravity itself;
  the sample's own `timeStamp` is the only portable `dt`.
- **The event stream stalls.** The 10 s trace has gaps of 0.9 s and 2.1 s in
  portrait and ~0.5 s across the rotation animation. A consumer must not
  treat a quiet second as "sensor gone"; the bridge's 1.5 s rule applies only
  to the *first* event, which is right.

## 1. The decision: brokered, not delegated

Two ways to get the sensor into an opaque-origin frame:

| | A. Delegate (`allow="accelerometer; gyroscope"`) | **B. Broker (launcher listens, streams over postMessage)** |
|---|---|---|
| Consent | none on Android — every game could read the sensor silently; iOS prompt raised from inside the frame | launcher dialog per game (the `openFile`/`share` pattern), remembered, revocable |
| iOS | `requestPermission()` inside a sandboxed third-party frame: unverified, historically fragile | the dialog's **Allow** tap is the top-level gesture iOS wants |
| Active-app rule | none — a pooled, hidden frame keeps receiving events | launcher streams to the active app only |
| Cost | zero | one small message per sample (≤ 60 Hz, 3 floats), ~1 frame of latency |
| Standalone | works as is | n/a — standalone has no launcher |

**Recommendation: B for framed games, direct listening for standalone**,
behind one SDK surface so a game never knows which it got. Motion sensors
are a known side channel (tap inference, fingerprinting); the platform's
trust boundary is "a game gets what the launcher hands it", and A would be
the first exception. The message cost is far below the storage bridge's.

Compatibility is the usual `welcome.caps` rule: a new cap
**`motion.bridge`**; absent ⇒ `Arcade.motion.available()` is false framed
and the game's tilt control simply is not offered.

## 2. The surface (SDK 3.17.0, additive)

```js
if (Arcade.motion.available()) showTiltControl();

// From a tap. Framed: the launcher asks the player once per game, then
// remembers. Standalone on iOS: this IS the gesture requestPermission needs.
const how = await Arcade.motion.start({ hz: 30 });   // 'granted' | 'denied' | 'unavailable'

const off = Arcade.motion.on((m) => {
  m.x, m.y      // gravity in the plane of the SCREEN, grid axes: x right, y down.
                // Length ≈ 1 held upright in any roll, → 0 lying flat.
  m.z           // out of the glass, towards the player (−1 face up on a table)
  m.flat        // true when x,y are too short to mean a direction
  m.t           // ms, monotonic
});
Arcade.motion.stop();                                 // and `off()` to unsubscribe
Arcade.motion.running();                              // between a granted start() and stop()
Arcade.motion.onChange(({ available, running }) => …); // a Motion switch flipped, a stream began/ended
```

- **One vector, already in screen axes.** The Euler maths and the four
  screen rotations live in the SDK once, unit-tested, instead of in every
  game (it has already bitten one).
- **`Arcade.motion.compass(n, opts)`** — a small pure helper that quantises
  `x,y` to `n` directions with hysteresis and a flat-hold, answering only on
  a change: `c.update(m)` → `{ dir, gx, gy }` or `null`, on the sand
  kernel's ring (clockwise from screen-right, y down; `compass(8)` starts at
  index 2, straight down). Sand Art needs `n = 8` (the kernel's ring); a marble game wants
  the raw vector; a menu wants `n = 4`. Hysteresis is easy to get wrong and
  each change can be expensive for the game (Sand Art wakes every chunk).
- **Lifecycle is the SDK's.** Samples stop on `onSuspend` and resume on
  `onResume` without the game doing anything (the `Arcade.session` pattern);
  the launcher also streams only to the active app, so a pooled frame is
  silent twice over.
- **Settings.** The launcher's *Motion* section: a master switch (default
  on), and a per-game toggle for
  every game that has asked. Either one off ⇒ that game's `available()` is
  false and a running stream stops at once. It is independent of
  `reducedMotion`, which is about what the screen does, not what the hand
  does. A game that is streaming also shows in the launcher's top bar (a
  small motion mark beside the title), and tapping it opens the same
  section — the toggle is one tap from wherever motion is in use.
- **v1 is gravity** (what "tilt the phone" means). Rotation rate, shake and
  a fused attitude (`devicemotion`, the gyro proper) are WP6, added as
  extra fields on the same sample; the sample shape and the wire message
  are designed so they slot in without a second API (§7).

## 3. The wire (cap `motion.bridge`; the SDK speaks this for you)

```
child  → parent: arcade:motion.op      { op: 'start', id, hz }   // RPC → bridge.result: 'granted'|'denied'|'unavailable'
child  → parent: arcade:motion.op      { op: 'stop' }
parent → child:  arcade:motion.sample  { x, y, z, t }            // ≤ hz, active app only, only between start and stop
parent → child:  arcade:motion.state   { enabled }               // a Motion switch flipped (every mounted frame)
welcome gains:   motion: { enabled }                             // sensor plausible ∧ master on ∧ this game's row not Off
```

Launcher side (`arcade-motion-core.js` pure + `arcade-motion-bridge.js`):

1. `start` from a game with no remembered answer → `host.dialog`:
   *"Sand Art would like to use your device's motion."* **Allow** /
   **Not now**. Allow's click calls `requestPermission()` where it exists.
   (synchronously, via the dialog's `onOk`). The answer is remembered per
   game in the one `_meta.motion` record (§6), listed and revocable in the
   launcher menu's *Motion* section.
2. One top-level `deviceorientation` listener while ≥ 1 active game has
   started; removed otherwise. Convert to screen-frame gravity, throttle to
   the requested `hz` (cap 60, default 30), post to the active frame.
3. Backgrounded app ⇒ `start` answers `'denied'` without a dialog (the
   existing active-only rule for anything that interrupts).
4. `'unavailable'`: no `DeviceOrientationEvent`, insecure context, the
   settings switch off, or no event within ~1.5 s of listening (a desktop
   defines the event and never fires it).

## 4. The contract GAME_INTEGRATION gains (§7f)

- [ ] **Motion is never the only way.** Every motion-driven control has a
  touch/keyboard equivalent (Sand Art keeps its Tilt chip states).
- [ ] **Ask from a tap, for a reason the player can see.** `start()` on
  load is a denied prompt on iOS and a surprise everywhere.
- [ ] **Stop when you are not using it.** The sensor costs battery; §6d
  applies to inputs too. A game resting at 0 fps should not hold a 30 Hz
  stream it ignores — use `compass()` or stop.
- [ ] **Replays record what motion decided, not the samples.** Motion is
  outside the deterministic core; a recorded tilt is an input like a stroke.

## 5. Work packages

| WP | What | Where | Size | Gate |
|---|---|---|---|---|
| **WP0** | **Hardware probe.** A page in the launcher's diag view that shows raw `beta/gamma`, `screen.orientation.angle`, the derived vector, event rate, and the result of `requestPermission()` — top level, and from a sandboxed frame with and without `allow`. Run on an iPhone (Safari, installed PWA) and an Android phone. Settles: the landscape sign convention (the parked red test), whether iOS re-prompts per page load, real event rates, and records *why* we broker. | launcher | S | findings written into §0 here; needs Paul's phones, HTTPS (deployed diag page) |
| WP1 | Pure core: orientation → screen gravity for all four angles; throttle; `compass()`; consent state machine. | `arcade-motion-core.js`, `tools/motion-unit.mjs` | S | unit tier |
| WP2 | Launcher bridge, consent dialog, remembered + revocable answers, the *Motion* menu section + top-bar mark, cap `motion.bridge`. | `arcade-motion-bridge.js`, `arcade-router.js`, `index.html` | M | caps-contract unit (`tools/caps-contract-unit.mjs:29`), repo gates |
| WP3 | SDK `Arcade.motion` — framed via bridge, standalone direct, suspend/resume; 3.17.0 changelog; GAME_INTEGRATION §7f, §14 wire table, §13 checklist line; ARCADE_PLATFORM caps list. | `arcade-sdk.js` + `sdk/v3/` | M | sdk-version unit |
| WP4 | `tools/motion-acceptance.mjs`: Playwright + CDP `DeviceOrientation.setDeviceOrientationOverride` — cap advertised; dialog allow/deny; samples reach only the active frame; silence after suspend/stop; settings switch; standalone path. `tools/acceptance.mjs` check 11 learns the new cap. | launcher | M | CI acceptance step |
| WP5 | **Sand Art: a "Phone" state on the Tilt chip** using `Arcade.motion.compass(8)` → `sim.tilt()`. The parked `phone-tilt` branch's maths moves to WP1; the game keeps only the chip. README "The hand" and the Library's Petra entry gain a sentence. | sand-art | S | its tests; on-phone check |
| WP6 | **True gyro, soon after v1**: `devicemotion` rotation rate and user acceleration on the same sample (`m.rate {x,y,z}` °/s in screen axes, `m.accel`), a fused attitude that does not drift or gimbal-lock (quaternion, complementary filter — §7), `shake`/`twist` detectors as helpers. Sign normalisation per platform from WP0's table. Second consumers (a marble-style tilt in Shui Guo Tan is the obvious one). | launcher core + SDK | M | unit KATs from recorded traces; acceptance via CDP |

Order: WP0 first — an hour on real phones removes the three unknowns that
would otherwise be discovered after WP2–WP3 ship. WP1–WP4 are one launcher
PR each or a single PR by the kernel plan's precedent; WP5 can merge any
time after, since the chip state is gated on `available()`.

## 6. Where the toggle lives (decision 2)

- **Launcher menu → Motion.** Master switch; then a row per game that has
  ever asked: name, *Allowed* / *Off*. Flipping a row off stops
  a live stream immediately and makes the next `start()` answer `'denied'`
  without a dialog; flipping it back on re-arms the dialog-free path.
- **In the moment.** While a game streams, a motion mark sits in the top
  bar; tap → the same section, scrolled to that game.
- **In the consent dialog.** *Allow* / *Not now*, and a line saying where
  to change it later. *Not now* is not remembered as a refusal — the game
  may ask again from the player's next tap; a row set to *Off* is.
- Storage: `_meta.motion` = `{ enabled, games: { <gameId>: { allowed, at } } }`,
  launcher-owned, outside every game's namespace, carried in the save
  bundle like other `_meta`.

## 7. WebAssembly for the processing — when it earns its place

The offer was to put the processing in a compiled module if that improves
performance and accuracy. The honest accounting:

- **Accuracy does not come from the language.** It comes from the fusion
  algorithm (complementary or Madgwick filter over gyro + accelerometer),
  from using the sample's own timestamps for `dt`, and from per-platform
  sign and unit normalisation. The same filter in JS and in wasm gives the
  same numbers to the last bit that matters; browsers already hand
  `deviceorientation` out pre-fused by the OS, which v1 uses.
- **Performance is not the constraint.** A fusion step is ~60 floating-
  point operations. At 60 Hz that is microseconds per second in either
  language — three orders of magnitude under one sand-kernel step. The
  cost that matters is the sensor being on and the messages crossing the
  frame, which is why the plan spends its effort on "one listener, active
  app only, stop when idle" instead.
- **What the kernel discipline does buy** is the part worth copying: a
  reference implementation that is the specification, known-answer tests
  from **recorded real traces** (WP0 captures them), and hashes that make a
  behaviour change loud. WP1 and WP6 use that discipline in plain JS
  (`arcade-motion-core.js` + `tools/motion-unit.mjs`), which also runs
  under node with no toolchain.
- **When wasm would earn it:** if a consumer needs bit-identical motion
  across devices (a lockstep multiplayer tilt game replaying fused
  attitude), or if a future kernel consumes motion *inside* its step (a
  fluid or marble kernel taking gravity as a per-step vector — the sand
  kernel's `tilt()` is already the integer form of that). Then the fusion
  moves beside that kernel as `assembly/motion.ts` with the reference kept
  as its spec, exactly as `sand.ts` did. The core's API is written so that
  swap is invisible to the SDK.

Recommendation: JS core now, wasm-ready boundary, revisit with WP0's and
WP6's measurements in hand rather than on a guess.

## 8. Risks

- **iOS permission lifetime.** If Safari forgets the grant per page load,
  a remembered *Allow* still needs a gesture each launch: the launcher then
  shows a one-tap "Enable motion" toast instead of the full dialog. WP0
  decides which.
- **Landscape conventions** differ in folklore; WP0 measures them rather
  than trusting it. The SDK's tests pin whatever the phones report.
- **Installed-PWA quirks** on iOS (motion in standalone display mode) —
  probed in WP0.
- **Message rate.** 30 Hz × 4 numbers is trivial next to the storage
  bridge, but it is the first *streaming* parent→child message; WP2 keeps
  one listener and one throttle for the whole launcher, never one per game.
