# Motion traces

Recorded on real phones with `/motion-probe.html` (plan
`plans/motion-sensing-2026-09.md`, WP0 / launcher issue #169): ten seconds of
`deviceorientation` and `devicemotion` samples with their own timestamps, one
file per scripted move per device — `motion-<os>-<move>-<stamp>.json`.

They are the known-answer inputs for `tools/motion-unit.mjs` (the landscape
convention, WP1) and for the fusion work in the true-gyro issue (#170, WP6:
attitude within tolerance of the OS's own `deviceorientation` on the same
trace, no drift over the `still` traces, no gimbal flip through upright).

- `ios-safari-18_7-landscapes.json` — 12 paired orientation/accelerometer
  samples hand-picked from the first iPhone trace (still moments only). The
  unit tier uses them to check the orientation → gravity formula against the
  accelerometer, and to pin screen angle 90 on real hardware. The full trace
  should replace the hand-picked rows once the probe's saved file is here.
