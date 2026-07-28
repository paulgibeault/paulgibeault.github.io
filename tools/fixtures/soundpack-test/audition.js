// Fixture audition — exercises every archetype in lib/audition.js.
//
// This doubles as the worked example the README points at: it is the shortest
// complete audition that still uses each builder, so an app author can copy it
// and replace the content without inventing the structure.

(function (global) {
  'use strict';
  const A = global.ArcadeAudition;

  A.publish({
    gap: 0.5,
    tail: 1.2,
    sections: [
      // Pairs that share a register and must stay distinguishable.
      A.contrastPairs(
        'A · Grammar — the pairs that must not blur',
        'Two cues at a time, alternating. In use these arrive seconds apart, so if they blur back to back they are already lost.',
        [['tick', 'knock'], ['chime', 'sweep']],
        { spacing: 0.9, reps: 2 }
      ),

      // Generated from the pack: adding a cue cannot forget to add it here.
      A.everyCueDryWet(),

      A.section('C · Density and combination', 'What repetition and overlap do to cues that are fine in isolation.', [
        A.repeat('tick', { n: 8, spacing: 0.35 }),
        A.repeat('knock', { n: 5, spacing: 0.7 }),
        A.together(['knock', 'chime'], { label: 'knock + chime — the layered event' }),
        A.play('chime', { label: 'chime — high (params reach the cue)', params: { freq: 1180 } }),
      ]),

      A.section('D · Scenes', 'Cues at the timing something would actually fire them.', [
        A.scene('a run of ticks into a chime', 3.2, [
          { cue: 'tick', at: 0.0 }, { cue: 'tick', at: 0.3 }, { cue: 'tick', at: 0.6 },
          { cue: 'chime', at: 0.9 },
        ]),
        A.custom('hand-built: a knock under a descending sweep', 2.4, (ctx, bus, t, r) => {
          A.fire(ctx, bus, 'sweep', t, r);
          A.fire(ctx, bus, 'knock', t + 0.12, r);
        }),
      ]),
    ],
  });
})(typeof window !== 'undefined' ? window : globalThis);
