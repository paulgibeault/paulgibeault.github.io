// sow-duku — audition timeline.
//
// Test material: the sections rendered into the audition WAV. Deliberately NOT
// part of the game's shipped pack — players never need the dry/wet comparisons
// or the repetition test. Reads the game's own pack, so the sounds auditioned
// here are literally the sounds the game plays.
//
//   node tools/soundpack/render.mjs sow-duku
//
(function (global) {
  'use strict';
  const S = global.ArcadeAudioElements;
  const P = global.SowDukuPack;
  const { CUES, SENDS } = P;

  const GAP = 0.55;   // between items inside a section
  const TAIL = 1.4;   // let the yard finish before a section ends

  const SECTIONS = [
    {
      title: 'A · New elements — the raw ingredients',
      note: 'Three additions to the shared library, heard bare. squelch is the identity gesture of the whole pack; if it reads as electrical crackle rather than wet mud, everything downstream is wrong. The reversed squelch (skew 0.6) should sound like RELEASE — a foot pulling out. breath out vs in should read as exhale vs sniff, and the flutter comparison shows why turbulence matters: flutter 0 is cloth, not a creature. The grunt must read as a small animal with opinions, never as a synth bass note.',
      items: [
        { label: 'squelch — default (a landing)', dur: 0.8, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.2); S.squelch(ctx, o, t, { dur: 0.14, f0: 250, gain: 0.22, seed: 2001 }); } },
        { label: 'squelch — reversed (skew 0.6, a lift-out)', dur: 0.8, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.2); S.squelch(ctx, o, t, { dur: 0.12, f0: 220, skew: 0.6, gain: 0.2, seed: 2002 }); } },
        { label: 'breath — out (exhale)', dur: 0.9, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.22); S.breath(ctx, o, t, { dur: 0.35, f: 500, gain: 0.18, seed: 2003 }); } },
        { label: 'breath — in (sniff)', dur: 0.9, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.22); S.breath(ctx, o, t, { dur: 0.3, f: 560, dir: 'in', gain: 0.18, seed: 2004 }); } },
        { label: 'breath — flutter 0 (the cloth control)', dur: 0.9, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.22); S.breath(ctx, o, t, { dur: 0.35, f: 500, flutter: 0, gain: 0.18, seed: 2005 }); } },
        { label: 'grunt — default piggy', dur: 0.8, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.2); S.grunt(ctx, o, t, { f0: 110, dur: 0.2, gain: 0.2, seed: 2006 }); } },
        { label: 'grunt — long sagging (the sigh voice)', dur: 1.2, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.2); S.grunt(ctx, o, t, { f0: 120, f1: 76, dur: 0.5, rough: 0.8, breathy: 0.5, attack: 0.1, gain: 0.18, seed: 2007 }); } },
      ],
    },
    {
      title: 'B · Each cue — dry, then in the room',
      note: 'First without reverb, then with — the "room" here is the open yard over soft ground. Its contribution should be barely more than a sense that the sound happened OUTSIDE, never a tail you could point to.',
      items: Object.keys(CUES).flatMap((name) => ([
        { label: name + ' — dry', dur: null, cue: name, send: 0 },
        { label: name + ' — in the room', dur: null, cue: name, send: SENDS[name] },
      ])),
    },
    {
      title: 'C · Repetition — does it fatigue?',
      note: 'The same cue fired eight times. thud matters most: it fires on every placement, so any repeating tell in it becomes the sound of the game. Listen for two splats landing identically — that is the failure. slip ×4 checks that being wrong four times in a row stays disappointment and never turns into punishment.',
      items: [
        { label: 'thud ×8 — a steady solving hand', dur: 8.0, build: (ctx, bus, t, r) => { for (let i = 0; i < 8; i++) { const o = S.out(bus, SENDS['thud']); CUES['thud'](ctx, o, t + i * 0.95, null, r); } } },
        { label: 'thud ×5 — quick fill, 0.45s apart', dur: 4.0, build: (ctx, bus, t, r) => { for (let i = 0; i < 5; i++) { const o = S.out(bus, SENDS['thud']); CUES['thud'](ctx, o, t + i * 0.45, null, r); } } },
        { label: 'slip ×4', dur: 4.5, build: (ctx, bus, t, r) => { for (let i = 0; i < 4; i++) { const o = S.out(bus, SENDS['slip']); CUES['slip'](ctx, o, t + i * 1.05, null, r); } } },
      ],
    },
    {
      title: 'D · A solving run — the real cadence',
      note: 'What a good minute actually sounds like: placements at thinking pace, a pen closing, more placements, the last pen, and the piggy’s verdict on the whole field. The chime has to read as a clear, separate moment once the thuds have decayed — that was the original complaint about the spec cues. Then the same finish rushed, thud into chime into snuffle almost on top of each other, to check the overlap fuses in the shared yard instead of piling up.',
      items: [
        {
          label: 'thud, thud, thud → chime … thud, thud → chime → snuffle', dur: 12.0,
          build: (ctx, bus, t, r) => {
            const th = (at) => CUES['thud'](ctx, S.out(bus, SENDS['thud']), at, null, r);
            th(t); th(t + 1.3); th(t + 2.2);
            CUES['chime'](ctx, S.out(bus, SENDS['chime']), t + 3.0, null, r);
            th(t + 4.9); th(t + 6.0);
            CUES['chime'](ctx, S.out(bus, SENDS['chime']), t + 6.8, null, r);
            CUES['snuffle'](ctx, S.out(bus, SENDS['snuffle']), t + 8.3, null, r);
          },
        },
        {
          label: 'the rushed finish — thud → chime → snuffle, tight', dur: 4.5,
          build: (ctx, bus, t, r) => {
            CUES['thud'](ctx, S.out(bus, SENDS['thud']), t, null, r);
            CUES['chime'](ctx, S.out(bus, SENDS['chime']), t + 0.3, null, r);
            CUES['snuffle'](ctx, S.out(bus, SENDS['snuffle']), t + 1.2, null, r);
          },
        },
        {
          label: 'a slip inside a run — thud, slip, thud → chime', dur: 7.0,
          build: (ctx, bus, t, r) => {
            CUES['thud'](ctx, S.out(bus, SENDS['thud']), t, null, r);
            CUES['slip'](ctx, S.out(bus, SENDS['slip']), t + 1.4, null, r);
            CUES['thud'](ctx, S.out(bus, SENDS['thud']), t + 3.1, null, r);
            CUES['chime'](ctx, S.out(bus, SENDS['chime']), t + 4.0, null, r);
          },
        },
      ],
    },
    {
      title: 'E · The gentle end',
      note: 'Two slips and then the hearts run out. The fail is a nap, not a death: a long exhale with the sag voiced inside it, the body settling into the straw, one last small breath. If it lands as a fanfare — even a sad one — it is overwritten. It should make you want to try again, softly.',
      items: [
        {
          label: 'slip, slip → fail', dur: 6.5,
          build: (ctx, bus, t, r) => {
            CUES['slip'](ctx, S.out(bus, SENDS['slip']), t, null, r);
            CUES['slip'](ctx, S.out(bus, SENDS['slip']), t + 1.5, null, r);
            CUES['fail'](ctx, S.out(bus, SENDS['fail']), t + 3.2, null, r);
          },
        },
        { label: 'fail — alone', dur: null, cue: 'fail', send: SENDS['fail'] },
      ],
    },
  ];

  global.PACK = { name: P.name, ROOM: P.ROOM, SENDS, CUES, SECTIONS, GAP, TAIL };
})(typeof window !== 'undefined' ? window : globalThis);
