// cozy-solitaire — the full audition. The proving timeline.
//
//   node tools/soundpack/render.mjs cozy-solitaire --version v1
//
// This is the diagnostic file: confusable pairs A/B'd, the rank ladder laid
// out card by card, run sizes swept, every cue dry and then in the room,
// repetition runs at real game density, and finally scenes at real pace.
// `cozy-solitaire-short.js` is the one to LISTEN to first — this is where a
// specific complaint gets located.
//
(function (global) {
  'use strict';
  const S = global.ArcadeAudioElements;
  const P = global.CozySolitairePack;
  const { CUES, SENDS } = P;

  const GAP = 1.0;
  const TAIL = 1.6;

  const o = (bus, name) => S.out(bus, SENDS[name]);
  const fire = (ctx, bus, name, at, r, params) =>
    CUES[name](ctx, o(bus, name), at, params || null, r);

  // The paced auto-complete tick, from constants.js — the fastest repetition
  // the game can actually produce.
  const CASCADE = 0.10;

  const SECTIONS = [
    {
      title: 'A · Grammar — the pairs that must not blur',
      note: 'Each pair alternates twice, then each half alone. 1) A card landing versus a card being turned up: same table, different gesture — the flip has no weight under it and steps UP at the end. 2) A landing on a pile versus a landing on a foundation: identical except the foundation rings its rank on top. 3) Refused versus no-passes-left: both fall, both are dull, but the second drops much further and takes its time — these two have to be tellable apart without looking. 4) The plurality ladder: one card, a run of four, the waste turning over, a new deal — increasing numbers of the same material.',
      items: [
        { label: 'place · flip · place · flip', dur: 2.6, build: (ctx, b, t, r) => {
          fire(ctx, b, 'place', t, r); fire(ctx, b, 'flip', t + 0.62, r);
          fire(ctx, b, 'place', t + 1.24, r); fire(ctx, b, 'flip', t + 1.86, r);
        } },
        { label: 'place alone', dur: null, cue: 'place', send: SENDS['place'] },
        { label: 'flip alone', dur: null, cue: 'flip', send: SENDS['flip'] },
        { label: 'place · foundation · place · foundation (7♦)', dur: 2.6, build: (ctx, b, t, r) => {
          fire(ctx, b, 'place', t, r); fire(ctx, b, 'foundation', t + 0.62, r, { rank: 7 });
          fire(ctx, b, 'place', t + 1.24, r); fire(ctx, b, 'foundation', t + 1.86, r, { rank: 7 });
        } },
        { label: 'invalid · pass-limit · invalid · pass-limit', dur: 3.4, build: (ctx, b, t, r) => {
          fire(ctx, b, 'invalid', t, r); fire(ctx, b, 'pass-limit', t + 0.85, r);
          fire(ctx, b, 'invalid', t + 1.85, r); fire(ctx, b, 'pass-limit', t + 2.5, r);
        } },
        { label: 'invalid alone — "not there"', dur: null, cue: 'invalid', send: SENDS['invalid'] },
        { label: 'pass-limit alone — "not any more"', dur: null, cue: 'pass-limit', send: SENDS['pass-limit'] },
        { label: 'plurality: place → run of 4 → recycle → deal', dur: 5.2, build: (ctx, b, t, r) => {
          fire(ctx, b, 'place', t, r);
          fire(ctx, b, 'run-place', t + 0.9, r, { count: 4 });
          fire(ctx, b, 'recycle', t + 2.1, r);
          fire(ctx, b, 'deal', t + 3.4, r);
        } },
        { label: 'lift — a corner peeling off felt (the smallest thing here)', dur: null, cue: 'lift', send: SENDS['lift'] },
        { label: 'undo — the pitched exception, against a place either side', dur: 2.2, build: (ctx, b, t, r) => {
          fire(ctx, b, 'place', t, r); fire(ctx, b, 'undo', t + 0.7, r);
          fire(ctx, b, 'place', t + 1.5, r);
        } },
      ],
    },
    {
      title: 'B · The ladder — ace to king',
      note: 'A foundation landing rings its rank: the felt ring climbs about an octave from ace to king. This is material pitch, not melody — the band the card rings in, not a note it plays — so the game stays unpitched while the foundations audibly climb all game. First all thirteen at reading pace so the span is clear, then the same thirteen at real cascade pace (one every 100 ms, which is what the auto-complete does), then four suits back to back — the full end-of-game staircase.',
      items: [
        { label: 'A · 2 · 3 · 4 · 5 · 6 · 7 · 8 · 9 · 10 · J · Q · K, slow', dur: 5.0, build: (ctx, b, t, r) => {
          for (let i = 0; i < 13; i++) fire(ctx, b, 'foundation', t + i * 0.36, r, { rank: i + 1 });
        } },
        { label: 'the same thirteen at cascade pace', dur: 2.2, build: (ctx, b, t, r) => {
          for (let i = 0; i < 13; i++) fire(ctx, b, 'auto-place', t + i * CASCADE, r, { rank: i + 1 });
        } },
        { label: 'the whole auto-complete — four suits, 52 cards', dur: 6.4, build: (ctx, b, t, r) => {
          for (let s = 0; s < 4; s++) {
            for (let i = 0; i < 13; i++) {
              fire(ctx, b, 'auto-place', t + (s * 13 + i) * CASCADE, r, { rank: i + 1 });
            }
          }
        } },
      ],
    },
    {
      title: 'C · Run scaling — two cards to a full spider sequence',
      note: 'A run lands as a short packet of sheets and then one landing. `count` is capped at eight on purpose: a twelve-card run and an eight-card one should differ in weight, not turn into a drum roll. Listen for whether four reads as bigger than two without reading as louder. The last item is the spider sequence — thirteen cards completing, the whole ladder underneath them, the packet landing home. That moment had no sound at all before this pack.',
      items: [
        { label: 'run of 2', dur: 1.0, build: (ctx, b, t, r) => fire(ctx, b, 'run-place', t, r, { count: 2 }) },
        { label: 'run of 4', dur: 1.0, build: (ctx, b, t, r) => fire(ctx, b, 'run-place', t, r, { count: 4 }) },
        { label: 'run of 7', dur: 1.1, build: (ctx, b, t, r) => fire(ctx, b, 'run-place', t, r, { count: 7 }) },
        { label: 'run of 12 (spider maximum — capped at 8 sheets)', dur: 1.1, build: (ctx, b, t, r) => fire(ctx, b, 'run-place', t, r, { count: 12 }) },
        { label: 'a freecell supermove — 5 cards, (1 free + 1) × 2^1 + slack', dur: 1.1, build: (ctx, b, t, r) => fire(ctx, b, 'run-place', t, r, { count: 5 }) },
        { label: 'SEQUENCE — a spider run completes, ace to king', dur: null, cue: 'sequence', send: SENDS['sequence'] },
      ],
    },
    {
      title: 'D · Dry, then in the room',
      note: 'Each cue with no room at all, then at the send it actually ships with. The room should read as "a small warm panelled room" and never as a tail you could point to — if you can hear the reverb as an effect rather than as a place, it is too wet.',
      items: [
        { label: 'place — dry', dur: null, cue: 'place', send: 0 },
        { label: 'place — in the room', dur: null, cue: 'place', send: SENDS['place'] },
        { label: 'flip — dry', dur: null, cue: 'flip', send: 0 },
        { label: 'flip — in the room', dur: null, cue: 'flip', send: SENDS['flip'] },
        { label: 'foundation (K) — dry', dur: null, cue: 'foundation', send: 0, params: { rank: 13 } },
        { label: 'foundation (K) — in the room', dur: null, cue: 'foundation', send: SENDS['foundation'], params: { rank: 13 } },
        { label: 'invalid — dry', dur: null, cue: 'invalid', send: 0 },
        { label: 'invalid — in the room', dur: null, cue: 'invalid', send: SENDS['invalid'] },
        { label: 'recycle — dry', dur: null, cue: 'recycle', send: 0 },
        { label: 'recycle — in the room', dur: null, cue: 'recycle', send: SENDS['recycle'] },
        { label: 'deal — dry', dur: null, cue: 'deal', send: 0 },
        { label: 'deal — in the room', dur: null, cue: 'deal', send: SENDS['deal'] },
        { label: 'undo — dry', dur: null, cue: 'undo', send: 0 },
        { label: 'undo — in the room', dur: null, cue: 'undo', send: SENDS['undo'] },
        { label: 'win — dry', dur: null, cue: 'win', send: 0 },
        { label: 'win — in the room', dur: null, cue: 'win', send: SENDS['win'] },
      ],
    },
    {
      title: 'E · Repetition — level fatigue at real density',
      note: 'The rule this pack inherits: a cue may vary its pitch, timing and content per play but never its LEVEL, because the ear reads any loud outlier as the game changing volume. These runs are where that gets proved. Twelve placements at solving pace, then eight flips, then the cascade flat out, then six refusals at frustrated-tapping speed. Nothing here should stick out, and the refusals should still feel like disappointment on the sixth one.',
      items: [
        { label: 'place ×12 at solving pace', dur: 4.4, build: (ctx, b, t, r) => {
          for (let i = 0; i < 12; i++) fire(ctx, b, 'place', t + i * 0.34, r);
        } },
        { label: 'flip ×8', dur: 3.0, build: (ctx, b, t, r) => {
          for (let i = 0; i < 8; i++) fire(ctx, b, 'flip', t + i * 0.34, r);
        } },
        { label: 'auto-place ×20 flat out (100 ms apart)', dur: 2.8, build: (ctx, b, t, r) => {
          for (let i = 0; i < 20; i++) fire(ctx, b, 'auto-place', t + i * CASCADE, r, { rank: (i % 13) + 1 });
        } },
        { label: 'invalid ×6 — frustrated tapping', dur: 2.4, build: (ctx, b, t, r) => {
          for (let i = 0; i < 6; i++) fire(ctx, b, 'invalid', t + i * 0.33, r);
        } },
        { label: 'lift ×6 — aborted drags', dur: 2.2, build: (ctx, b, t, r) => {
          for (let i = 0; i < 6; i++) fire(ctx, b, 'lift', t + i * 0.3, r);
        } },
      ],
    },
    {
      title: 'F · Scenes — real pace',
      note: 'Where overlap actually gets judged. Four hands. Listen for the two things that break in real play: whether the win still arrives in clear air when it fires from inside the same handler as the last placement (it waits 450 ms for exactly this reason), and whether the layers stay separate when a lift, a place and a foundation ring land within a second of each other.',
      items: [
        {
          label: 'a quick klondike — deal, play, one recycle, the last card, the win',
          dur: 19.0,
          build: (ctx, b, t, r) => {
            fire(ctx, b, 'deal', t + 0.2, r);
            fire(ctx, b, 'lift', t + 1.9, r);
            fire(ctx, b, 'place', t + 2.2, r);
            fire(ctx, b, 'flip', t + 2.45, r);              // the pile underneath turns up
            fire(ctx, b, 'place', t + 3.3, r);
            fire(ctx, b, 'foundation', t + 4.2, r, { rank: 1 });
            fire(ctx, b, 'invalid', t + 5.1, r);
            fire(ctx, b, 'place', t + 6.0, r);
            fire(ctx, b, 'recycle', t + 6.9, r);
            fire(ctx, b, 'place', t + 8.2, r);
            fire(ctx, b, 'flip', t + 8.45, r);
            fire(ctx, b, 'lift', t + 9.1, r);
            fire(ctx, b, 'run-place', t + 9.4, r, { count: 3 });
            fire(ctx, b, 'foundation', t + 10.4, r, { rank: 2 });
            fire(ctx, b, 'foundation', t + 11.1, r, { rank: 3 });
            // the board opens up and the cascade takes over
            for (let i = 0; i < 14; i++) {
              fire(ctx, b, 'auto-place', t + 11.9 + i * CASCADE, r, { rank: (i % 13) + 1 });
            }
            // …and the win fires from inside that last tick's handler
            fire(ctx, b, 'win', t + 11.9 + 13 * CASCADE, r);
          },
        },
        {
          label: 'a spider run clears — the sequence, then the game out',
          dur: 12.0,
          build: (ctx, b, t, r) => {
            fire(ctx, b, 'lift', t + 0.3, r);
            fire(ctx, b, 'run-place', t + 0.7, r, { count: 6 });
            fire(ctx, b, 'flip', t + 1.5, r);
            fire(ctx, b, 'place', t + 2.3, r);
            fire(ctx, b, 'run-place', t + 3.1, r, { count: 12 });
            fire(ctx, b, 'sequence', t + 3.5, r);        // afterMove sweeps it home
            fire(ctx, b, 'flip', t + 4.9, r);
            fire(ctx, b, 'place', t + 5.7, r);
            fire(ctx, b, 'run-place', t + 6.5, r, { count: 9 });
            fire(ctx, b, 'sequence', t + 6.9, r);
            fire(ctx, b, 'win', t + 6.9, r);             // the last sequence wins it
          },
        },
        {
          label: 'freecell — supermoves, a refusal, and the deck spent',
          dur: 10.0,
          build: (ctx, b, t, r) => {
            fire(ctx, b, 'lift', t + 0.3, r);
            fire(ctx, b, 'run-place', t + 0.6, r, { count: 5 });
            fire(ctx, b, 'place', t + 1.6, r);
            fire(ctx, b, 'invalid', t + 2.3, r);
            fire(ctx, b, 'lift', t + 3.0, r);
            fire(ctx, b, 'run-place', t + 3.3, r, { count: 8 });
            fire(ctx, b, 'foundation', t + 4.4, r, { rank: 4 });
            fire(ctx, b, 'foundation', t + 5.0, r, { rank: 5 });
            fire(ctx, b, 'undo', t + 5.9, r);
            fire(ctx, b, 'undo', t + 6.5, r);
            fire(ctx, b, 'place', t + 7.3, r);
            fire(ctx, b, 'pass-limit', t + 8.1, r);
          },
        },
        {
          label: 'stuck — refusals, undos, and the deck out of passes',
          dur: 8.0,
          build: (ctx, b, t, r) => {
            fire(ctx, b, 'place', t + 0.3, r);
            fire(ctx, b, 'invalid', t + 1.1, r);
            fire(ctx, b, 'invalid', t + 1.5, r);
            fire(ctx, b, 'recycle', t + 2.2, r);
            fire(ctx, b, 'invalid', t + 3.4, r);
            fire(ctx, b, 'undo', t + 4.1, r);
            fire(ctx, b, 'undo', t + 4.6, r);
            fire(ctx, b, 'undo', t + 5.1, r);
            fire(ctx, b, 'pass-limit', t + 6.0, r);
          },
        },
      ],
    },
  ];

  global.PACK = { name: P.name, ROOM: P.ROOM, SENDS, CUES, SECTIONS, GAP, TAIL };
})(typeof window !== 'undefined' ? window : globalThis);
