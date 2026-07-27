// sow-duku — the short audition. THE one to listen to first.
//
//   node tools/soundpack/render.mjs sow-duku \
//     --audition tools/soundpack/auditions/sow-duku-short.js --version short
//
// A listening file, not a diagnostic one: every sound once, in the order a
// player meets it, with clear air around each — then one solve and one loss
// at real pace. No A/B material, no repetition runs, no isolated layers.
// The long `sow-duku.js` timeline is where the proving happens.
//
// v5.1: mid-game stays unpitched (voice + mud only), and the two endings
// get their instruments — the win a warm chime climbing with the calls, the
// fail the sad trombone, wah wah wah waaah, played on the piglet's own
// voice through a muted-brass resonance.
//
(function (global) {
  'use strict';
  const S = global.ArcadeAudioElements;
  const P = global.SowDukuPack;
  const { CUES, SENDS } = P;

  const GAP = 1.15;   // roomy: each sound needs to arrive alone
  const TAIL = 1.6;

  const o = (bus, name) => S.out(bus, SENDS[name]);
  const place = (ctx, bus, at, r) => {
    CUES['thud'](ctx, o(bus, 'thud'), at, null, r);
    CUES['pen'](ctx, o(bus, 'pen'), at, null, r);
  };

  const SECTIONS = [
    {
      title: 'The seven sounds',
      note: 'Each once, in the order you meet them. The hoofprint is the tiniest thing in the game — a scratch, not a step. A correct placement is the mud plus the piglet’s two-note "uh-huh!", the second note stepped clearly up: that step up IS the correct indicator. Wrong is a single rough wheek sliding up and cut off — a slide, where the yes is steps. The win is the yes celebrated, each climbing call landing with its own warm chime note — root, fifth, octave — then the happy wheek, the hop, and a lap of scampering trotters. The fail is the sad trombone: three wahs stepping down and a long slumping waaah, then the flop into the straw and one last breath. The star is the piglet approving of your taste: two quick sniffs and a pleased hum.',
      items: [
        { label: 'hoofprint marked — a tiny scratch in the mud', dur: 0.6, build: (ctx, bus, t, r) => CUES['hoof'](ctx, o(bus, 'hoof'), t, null, r) },
        { label: 'the step alone — a trotter into mud, no verdict', dur: 0.9, build: (ctx, bus, t, r) => CUES['thud'](ctx, o(bus, 'thud'), t, null, r) },
        { label: 'A CORRECT PLACEMENT — step + "uh-huh!" (two notes, up)', dur: 1.1, build: (ctx, bus, t, r) => place(ctx, bus, t, r) },
        { label: 'wrong — one rough wheek, up and cut off', dur: 1.0, build: (ctx, bus, t, r) => CUES['slip'](ctx, o(bus, 'slip'), t, null, r) },
        { label: 'THE WIN — chime + calls climbing, the hop, the lap', dur: null, cue: 'oink', send: SENDS['oink'] },
        { label: 'THE FAIL — wah wah wah waaah, then the flop', dur: null, cue: 'fail', send: SENDS['fail'] },
        { label: 'starred — double-sniff + a pleased hum', dur: null, cue: 'star', send: SENDS['star'] },
      ],
    },
    {
      title: 'One game',
      note: 'A real solve: two hoofprints scratched in while thinking, placements at thinking pace, one wrong guess, a faster run as the board opens up, and the last piggy in — then a beat, and the win in clear air. After it, the field is starred. Then the same board lost: three mistakes and the piglet flops. Listen for the three-layer depth: scratches under steps under voice.',
      items: [
        {
          label: 'a solve — scratches, placements, a mistake, the finish, a star', dur: 16.5,
          build: (ctx, bus, t, r) => {
            CUES['hoof'](ctx, o(bus, 'hoof'), t + 0.3, null, r);
            CUES['hoof'](ctx, o(bus, 'hoof'), t + 0.75, null, r);
            place(ctx, bus, t + 1.6, r);
            place(ctx, bus, t + 3.1, r);
            CUES['slip'](ctx, o(bus, 'slip'), t + 4.6, null, r);
            CUES['hoof'](ctx, o(bus, 'hoof'), t + 5.7, null, r);
            place(ctx, bus, t + 6.6, r);
            place(ctx, bus, t + 7.5, r);
            place(ctx, bus, t + 8.3, r);
            place(ctx, bus, t + 9.2, r);              // the last piggy
            CUES['oink'](ctx, o(bus, 'oink'), t + 9.2, null, r);
            CUES['star'](ctx, o(bus, 'star'), t + 12.6, null, r);   // keep it
          },
        },
        {
          label: 'the same board, lost — three mistakes and the last heart', dur: 7.5,
          build: (ctx, bus, t, r) => {
            place(ctx, bus, t + 0.3, r);
            CUES['slip'](ctx, o(bus, 'slip'), t + 1.5, null, r);
            place(ctx, bus, t + 2.7, r);
            CUES['slip'](ctx, o(bus, 'slip'), t + 3.7, null, r);
            CUES['slip'](ctx, o(bus, 'slip'), t + 4.9, null, r);
            CUES['fail'](ctx, o(bus, 'fail'), t + 4.9, null, r);
          },
        },
      ],
    },
  ];

  global.PACK = { name: P.name, ROOM: P.ROOM, SENDS, CUES, SECTIONS, GAP, TAIL };
})(typeof window !== 'undefined' ? window : globalThis);
