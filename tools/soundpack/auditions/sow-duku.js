// sow-duku — audition timeline, v5 (diagnostic).
//
//   node tools/soundpack/render.mjs sow-duku --version v5
//
// The PROVING file for the v5 no-music profile — listen to sow-duku-short.js
// first; come here when something in it needs isolating. v5 was a redesign,
// not a retune, so the old OLD-vs-NEW A/B sections are gone: there is no
// prior version of these cues worth comparing against. What remains are the
// checks that have caught real defects before:
//
//   · contour separation — the three verdicts (yes / wrong / win) share one
//     voice and are distinguished only by shape; heard back to back they
//     must be unmistakable, because in play they arrive seconds apart
//   · repetition at game density — level wander and fatigue both hide in
//     long runs and nowhere else
//   · dry/wet pairs — the room must stay "outside", never a tail
//
(function (global) {
  'use strict';
  const S = global.ArcadeAudioElements;
  const P = global.SowDukuPack;
  const { CUES, SENDS } = P;

  const GAP = 0.55;
  const TAIL = 1.8;

  const o = (bus, name) => S.out(bus, SENDS[name]);
  const place = (ctx, bus, at, r) => { CUES['thud'](ctx, o(bus, 'thud'), at, null, r); CUES['pen'](ctx, o(bus, 'pen'), at, null, r); };

  const SECTIONS = [
    {
      title: 'A · The grammar — one voice, three shapes',
      note: 'The whole design stands on these being unconfusable: the yes is two smooth DISCRETE steps up, the wheek is one rough CONTINUOUS slide up cut short, the win is the yes grown into three climbing calls. Alternating pairs, then each alone. If yes-then-wheek ever blurs, the pack has failed regardless of how nice anything sounds.',
      items: [
        { label: 'yes · wheek · yes · wheek — alternating', dur: 4.6, build: (ctx, bus, t, r) => { for (let i = 0; i < 2; i++) { CUES['pen'](ctx, o(bus, 'pen'), t + i * 2.3, null, r); CUES['slip'](ctx, o(bus, 'slip'), t + i * 2.3 + 1.15, null, r); } } },
        { label: 'the yes ×4 — smooth, stepped, up', dur: 3.6, build: (ctx, bus, t, r) => { for (let i = 0; i < 4; i++) CUES['pen'](ctx, o(bus, 'pen'), t + i * 0.9, null, r); } },
        { label: 'the wheek ×4 — rough, sliding, cut off', dur: 3.6, build: (ctx, bus, t, r) => { for (let i = 0; i < 4; i++) CUES['slip'](ctx, o(bus, 'slip'), t + i * 0.9, null, r); } },
        { label: 'the win ×2 — the yes, celebrated', dur: 4.4, build: (ctx, bus, t, r) => { CUES['oink'](ctx, o(bus, 'oink'), t, null, r); CUES['oink'](ctx, o(bus, 'oink'), t + 2.2, null, r); } },
        { label: 'win then fail — the two endings, back to back', dur: 5.2, build: (ctx, bus, t, r) => { CUES['oink'](ctx, o(bus, 'oink'), t, null, r); CUES['fail'](ctx, o(bus, 'fail'), t + 2.6, null, r); } },
      ],
    },
    {
      title: 'B · The touch layer',
      note: 'Scratch, step, placement — three sizes of the same mud, and the ordering has to be audible: hoofprint < step < placement. Then hoofprints at painting speed: dragging across a row marks up to six cells in under a second, and the scratch must stay a texture, never become a drum roll.',
      items: [
        { label: 'scratch · step · placement — the three sizes', dur: 3.3, build: (ctx, bus, t, r) => { CUES['hoof'](ctx, o(bus, 'hoof'), t, null, r); CUES['thud'](ctx, o(bus, 'thud'), t + 1.1, null, r); place(ctx, bus, t + 2.2, r); } },
        { label: 'hoofprints painted in a drag — six in a second', dur: 1.8, build: (ctx, bus, t, r) => { for (let i = 0; i < 6; i++) CUES['hoof'](ctx, o(bus, 'hoof'), t + i * 0.15, null, r); } },
        { label: 'hoofprints at tap pace ×5', dur: 3.0, build: (ctx, bus, t, r) => { for (let i = 0; i < 5; i++) CUES['hoof'](ctx, o(bus, 'hoof'), t + i * 0.6, null, r); } },
      ],
    },
    {
      title: 'C · Each cue — dry, then in the room',
      note: 'First without reverb, then with. The room must be barely more than a sense of OUTSIDE. The win and fail include their pre-roll, so each starts with about four tenths of a second of silence — the fix that keeps them out from under the move that triggers them, not a rendering fault.',
      items: Object.keys(CUES).flatMap((name) => ([
        { label: name + ' — dry', dur: null, cue: name, send: 0 },
        { label: name + ' — in the room', dur: null, cue: name, send: SENDS[name] },
      ])),
    },
    {
      title: 'D · Repetition — level and fatigue',
      note: 'Placements at the density of real play. The yes fires on every single correct move: the question is not "can I hear it" but "do I want to hear it a hundred more times", and whether its level holds — the ranges inside every cue are pinned tight because the ear reads a loud outlier as the game changing, not as variety. Four wheeks in a row must stay disappointment, never scolding.',
      items: [
        { label: 'placement ×8 — a steady solving hand', dur: 8.0, build: (ctx, bus, t, r) => { for (let i = 0; i < 8; i++) place(ctx, bus, t + i * 0.95, r); } },
        { label: 'placement ×6 — quick fill, 0.45 s apart', dur: 4.0, build: (ctx, bus, t, r) => { for (let i = 0; i < 6; i++) place(ctx, bus, t + i * 0.45, r); } },
        { label: 'step ×10 — the mud alone, level check', dur: 8.0, build: (ctx, bus, t, r) => { for (let i = 0; i < 10; i++) CUES['thud'](ctx, o(bus, 'thud'), t + i * 0.8, null, r); } },
        { label: 'wheek ×4 — four mistakes running', dur: 4.5, build: (ctx, bus, t, r) => { for (let i = 0; i < 4; i++) CUES['slip'](ctx, o(bus, 'slip'), t + i * 1.05, null, r); } },
      ],
    },
    {
      title: 'E · Scenes',
      note: 'The moments that have failed before, at real timing. The finish: the win fires from inside the same handler as the last placement — the pre-roll must put the climb in clear air. The rushed finish stresses that with two fast placements right in front. The loss: the fail must land as an ending now, present and unmissable, while staying on the right side of gentle.',
      items: [
        { label: 'the finish — last placement → the win', dur: 5.0, build: (ctx, bus, t, r) => { place(ctx, bus, t + 1.2, r); CUES['oink'](ctx, o(bus, 'oink'), t + 1.2, null, r); } },
        { label: 'a rushed finish — two fast placements into the win', dur: 5.0, build: (ctx, bus, t, r) => { place(ctx, bus, t + 0.4, r); place(ctx, bus, t + 0.9, r); CUES['oink'](ctx, o(bus, 'oink'), t + 0.9, null, r); } },
        { label: 'the loss — slip, slip, slip → the fail', dur: 7.0, build: (ctx, bus, t, r) => { CUES['slip'](ctx, o(bus, 'slip'), t, null, r); CUES['slip'](ctx, o(bus, 'slip'), t + 1.5, null, r); CUES['slip'](ctx, o(bus, 'slip'), t + 3.0, null, r); CUES['fail'](ctx, o(bus, 'fail'), t + 3.0, null, r); } },
        { label: 'win, then starred — the happy ending in full', dur: 6.0, build: (ctx, bus, t, r) => { place(ctx, bus, t + 0.3, r); CUES['oink'](ctx, o(bus, 'oink'), t + 0.3, null, r); CUES['star'](ctx, o(bus, 'star'), t + 3.6, null, r); } },
      ],
    },
  ];

  global.PACK = { name: P.name, ROOM: P.ROOM, SENDS, CUES, SECTIONS, GAP, TAIL };
})(typeof window !== 'undefined' ? window : globalThis);
