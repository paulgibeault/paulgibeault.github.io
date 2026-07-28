// cozy-solitaire — the short audition. THE one to listen to first.
//
//   node tools/soundpack/render.mjs cozy-solitaire \
//     --audition tools/soundpack/auditions/cozy-solitaire-short.js --version short
//
// A listening file, not a diagnostic one: every sound once, in the order a
// player meets it, with clear air around each — then one hand at real pace.
// No A/B material, no repetition runs, no dry/wet pairs. The long
// `cozy-solitaire.js` timeline is where the proving happens.
//
// The pack in one line: the parlor after hours — felt, cardstock and a wooden
// table, unpitched all the way through except for undo and the win.
//
(function (global) {
  'use strict';
  const S = global.ArcadeAudioElements;
  const P = global.CozySolitairePack;
  const { CUES, SENDS } = P;

  const GAP = 1.15;   // roomy: each sound needs to arrive alone
  const TAIL = 1.6;

  const o = (bus, name) => S.out(bus, SENDS[name]);
  const fire = (ctx, bus, name, at, r, params) =>
    CUES[name](ctx, o(bus, name), at, params || null, r);

  const CASCADE = 0.10;   // the paced auto-complete tick, from constants.js

  const SECTIONS = [
    {
      title: 'The sounds, in the order you meet them',
      note: 'A new game is dealt — the one flourish in the pack, a real riffle. Then the two you hear thousands of times: a card landing on felt, and a face-down card turning up (no weight under it, and it steps up at the end). A card landing HOME is the same landing with its rank ringing on top — the ace and the king are the two ends of that ladder, and everything in between climbs. A run lands as a short packet. The waste turning over is a packet squared and set down; a refusal is the one gesture with no ring in it at all, and no-passes-left is that again, lower and final. Undo is deliberately not a card at all — a warm note gliding down, the game itself moving rather than a card. Then a cascade climbing, a spider run completing, and the win: a music box, and the deck put away.',
      items: [
        { label: 'a new game is dealt', dur: null, cue: 'deal', send: SENDS['deal'] },
        { label: 'a card lands on felt', dur: null, cue: 'place', send: SENDS['place'] },
        { label: 'a face-down card turns up', dur: null, cue: 'flip', send: SENDS['flip'] },
        { label: 'a card lands home — the ACE (bottom of the ladder)', dur: null, cue: 'foundation', send: SENDS['foundation'], params: { rank: 1 } },
        { label: 'a card lands home — the KING (top of the ladder)', dur: null, cue: 'foundation', send: SENDS['foundation'], params: { rank: 13 } },
        { label: 'a drag begins — a corner peeling off felt', dur: null, cue: 'lift', send: SENDS['lift'] },
        { label: 'a run of five lands as one', dur: null, cue: 'run-place', send: SENDS['run-place'], params: { count: 5 } },
        { label: 'the waste turns back into the stock', dur: null, cue: 'recycle', send: SENDS['recycle'] },
        { label: 'the move is refused — "not there"', dur: null, cue: 'invalid', send: SENDS['invalid'] },
        { label: 'no passes left — "not any more"', dur: null, cue: 'pass-limit', send: SENDS['pass-limit'] },
        { label: 'undo — the pitched exception', dur: null, cue: 'undo', send: SENDS['undo'] },
        { label: 'the auto-complete cascade — one suit climbing', dur: 2.0, build: (ctx, b, t, r) => {
          for (let i = 0; i < 13; i++) fire(ctx, b, 'auto-place', t + i * CASCADE, r, { rank: i + 1 });
        } },
        { label: 'a spider run completes — thirteen cards and the whole ladder', dur: null, cue: 'sequence', send: SENDS['sequence'] },
        { label: 'THE WIN — a music box, then the deck put away', dur: null, cue: 'win', send: SENDS['win'] },
      ],
    },
    {
      title: 'One hand',
      note: 'A real game at real pace: dealt, played at thinking speed with one wrong move and one deck recycle, then the board opens up, the cascade takes over climbing as it goes, and the win arrives — fired from inside the same handler as the last card, which is why it waits 450 ms so it lands in clear air rather than underneath. Listen for the depth: the table under the felt under the card under the rank.',
      items: [
        {
          label: 'a quick klondike, start to finish',
          dur: 18.5,
          build: (ctx, b, t, r) => {
            fire(ctx, b, 'deal', t + 0.2, r);
            fire(ctx, b, 'lift', t + 1.9, r);
            fire(ctx, b, 'place', t + 2.2, r);
            fire(ctx, b, 'flip', t + 2.45, r);
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
            for (let i = 0; i < 14; i++) {
              fire(ctx, b, 'auto-place', t + 11.9 + i * CASCADE, r, { rank: (i % 13) + 1 });
            }
            fire(ctx, b, 'win', t + 11.9 + 13 * CASCADE, r);
          },
        },
      ],
    },
  ];

  global.PACK = { name: P.name, ROOM: P.ROOM, SENDS, CUES, SECTIONS, GAP, TAIL };
})(typeof window !== 'undefined' ? window : globalThis);
