// moon-lit — audition timeline.
//
// Test material: the sections rendered into the audition WAV. Deliberately NOT
// part of the game's shipped pack — players never need the dry/wet comparisons
// or the repetition test. Reads the game's own pack, so the sounds auditioned
// here are literally the sounds the game plays.
//
//   node tools/soundpack/render.mjs moon-lit

(function (global) {
  'use strict';
  const S = global.ArcadeAudioElements;
  const P = global.MoonLitPack;
  const { CUES, SENDS, ambient, insects } = P;

  const GAP = 0.55;   // between items inside a section
  const TAIL = 1.4;   // let the room finish before a section ends

  // Test material for the `body` element demo below. The pack's own cues no
  // longer include a struck chime, but the element still needs auditioning, and
  // an inharmonic bar series is the clearest way to hear what it does.
  const BAR = [
    { ratio: 1.000, gain: 1.00, decay: 0.85, detune: 2 },
    { ratio: 2.756, gain: 0.45, decay: 0.42, detune: 4 },
    { ratio: 5.404, gain: 0.22, decay: 0.20, detune: 5 },
    { ratio: 8.933, gain: 0.09, decay: 0.11, detune: 6 },
  ];

  const SECTIONS = [
    {
      title: 'A · Elements — the raw ingredients',
      note: 'Each is a physical gesture, not a waveform. If one is wrong here, every cue built on it is wrong.',
      items: [
        { label: 'strike — the contact click', dur: 0.4, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.18); S.strike(ctx, o, t, { dur: 0.006, hp: 2200, gain: 0.34 }); } },
        { label: 'rustle — friction, swept', dur: 0.75, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.2); S.rustle(ctx, o, t, { f0: 900, f1: 2600, dur: 0.5, gain: 0.3 }); } },
        { label: 'pluck — Karplus–Strong string', dur: 2.0, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.22); S.pluck(ctx, o, t, { freq: 330, dur: 1.8, gain: 0.34 }); } },
        { label: 'creak — stick-slip friction', dur: 1.0, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.2); S.creak(ctx, o, t, { f0: 250, f1: 170, Q: 7.5, dur: 0.7, gain: 0.34 }); } },
        { label: 'droplet — upward sweep', dur: 0.5, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.4); S.droplet(ctx, o, t, { f0: 320, f1: 1500, dur: 0.05, gain: 0.3 }); } },
        { label: 'body — inharmonic partials', dur: 1.6, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.25); S.body(ctx, o, t, { f0: 523.25, gain: 0.3, partials: BAR }); } },
        { label: 'thump — low impact', dur: 0.9, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.2); S.thump(ctx, o, t, { f0: 110, f1: 45, dur: 0.4, gain: 0.4 }); } },
      ],
    },
    {
      title: 'B · Each cue — dry, then in the room',
      note: 'First without reverb, then with. The second is what the shared space contributes; it is why overlaid cues fuse rather than stack.',
      items: Object.keys(CUES).flatMap((name) => ([
        { label: name + ' — dry', dur: null, cue: name, send: 0 },
        { label: name + ' — in the room', dur: null, cue: name, send: SENDS[name] },
      ])),
    },
    {
      title: 'C · Repetition — does it fatigue?',
      note: 'The same cue fired eight times. On the old engine every play was byte-identical; here pitch, strike position and decay all vary per play. The carousel matters most: it turns on every single shot, so any repeating tell in it becomes the sound of the game.',
      items: [
        { label: 'carousel ×8 — the wheel turning, shot after shot', dur: 9.0, build: (ctx, bus, t, r) => { for (let i = 0; i < 8; i++) { const o = S.out(bus, SENDS['carousel']); CUES['carousel'](ctx, o, t + i * 1.05, null, r); } } },
        { label: 'launch + carousel ×6 — what every shot actually sounds like', dur: 8.0, build: (ctx, bus, t, r) => { for (let i = 0; i < 6; i++) { const at = t + i * 1.25; CUES['lantern-launch'](ctx, S.out(bus, SENDS['lantern-launch']), at, null, r); CUES['carousel'](ctx, S.out(bus, SENDS['carousel']), at, null, r); } } },
        { label: 'match ×8', dur: 5.0, build: (ctx, bus, t, r) => { for (let i = 0; i < 8; i++) { const o = S.out(bus, SENDS['match']); CUES['match'](ctx, o, t + i * 0.55, { count: 3 }, r); } } },
        { label: 'drop ×8', dur: 4.2, build: (ctx, bus, t, r) => { for (let i = 0; i < 8; i++) { const o = S.out(bus, SENDS['drop']); CUES['drop'](ctx, o, t + i * 0.45, null, r); } } },
        { label: 'menu-click ×8', dur: 3.0, build: (ctx, bus, t, r) => { for (let i = 0; i < 8; i++) { const o = S.out(bus, SENDS['menu-click']); CUES['menu-click'](ctx, o, t + i * 0.32, null, r); } } },
      ],
    },
    {
      title: 'D · The burn, by cluster size',
      note: 'match at cluster size 3, 4, 6, 8 — one flare per lamp catching, each bigger and a shade brighter than the last. Deliberately soft: it repeats several times a minute for a whole level. The question is whether 8 reads as a bigger fire rather than just a louder sound.',
      items: [
        { label: 'match 3 → 4 → 6 → 8', dur: 4.4, build: (ctx, bus, t, r) => { [3, 4, 6, 8].forEach((c, i) => { const o = S.out(bus, SENDS['match']); CUES['match'](ctx, o, t + i * 0.9, { count: c }, r); }); } },
      ],
    },
    {
      title: 'E · Combinations — cues overlapping as they actually fire',
      note: 'This is the real test. Series and combination, at gameplay density.',
      items: [
        {
          label: 'a modest clear', dur: 3.4,
          build: (ctx, bus, t, r) => {
            CUES['lantern-launch'](ctx, S.out(bus, SENDS['lantern-launch']), t, null, r);
            CUES['carousel'](ctx, S.out(bus, SENDS['carousel']), t, null, r);
            CUES['match'](ctx, S.out(bus, SENDS['match']), t + 0.42, { count: 3 }, r);
            CUES['drop'](ctx, S.out(bus, SENDS['drop']), t + 0.66, null, r);
            CUES['drop'](ctx, S.out(bus, SENDS['drop']), t + 0.79, null, r);
            CUES['menu-click'](ctx, S.out(bus, SENDS['menu-click']), t + 1.7, null, r);
          },
        },
        {
          label: 'a cascade', dur: 4.6,
          build: (ctx, bus, t, r) => {
            CUES['lantern-launch'](ctx, S.out(bus, SENDS['lantern-launch']), t, null, r);
            [3, 4, 5, 6].forEach((c, i) => CUES['match'](ctx, S.out(bus, SENDS['match']), t + 0.4 + i * 0.30, { count: c }, r));
            for (let i = 0; i < 7; i++) CUES['drop'](ctx, S.out(bus, SENDS['drop']), t + 0.62 + i * 0.14 + r() * 0.06, null, r);
            CUES['trellis'](ctx, S.out(bus, SENDS['trellis']), t + 2.1, null, r);
          },
        },
        {
          label: 'a moonburst', dur: 5.0,
          build: (ctx, bus, t, r) => {
            CUES['lantern-launch'](ctx, S.out(bus, SENDS['lantern-launch']), t, null, r);
            CUES['moonburst'](ctx, S.out(bus, SENDS['moonburst']), t + 0.95, null, r);
            for (let i = 0; i < 9; i++) CUES['drop'](ctx, S.out(bus, SENDS['drop']), t + 1.5 + i * 0.13 + r() * 0.07, null, r);
          },
        },
        {
          label: 'under pressure', dur: 4.4,
          build: (ctx, bus, t, r) => {
            CUES['trellis'](ctx, S.out(bus, SENDS['trellis']), t, null, r);
            CUES['dead-line-warning'](ctx, S.out(bus, SENDS['dead-line-warning']), t + 0.95, null, r);
            CUES['lantern-launch'](ctx, S.out(bus, SENDS['lantern-launch']), t + 1.9, null, r);
            CUES['match'](ctx, S.out(bus, SENDS['match']), t + 2.3, { count: 3 }, r);
            CUES['drop'](ctx, S.out(bus, SENDS['drop']), t + 2.55, null, r);
            CUES['drop'](ctx, S.out(bus, SENDS['drop']), t + 2.68, null, r);
          },
        },
      ],
    },
    {
      title: 'F · Landmarks',
      note: 'The two moments that carry the emotional weight, in full.',
      items: [
        { label: 'win — the temple bell', dur: null, cue: 'win', send: SENDS['win'] },
        { label: 'game-over — koto', dur: null, cue: 'game-over', send: SENDS['game-over'] },
      ],
    },
    {
      title: 'G · The ambient bed',
      note: 'A quiet pond on a summer night. There is NO continuous layer — no water hiss, no air, nothing sustained at all; still water makes no sound, and filtered noise always ends up heard as wind. The bed is discrete events over silence: a ruffle in the reeds every 15-30s, and insects. Judge the empty stretches: they are the ambience, not a gap in it.',
      items: [
        { label: 'the pond alone — silence, and a ruffle in the reeds', dur: 42.0, build: (ctx, bus, t, r) => { ambient(ctx, S.out(bus, 0.45), t, { dur: 41.0 }, r); } },
        {
          label: 'pond + insects, calm (heat 0)', dur: 26.0,
          build: (ctx, bus, t, r) => {
            ambient(ctx, S.out(bus, 0.45), t, { dur: 25.0 }, r);
            insects(ctx, S.out(bus, 0.55), t, { dur: 25.0, heat: 0 }, r);
          },
        },
        {
          label: 'pond + insects, endgame (heat 1)', dur: 26.0,
          build: (ctx, bus, t, r) => {
            ambient(ctx, S.out(bus, 0.45), t, { dur: 25.0 }, r);
            insects(ctx, S.out(bus, 0.55), t, { dur: 25.0, heat: 1 }, r);
          },
        },
        {
          label: 'the pressure crossfade — heat 0 → 1 at 6s', dur: 20.0,
          build: (ctx, bus, t, r) => {
            ambient(ctx, S.out(bus, 0.45), t, { dur: 19.0 }, r);
            // What sfx.js does live: a second insect layer starts and the first
            // is faded out under it. The water is never restarted.
            const calm = S.out(bus, 0.55);
            insects(ctx, calm, t, { dur: 19.0, heat: 0 }, r);
            calm.gain.setValueAtTime(1, t + 6.0);
            calm.gain.exponentialRampToValueAtTime(0.0001, t + 9.0);
            insects(ctx, S.out(bus, 0.55), t + 6.0, { dur: 13.0, heat: 1 }, r);
          },
        },
        {
          label: 'bed + gameplay', dur: 15.0,
          build: (ctx, bus, t, r) => {
            ambient(ctx, S.out(bus, 0.45), t, { dur: 14.0 }, r);
            insects(ctx, S.out(bus, 0.55), t, { dur: 14.0, heat: 0.7 }, r);
            CUES['lantern-launch'](ctx, S.out(bus, SENDS['lantern-launch']), t + 1.6, null, r);
            [3, 4, 5].forEach((c, i) => CUES['match'](ctx, S.out(bus, SENDS['match']), t + 2.1 + i * 0.34, { count: c }, r));
            for (let i = 0; i < 5; i++) CUES['drop'](ctx, S.out(bus, SENDS['drop']), t + 2.4 + i * 0.16, null, r);
            CUES['trellis'](ctx, S.out(bus, SENDS['trellis']), t + 4.2, null, r);
            CUES['lantern-launch'](ctx, S.out(bus, SENDS['lantern-launch']), t + 5.6, null, r);
            CUES['match'](ctx, S.out(bus, SENDS['match']), t + 6.0, { count: 6 }, r);
            CUES['dead-line-warning'](ctx, S.out(bus, SENDS['dead-line-warning']), t + 7.4, null, r);
            CUES['win'](ctx, S.out(bus, SENDS['win']), t + 9.0, null, r);
          },
        },
      ],
    },
  ];

  global.PACK = { name: P.name, ROOM: P.ROOM, SENDS, CUES, SECTIONS, GAP, TAIL };
})(typeof window !== 'undefined' ? window : globalThis);
