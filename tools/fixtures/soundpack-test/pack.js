// Fixture sound pack — the framework's own, and the only pack in this repo.
//
// It exists so the soundpack toolchain (render.mjs, analyze.mjs, wavdiff.mjs,
// lib/audition.js) can be exercised end to end on a bare checkout, with no app
// repo present. It is deliberately dull: four cues, one per element family that
// the archetypes need to have something to say about. Nothing here is a design
// — if you want to hear what the elements can do, read an app's pack.
//
// Plain script, no imports, loaded by eval — same contract as a real pack.

(function (global) {
  'use strict';
  const S = global.ArcadeAudioElements;

  // A small, dry-ish room. Short enough that renders stay quick.
  const ROOM = {
    dur: 0.45,
    decay: 0.15,
    preDelay: 0.006,
    wet: 0.22,
    shelfHz: 2800,
    shelfDb: -6,
    seed: 4242,
  };

  // How far away each cue sits. Spread across the range so the dry/wet
  // archetype has a visible difference to report.
  const SENDS = {
    tick: 0.04,
    knock: 0.10,
    chime: 0.22,
    sweep: 0.16,
  };

  const CUES = {
    // Bare contact click — the quietest thing here, and the level floor the
    // analyzer's "inaudible" threshold is calibrated against.
    tick: function (ctx, o, t, params, r) {
      S.strike(ctx, o, t, {
        dur: S.between(r, 0.004, 0.007), hp: 2600,
        gain: 0.10, seed: (r() * 1e6) | 0,
      });
      return 0.12;
    },

    // Contact plus a little wooden body — two layers, so a masking bug in the
    // element library shows up as a missing partial rather than silence.
    knock: function (ctx, o, t, params, r) {
      S.strike(ctx, o, t, { dur: 0.005, hp: 3000, gain: 0.09, seed: (r() * 1e6) | 0 });
      S.body(ctx, o, t + 0.002, {
        f0: S.between(r, 190, 210) * S.cents(r, 60),
        partials: [
          { ratio: 1.0, gain: 1.0, decay: 0.16 },
          { ratio: 2.7, gain: 0.35, decay: 0.10 },
        ],
        gain: 0.20, seed: (r() * 1e6) | 0,
      });
      return 0.30;
    },

    // Pitched and ringing — the one cue with a long tail, so "the room must
    // not be a tail" has a case where the two are genuinely hard to separate.
    chime: function (ctx, o, t, params, r) {
      S.body(ctx, o, t, {
        f0: (params && params.freq ? params.freq : 660) * S.cents(r, 25),
        partials: [
          { ratio: 1.0, gain: 1.0, decay: 0.55 },
          { ratio: 2.01, gain: 0.30, decay: 0.38, delay: 0.004 },
          { ratio: 3.4, gain: 0.12, decay: 0.22, delay: 0.008 },
        ],
        gain: 0.18, seed: (r() * 1e6) | 0,
      });
      return 0.70;
    },

    // Filtered-noise gesture — the "is this all hiss?" case, and the one cue
    // whose character comes from a moving filter rather than a pitch.
    sweep: function (ctx, o, t, params, r) {
      S.rustle(ctx, o, t, {
        f0: S.between(r, 900, 1100), f1: S.between(r, 300, 380), Q: 1.6,
        lp: 2400, dur: S.between(r, 0.20, 0.26), gain: 0.13,
        attack: 0.03, seed: (r() * 1e6) | 0,
      });
      return 0.35;
    },
  };

  S.registerPack({ name: 'soundpack-test', ROOM, SENDS, CUES });
})(typeof window !== 'undefined' ? window : globalThis);
