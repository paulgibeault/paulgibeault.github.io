// hecknsic — audition timeline.
//
// Test material: the sections rendered into the audition WAV. Deliberately NOT
// part of the game's shipped pack — players never need the dry/wet comparisons
// or the repetition test. Reads the game's own pack, so the sounds auditioned
// here are literally the sounds the game plays.
//
//   node tools/soundpack/render.mjs hecknsic

(function (global) {
  'use strict';
  const S = global.ArcadeAudioElements;
  const P = global.HecknsicPack;
  const { CUES, SENDS, pulse, tension } = P;

  const GAP = 0.55;   // between items inside a section
  const TAIL = 1.4;   // let the room finish before a section ends

  // Params each cue is auditioned with in section B — representative
  // mid-gameplay values, not extremes (the extremes get their own sections).
  const B_PARAMS = {
    'rotate': { kind: 'cluster' },
    'match': { count: 4 },
    'combo': { depth: 3 },
    'bomb-tick': { urgency: 0.5 },
  };

  const SECTIONS = [
    {
      title: 'A · New elements — the raw ingredients',
      note: 'Three additions to the shared library, heard bare. shatter is the identity gesture of the whole pack; if it reads as wind chimes rather than breakage, everything downstream is wrong. The reversed shatter (skew<1) should sound like CONVERGENCE — glass assembling. The ratchet should read as machined detents, not creak. The drone detune comparison: 5 cents should breathe, 40 should be dread.',
      items: [
        { label: 'shatter — default (breaking)', dur: 1.0, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.25); S.shatter(ctx, o, t, { dur: 0.45, grains: 42, f0: 3200, gain: 0.22, seed: 1001 }); } },
        { label: 'shatter — reversed (skew 0.6, converging)', dur: 1.2, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.25); S.shatter(ctx, o, t, { dur: 0.55, grains: 42, f0: 3600, skew: 0.6, crack: 0, gain: 0.18, seed: 1002 }); } },
        { label: 'ratchet — decelerating (end 2.0), 5 detents', dur: 0.9, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.15); S.ratchet(ctx, o, t, { detents: 5, dur: 0.4, end: 2.0, f: 620, gain: 0.2, seed: 1003 }); } },
        { label: 'ratchet — accelerating (end 0.5), 8 detents', dur: 0.9, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.15); S.ratchet(ctx, o, t, { detents: 8, dur: 0.45, end: 0.5, f: 620, gain: 0.2, seed: 1004 }); } },
        { label: 'drone — 55 Hz, detune 5 (breathing)', dur: 6.0, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.3); S.drone(ctx, o, t, 5.5, { f: 55, detune: 5, lp: 400, gain: 0.16, fade: 1.2 }); } },
        { label: 'drone — 82 Hz, detune 40 (dread)', dur: 6.0, build: (ctx, bus, t, r) => { const o = S.out(bus, 0.3); S.drone(ctx, o, t, 5.5, { f: 82.4, detune: 40, lp: 500, gain: 0.14, fade: 1.2 }); } },
      ],
    },
    {
      title: 'B · Each cue — dry, then in the room',
      note: 'First without reverb, then with. The room is small, hard-surfaced and dark; the second of each pair is what the shared space contributes.',
      items: Object.keys(CUES).flatMap((name) => ([
        { label: name + ' — dry', dur: null, cue: name, params: B_PARAMS[name] || null, send: 0 },
        { label: name + ' — in the room', dur: null, cue: name, params: B_PARAMS[name] || null, send: SENDS[name] },
      ])),
    },
    {
      title: 'C · Repetition — does it fatigue?',
      note: 'The same cue fired eight times. rotate matters most: it fires on every single input, so any repeating tell in it becomes the sound of the game. Then select+rotate together — what every move actually sounds like.',
      items: [
        { label: 'rotate ×8 — cluster', dur: 7.0, build: (ctx, bus, t, r) => { for (let i = 0; i < 8; i++) { const o = S.out(bus, SENDS['rotate']); CUES['rotate'](ctx, o, t + i * 0.8, { kind: 'cluster' }, r); } } },
        { label: 'rotate ×4 — starflower ring (6 detents)', dur: 4.6, build: (ctx, bus, t, r) => { for (let i = 0; i < 4; i++) { const o = S.out(bus, SENDS['rotate']); CUES['rotate'](ctx, o, t + i * 1.05, { kind: 'ring' }, r); } } },
        { label: 'select + rotate ×6 — a full move, six times', dur: 7.5, build: (ctx, bus, t, r) => { for (let i = 0; i < 6; i++) { const at = t + i * 1.15; CUES['select'](ctx, S.out(bus, SENDS['select']), at, null, r); CUES['rotate'](ctx, S.out(bus, SENDS['rotate']), at + 0.35, { kind: 'cluster' }, r); } } },
        { label: 'match ×8', dur: 5.5, build: (ctx, bus, t, r) => { for (let i = 0; i < 8; i++) { const o = S.out(bus, SENDS['match']); CUES['match'](ctx, o, t + i * 0.6, { count: 3 }, r); } } },
        { label: 'bomb-tick ×8 — urgency rising 0 → 1', dur: 6.5, build: (ctx, bus, t, r) => { for (let i = 0; i < 8; i++) { const o = S.out(bus, SENDS['bomb-tick']); CUES['bomb-tick'](ctx, o, t + i * 0.75, { urgency: i / 7 }, r); } } },
        { label: 'ui-click ×8', dur: 3.0, build: (ctx, bus, t, r) => { for (let i = 0; i < 8; i++) { const o = S.out(bus, SENDS['ui-click']); CUES['ui-click'](ctx, o, t + i * 0.32, null, r); } } },
      ],
    },
    {
      title: 'D · Scaling — cluster size and chain depth',
      note: 'match at 3, 4, 6, 8, 10 tiles: bigger should read as a BIGGER fracture (more shards, longer, deeper), not merely louder. Then the combo ladder, depth 1→6: a staircase going up, brightening as it climbs.',
      items: [
        { label: 'match 3 → 4 → 6 → 8 → 10', dur: 6.5, build: (ctx, bus, t, r) => { [3, 4, 6, 8, 10].forEach((c, i) => { const o = S.out(bus, SENDS['match']); CUES['match'](ctx, o, t + i * 1.1, { count: c }, r); }); } },
        { label: 'combo ladder — depth 1 → 6', dur: 5.5, build: (ctx, bus, t, r) => { for (let d = 1; d <= 6; d++) { const o = S.out(bus, SENDS['combo']); CUES['combo'](ctx, o, t + (d - 1) * 0.7, { depth: d }, r); } } },
        { label: 'a full cascade — match, then combos 1→4, shards overlapping', dur: 4.5, build: (ctx, bus, t, r) => { CUES['match'](ctx, S.out(bus, SENDS['match']), t, { count: 5 }, r); for (let d = 1; d <= 4; d++) CUES['combo'](ctx, S.out(bus, SENDS['combo']), t + 0.45 + (d - 1) * 0.42, { depth: d }, r); } },
      ],
    },
    {
      title: 'E · The bomb — its whole life',
      note: 'Arrival (impact, fuse catching, the beating dread pair), the tick tightening move by move, then both endings: defused inside an ordinary match, or the full detonation with the board’s glass blowing out behind it, followed by the aftermath tolls.',
      items: [
        {
          label: 'arrive → 5 ticks (urgency 0 → 1) → defused by a match', dur: 9.5,
          build: (ctx, bus, t, r) => {
            CUES['bomb-arrive'](ctx, S.out(bus, SENDS['bomb-arrive']), t, null, r);
            for (let i = 0; i < 5; i++) CUES['bomb-tick'](ctx, S.out(bus, SENDS['bomb-tick']), t + 2.4 + i * 1.0, { urgency: i / 4 }, r);
            CUES['match'](ctx, S.out(bus, SENDS['match']), t + 7.8, { count: 4 }, r);
          },
        },
        {
          label: 'arrive → 3 ticks → DETONATION → aftermath', dur: 13.0,
          build: (ctx, bus, t, r) => {
            CUES['bomb-arrive'](ctx, S.out(bus, SENDS['bomb-arrive']), t, null, r);
            for (let i = 0; i < 3; i++) CUES['bomb-tick'](ctx, S.out(bus, SENDS['bomb-tick']), t + 2.4 + i * 0.9, { urgency: 0.4 + 0.3 * i }, r);
            CUES['bomb-explode'](ctx, S.out(bus, SENDS['bomb-explode']), t + 5.6, null, r);
            CUES['game-over'](ctx, S.out(bus, SENDS['game-over']), t + 6.4, null, r);
          },
        },
      ],
    },
    {
      title: 'F · The formation ladder',
      note: 'starflower → black pearl → grand poobah, in order of rarity. One family of gesture — glass converging instead of breaking — in three materials: chrome shimmer, obsidian weight, then both at once. The pair starflower/blackpearl should read as opposites: one ascends into light, the other descends into mass.',
      items: [
        { label: 'starflower — chrome', dur: null, cue: 'starflower', send: SENDS['starflower'] },
        { label: 'black pearl — obsidian', dur: null, cue: 'blackpearl', send: SENDS['blackpearl'] },
        { label: 'grand poobah — both', dur: null, cue: 'grandpoobah', send: SENDS['grandpoobah'] },
        { label: 'over-achiever — the triumph', dur: null, cue: 'over-achiever', send: SENDS['over-achiever'] },
      ],
    },
    {
      title: 'G · The floor — pulse and tension',
      note: 'The environmental layer. The pulse is a breathing sub heartbeat, deliberately NOT metrical — no tempo for the player’s pacing to fight. Judge it at the edge of attention: it should be felt in the floor, not listened to. The tension layer answers the bomb: beating drone plus a dry subdividing tick, both tightening with urgency. It retunes live without restarting the pulse.',
      items: [
        { label: 'pulse alone — calm (intensity 0.25)', dur: 18.0, build: (ctx, bus, t, r) => { pulse(ctx, S.out(bus, 0.3), t, { dur: 17.0, intensity: 0.25 }, r); } },
        { label: 'pulse — arcade (intensity 0.6)', dur: 14.0, build: (ctx, bus, t, r) => { pulse(ctx, S.out(bus, 0.3), t, { dur: 13.0, intensity: 0.6 }, r); } },
        {
          label: 'pulse + tension at urgency 0.85 — a bomb nearly out', dur: 14.0,
          build: (ctx, bus, t, r) => {
            pulse(ctx, S.out(bus, 0.3), t, { dur: 13.0, intensity: 0.6 }, r);
            tension(ctx, S.out(bus, 0.35), t, { dur: 13.0, urgency: 0.85 }, r);
          },
        },
        {
          label: 'the floor + gameplay — what a tense minute sounds like', dur: 16.0,
          build: (ctx, bus, t, r) => {
            pulse(ctx, S.out(bus, 0.3), t, { dur: 15.0, intensity: 0.6 }, r);
            tension(ctx, S.out(bus, 0.35), t, { dur: 15.0, urgency: 0.6 }, r);
            CUES['select'](ctx, S.out(bus, SENDS['select']), t + 1.2, null, r);
            CUES['rotate'](ctx, S.out(bus, SENDS['rotate']), t + 1.6, { kind: 'cluster' }, r);
            CUES['match'](ctx, S.out(bus, SENDS['match']), t + 2.3, { count: 4 }, r);
            CUES['combo'](ctx, S.out(bus, SENDS['combo']), t + 2.9, { depth: 1 }, r);
            CUES['bomb-tick'](ctx, S.out(bus, SENDS['bomb-tick']), t + 4.1, { urgency: 0.6 }, r);
            CUES['select'](ctx, S.out(bus, SENDS['select']), t + 5.4, null, r);
            CUES['rotate'](ctx, S.out(bus, SENDS['rotate']), t + 5.8, { kind: 'cluster' }, r);
            CUES['match'](ctx, S.out(bus, SENDS['match']), t + 6.6, { count: 6 }, r);
            CUES['starflower'](ctx, S.out(bus, SENDS['starflower']), t + 7.4, null, r);
            CUES['bomb-tick'](ctx, S.out(bus, SENDS['bomb-tick']), t + 9.4, { urgency: 0.8 }, r);
            CUES['select'](ctx, S.out(bus, SENDS['select']), t + 10.6, null, r);
            CUES['rotate'](ctx, S.out(bus, SENDS['rotate']), t + 11.0, { kind: 'ring' }, r);
            CUES['match'](ctx, S.out(bus, SENDS['match']), t + 11.9, { count: 5 }, r);
          },
        },
      ],
    },
    {
      title: 'H · Landmarks',
      note: 'The session-ending moments, in full, over the floor they will actually play against.',
      items: [
        { label: 'game-win — puzzle solved', dur: null, cue: 'game-win', send: SENDS['game-win'] },
        { label: 'game-over — alone (chill session end)', dur: null, cue: 'game-over', send: SENDS['game-over'] },
      ],
    },
  ];

  global.PACK = { name: P.name, ROOM: P.ROOM, SENDS, CUES, SECTIONS, GAP, TAIL };
})(typeof window !== 'undefined' ? window : globalThis);
