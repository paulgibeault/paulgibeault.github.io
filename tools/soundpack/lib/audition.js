// Audition archetypes — the reusable half of a sound-pack audition.
//
// An audition is a timeline that fires a pack's cues in the arrangements that
// have historically caught real defects. Most of that timeline is not specific
// to any one pack: "every cue dry, then in the room", "this cue ten times at
// play density", "these two cues alternating so we can hear whether they blur".
// Those are the archetypes, and they live here. What stays in an app's own
// audition file is the part that is genuinely its own — which cues contrast
// with which, and the scenes that mirror how it actually plays.
//
// Plain script, no imports, so the offline renderer can inject it verbatim
// exactly as it injects the element library. Reads the pack from the well-known
// `ArcadeSoundPack` handle (see arcade-audio.js `registerPack`), so nothing
// here — and nothing in the renderer — knows which app is loaded.
//
// ── the shape it produces ────────────────────────────────────────────────
//
//   ArcadeAudition.publish({ gap, tail, sections: [ …sections… ] })
//     → global.PACK = { name, ROOM, SENDS, CUES, SECTIONS, GAP, TAIL }
//
// A SECTION is { title, note, items }. An ITEM is either
//   { label, dur, cue, send }   — the renderer plays one registered cue, or
//   { label, dur, build }       — build(ctx, bus, at, rnd) schedules freely.
// `dur: null` means "ask the cue how long it is" (the renderer probes it).
//
// ── usage ────────────────────────────────────────────────────────────────
//
//   const A = ArcadeAudition;
//   A.publish({
//     gap: 0.55, tail: 1.6,
//     sections: [
//       A.contrastPairs('A · Grammar', 'These must never blur.',
//                       [['yes', 'no'], ['win', 'lose']]),
//       A.everyCueDryWet(),
//       A.section('C · Density', 'Real play pace.', [
//         A.repeat('tick', { n: 8, spacing: 0.45 }),
//         A.scene('the finish — last move into the win', 5.0,
//                 [{ cue: 'place', at: 1.2 }, { cue: 'win', at: 1.2 }]),
//       ]),
//     ],
//   });

