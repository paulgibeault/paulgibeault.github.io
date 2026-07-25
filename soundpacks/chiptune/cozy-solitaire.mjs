// cozy-solitaire — chiptune sound profile (frozen archive).
//
// PROVENANCE
//   Source repo:   paulgibeault/cozy-solitaire
//   Source file:   js/sfx.js
//   Branch:        audio-retune @ f583b358f698cfdb9992ff3a07c260a6a32db4bb
//   Draft PR:      paulgibeault/cozy-solitaire#13
//   Archived:      2026-07-24
//
// Nothing loads this file. It is data, preserved verbatim, awaiting a
// selectable sound-profile system. See ./README.md.
//
// ── SOUND IDENTITY (from the source header, verbatim) ───────────────────────
// Sound identity: this game is a physical card table, not a screen. Cards are
// objects with weight and friction, so every card cue is built as a MATERIAL
// TRANSIENT (a very short noise burst — paper sliding on felt) with a soft tone
// layered a few milliseconds under it as the "settle". The noise is what makes
// the ear hear an object arriving; the tone is what makes it cozy. Neither
// works alone: noise on its own is a hiss, tone on its own is a mobile-game
// chime.
//
// Register: everything lives low-to-mid (150–500 Hz) with the single exception
// of the win flourish. Nothing is allowed to be bright, because card-place and
// card-flip fire dozens of times a minute (and back-to-back during the
// auto-complete cascade). Unobtrusive beats characterful for those two.
//
// Envelopes: fast in (1–6 ms), and the release occupies nearly the whole
// duration, so cues decay rather than stop. Total per-cue length stays under
// ~120 ms so the table feels responsive, not spongy.
//
// Undo is the deliberate exception — it is the one purely tonal cue in the
// file. It is an *un*-doing rather than a card touching felt, so it carries no
// material transient, which also keeps it from competing with card-place.
//
// The SDK's `noise` voice is unfiltered white noise (no filter node is exposed),
// which reads brighter per unit gain than any oscillator. Noise gains here are
// therefore set well below the tone they sit under — they are texture, not
// level.
//
// Order of voices inside an array matters: the noise transient always leads,
// the tone follows a beat later via `delay` so the two overlap into a single
// event rather than reading as two sounds.

export const CUES = {
  // A card lands on a pile (tableau / foundation / stock deal). The workhorse
  // cue — it also drives the auto-complete cascade, so it is the softest of the
  // two card cues: a brief felt-scuff under a low triangle that settles.
  'card-place': [
    { type: 'noise',    dur: 0.028, gain: 0.055, attack: 0.002, release: 0.024 },
    { type: 'triangle', freq: 330, dur: 0.06, gain: 0.10, attack: 0.006, release: 0.05, delay: 0.01 },
  ],

  // A face-down tableau card is turned up. Same material, different gesture:
  // the noise is shorter and proportionally louder (a flick, not a landing) and
  // the tone sits a fourth higher and decays faster, so the flip reads as
  // quicker and crisper than a place without being louder overall.
  'card-flip': [
    { type: 'noise', dur: 0.026, gain: 0.085, attack: 0.001, release: 0.022 },
    { type: 'sine',  freq: 494, dur: 0.05,  gain: 0.10,  attack: 0.005, release: 0.042, delay: 0.014 },
  ],

  // A move/action was rejected. The quietest and lowest cue in the game — a
  // barely-there scuff (the card touching down where it will not go) and a low
  // sine that droops a whole tone as it fades. A soft "nope", never a buzzer.
  'invalid-move': [
    { type: 'noise', dur: 0.02, gain: 0.03, attack: 0.002, release: 0.018 },
    { type: 'sine',  freq: 150, toFreq: 132, dur: 0.11, gain: 0.07, attack: 0.006, release: 0.09, delay: 0.012 },
  ],

  // Undo — a warm downward glide, roughly a fifth. Pure sine (no transient):
  // rewinding is a gesture, not an impact, and the rounder timbre keeps it
  // clear of card-place's triangle.
  'undo': { type: 'sine', freq: 300, toFreq: 200, dur: 0.12, gain: 0.12, attack: 0.008, release: 0.10 },

  // Win jingle — the ascending arpeggio (C5 · E5 · G5 · C6), voiced as a music
  // box rather than a chiptune fanfare: each note is a soft strike whose release
  // spans almost its whole duration, and `delay` is set to about half the note
  // length so notes ring into one another instead of playing end-to-end. The
  // final C6 is left to hang. This is the only place the game goes above 500 Hz —
  // it earns the brightness by happening once per game.
  //
  // ARCHIVIST'S NOTE: in the source this was NOT a registered cue. It lived as a
  // bare `const WIN_JINGLE = [...]` and was handed straight to the play wrapper
  // as an inline spec array (`sfx(WIN_JINGLE)` — the spec passed in the `name`
  // position). It is keyed here so a profile system enumerating CUES cannot
  // silently lose it; the voice list itself is verbatim. See WIN_JINGLE below.
  'win-jingle': [
    { type: 'sine', freq: 523,  dur: 0.22, gain: 0.15, attack: 0.012, release: 0.20 },
    { type: 'sine', freq: 659,  dur: 0.22, gain: 0.15, attack: 0.012, release: 0.20, delay: 0.11 },
    { type: 'sine', freq: 784,  dur: 0.24, gain: 0.15, attack: 0.012, release: 0.22, delay: 0.11 },
    { type: 'sine', freq: 1047, dur: 0.45, gain: 0.16, attack: 0.014, release: 0.42, delay: 0.12 },
  ],
};

// ── NOT-STATIC-DATA: behaviour the cue table alone cannot reproduce ─────────

// The win flourish under its original identifier. Unregistered and unnamed at
// runtime: the game played it as an inline sequence rather than by cue name, so
// it had no string handle at all in the source.
export const WIN_JINGLE = CUES['win-jingle'];

// The SDK merges per-play overrides onto single-object cues only, so of the
// cues above only `undo` could ever accept them. No call site did.
export const OVERRIDE_CAPABLE_CUES = ['undo'];
