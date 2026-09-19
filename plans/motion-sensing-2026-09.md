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
  one red test is the landscape case, which is exactly the convention WP0
  must settle on hardware.

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
```

- **One vector, already in screen axes.** The Euler maths and the four
  screen rotations live in the SDK once, unit-tested, instead of in every
  game (it has already bitten one).
- **`Arcade.motion.compass(n, opts)`** — a small pure helper that quantises
  `x,y` to `n` directions with hysteresis and a flat-hold, answering only on
  a change. Sand Art needs `n = 8` (the kernel's ring); a marble game wants
  the raw vector; a menu wants `n = 4`. Hysteresis is easy to get wrong and
  each change can be expensive for the game (Sand Art wakes every chunk).
- **Lifecycle is the SDK's.** Samples stop on `onSuspend` and resume on
  `onResume` without the game doing anything (the `Arcade.session` pattern);
  the launcher also streams only to the active app, so a pooled frame is
  silent twice over.
- **Settings.** A launcher switch, *Motion controls* (default on), surfaced
  as `Arcade.settings.motion()`; off ⇒ `available()` is false. It is
  independent of `reducedMotion`, which is about what the screen does, not
  what the hand does.
- **v1 is gravity** (what "tilt the phone" means). Rotation rate and shake
  (`devicemotion`, the gyro proper) are WP6, added as extra fields on the
  same sample when a game asks; nothing in v1 forecloses it.

## 3. The wire (cap `motion.bridge`; the SDK speaks this for you)

```
child  → parent: arcade:motion.op      { op: 'start', id, hz }   // RPC → bridge.result: 'granted'|'denied'|'unavailable'
child  → parent: arcade:motion.op      { op: 'stop' }
parent → child:  arcade:motion.sample  { x, y, z, t }            // ≤ hz, active app only, only between start and stop
```

Launcher side (`arcade-motion-core.js` pure + `arcade-motion-bridge.js`):

1. `start` from a game with no remembered answer → `host.dialog`:
   *"Sand Art would like to use your device's motion."* **Allow** /
   **Not now**. Allow's click calls `requestPermission()` where it exists.
   The answer is remembered per game (`_meta.motion.<gameId>`), listed and
   revocable in the launcher menu beside the other per-app controls.
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
| WP2 | Launcher bridge, consent dialog, remembered + revocable answers, *Motion controls* setting, cap `motion.bridge`. | `arcade-motion-bridge.js`, `arcade-router.js`, `index.html` | M | caps-contract unit (`tools/caps-contract-unit.mjs:29`), repo gates |
| WP3 | SDK `Arcade.motion` — framed via bridge, standalone direct, suspend/resume, `settings.motion()`; 3.17.0 changelog; GAME_INTEGRATION §7f, §14 wire table, §13 checklist line; ARCADE_PLATFORM caps list. | `arcade-sdk.js` + `sdk/v3/` | M | sdk-version unit |
| WP4 | `tools/motion-acceptance.mjs`: Playwright + CDP `DeviceOrientation.setDeviceOrientationOverride` — cap advertised; dialog allow/deny; samples reach only the active frame; silence after suspend/stop; settings switch; standalone path. `tools/acceptance.mjs` check 11 learns the new cap. | launcher | M | CI acceptance step |
| WP5 | **Sand Art: a "Phone" state on the Tilt chip** using `Arcade.motion.compass(8)` → `sim.tilt()`. The parked `phone-tilt` branch's maths moves to WP1; the game keeps only the chip. README "The hand" and the Library's Petra entry gain a sentence. | sand-art | S | its tests; on-phone check |
| WP6 | Later, on demand: rotation rate and shake on the same sample; second consumers (a marble-style tilt in Shui Guo Tan is the obvious one). | — | — | — |

Order: WP0 first — an hour on real phones removes the three unknowns that
would otherwise be discovered after WP2–WP3 ship. WP1–WP4 are one launcher
PR each or a single PR by the kernel plan's precedent; WP5 can merge any
time after, since the chip state is gated on `available()`.

## 6. Risks

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