(function (global) {
  'use strict';

  function pack() {
    const P = global.ArcadeSoundPack;
    if (!P) {
      throw new Error(
        'ArcadeAudition: no pack registered. The pack file must call ' +
        'ArcadeAudioElements.registerPack({ name, ROOM, SENDS, CUES }) and must ' +
        'be loaded before the audition.'
      );
    }
    return P;
  }

  // The per-play output node for a cue: a gain wired to both the dry path and
  // the room send, at the distance the pack declared for that cue. Every cue
  // fired by hand needs one, which is why it was the first line of every
  // audition file before this existed.
  function out(bus, cueName) {
    const P = pack();
    const S = global.ArcadeAudioElements;
    const send = (P.SENDS && P.SENDS[cueName] !== undefined) ? P.SENDS[cueName] : null;
    return S.out(bus, send);
  }

  // Fire one cue at `at`, through its own output node. The ergonomic form of
  // CUES[name](ctx, out(bus, name), at, params, rnd) — which is what an
  // audition would otherwise repeat on every line.
  function fire(ctx, bus, cueName, at, rnd, params) {
    const P = pack();
    const fn = P.CUES[cueName];
    if (!fn) throw new Error(`ArcadeAudition: no cue named '${cueName}' in this pack`);
    return fn(ctx, out(bus, cueName), at, params || null, rnd);
  }

  // ── item builders ──────────────────────────────────────────────────────

  // One cue, once. `send: 0` renders it dry.
  function play(cueName, opts) {
    const o = opts || {};
    const P = pack();
    return {
      label: o.label || cueName,
      dur: o.dur === undefined ? null : o.dur,
      cue: cueName,
      params: o.params || null,
      send: o.send === undefined ? (P.SENDS ? P.SENDS[cueName] : null) : o.send,
    };
  }

  // The same cue n times, `spacing` seconds apart. Level wander and listener
  // fatigue only show up in a run — a cue that is charming once can be
  // unbearable on the eighth repeat, and nothing but repetition reveals it.
  function repeat(cueName, opts) {
    const o = opts || {};
    const n = o.n === undefined ? 6 : o.n;
    const spacing = o.spacing === undefined ? 0.6 : o.spacing;
    return {
      label: o.label || `${cueName} ×${n} — ${spacing.toFixed(2)}s apart`,
      dur: o.dur === undefined ? n * spacing + 1.0 : o.dur,
      build: (ctx, bus, t, r) => {
        for (let i = 0; i < n; i++) fire(ctx, bus, cueName, t + i * spacing, r, o.params);
      },
    };
  }

  // Two or more cues fired at the same instant — the layered-event case (a
  // placement that is both a thud and a verdict), where masking is the risk.
  function together(cueNames, opts) {
    const o = opts || {};
    return {
      label: o.label || cueNames.join(' + '),
      dur: o.dur === undefined ? 2.0 : o.dur,
      build: (ctx, bus, t, r) => { for (const c of cueNames) fire(ctx, bus, c, t, r, o.params); },
    };
  }

  // Cues at explicit offsets — the archetype for "this is how it actually
  // sounds when the game does the thing". steps: [{ cue, at, params? }, …].
  function scene(label, dur, steps) {
    return {
      label,
      dur,
      build: (ctx, bus, t, r) => {
        for (const s of steps) fire(ctx, bus, s.cue, t + (s.at || 0), r, s.params);
      },
    };
  }

  // Escape hatch: full control of the graph for one item. Prefer the builders
  // above — an audition that is mostly custom() is usually describing something
  // that should become an archetype here.
  function custom(label, dur, build) {
    return { label, dur, build };
  }

  // ── section builders ───────────────────────────────────────────────────

  function section(title, note, items) {
    return { title, note: note || '', items: items || [] };
  }

  // Every cue in the pack, twice: without the room, then in it. Derived from
  // the pack, so a cue added later cannot be forgotten here — which is the
  // whole reason this is generated rather than written out.
  function everyCueDryWet(title, note) {
    const P = pack();
    const items = [];
    for (const name of Object.keys(P.CUES)) {
      items.push(play(name, { label: `${name} — dry`, send: 0 }));
      items.push(play(name, { label: `${name} — in the room` }));
    }
    return section(
      title || 'Each cue — dry, then in the room',
      note === undefined
        ? 'First without reverb, then with. The room should read as a place the sound is in, never as a tail stuck on the end of it.'
        : note,
      items
    );
  }

  // Pairs that must stay distinguishable, alternated and then heard alone.
  // Cues that share a voice are separated only by contour, and contour is
  // exactly what stops being obvious once the sounds are seconds apart in play.
  function contrastPairs(title, note, pairs, opts) {
    const o = opts || {};
    const spacing = o.spacing === undefined ? 1.15 : o.spacing;
    const reps = o.reps === undefined ? 2 : o.reps;
    const items = [];
    for (const [a, b] of pairs) {
      items.push(custom(`${a} · ${b} — alternating`, reps * 2 * spacing + 0.6,
        (ctx, bus, t, r) => {
          for (let i = 0; i < reps; i++) {
            fire(ctx, bus, a, t + i * 2 * spacing, r);
            fire(ctx, bus, b, t + i * 2 * spacing + spacing, r);
          }
        }));
    }
    return section(title || 'Grammar — the pairs that must not blur', note || '', items);
  }

  // ── publish ────────────────────────────────────────────────────────────

  // Validate against the pack, then hand the renderer its timeline. Validation
  // is the point: a mistyped cue name would otherwise render as silence and be
  // read as a design problem rather than a typo.
  function publish(spec) {
    const P = pack();
    const sections = (spec && spec.sections) || [];
    if (!sections.length) throw new Error('ArcadeAudition.publish: no sections');

    sections.forEach((s, si) => {
      if (!s || typeof s.title !== 'string' || !Array.isArray(s.items)) {
        throw new Error(`ArcadeAudition.publish: section ${si} needs { title, items }`);
      }
      s.items.forEach((it, ii) => {
        const where = `section ${si} ('${s.title}') item ${ii}`;
        if (!it || typeof it.label !== 'string') throw new Error(`${where}: needs a label`);
        if (it.cue === undefined && typeof it.build !== 'function') {
          throw new Error(`${where}: needs either a cue name or a build function`);
        }
        if (it.cue !== undefined && !P.CUES[it.cue]) {
          throw new Error(`${where}: no cue named '${it.cue}' in pack '${P.name}'`);
        }
      });
    });

    global.PACK = {
      name: P.name,
      ROOM: P.ROOM,
      SENDS: P.SENDS,
      CUES: P.CUES,
      SECTIONS: sections,
      GAP: spec.gap === undefined ? 0.55 : spec.gap,
      TAIL: spec.tail === undefined ? 1.6 : spec.tail,
    };
    return global.PACK;
  }

  global.ArcadeAudition = {
    pack, out, fire,
    play, repeat, together, scene, custom,
    section, everyCueDryWet, contrastPairs,
    publish,
  };
})(typeof window !== 'undefined' ? window : globalThis);
