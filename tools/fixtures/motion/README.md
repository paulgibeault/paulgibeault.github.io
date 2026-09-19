# Motion traces

Recorded on real phones with `/motion-probe.html` (plan
`plans/motion-sensing-2026-09.md`, WP0 / launcher issue #169): ten seconds of
`deviceorientation` and `devicemotion` samples with their own timestamps, one
file per scripted move per device — `motion-<os>-<move>-<stamp>.json`.

They are the known-answer inputs for `tools/motion-unit.mjs` (the landscape
convention, WP1) and for the fusion work in the true-gyro issue (#170, WP6:
attitude within tolerance of the OS's own `deviceorientation` on the same
trace, no drift over the `still` traces, no gimbal flip through upright).

Empty until the probe has been run on hardware.
