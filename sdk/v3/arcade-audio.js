/* Paul's Arcade — audio elements (companion to arcade-sdk.js)
 *
 * Physical-gesture synthesis primitives for sound packs: friction, strike,
 * stick-slip creak, Karplus-Strong pluck, water droplets, inharmonic struck
 * bodies, sustained streams, plus the shared convolution room they all feed.
 *
 * Load AFTER arcade-sdk.js, from the same major-pinned path:
 *
 *   <script src="/sdk/v3/arcade-sdk.js"></script>
 *   <script src="/sdk/v3/arcade-audio.js"></script>
 *
 * Optional — games that only need simple cues can skip it and keep using
 * `Arcade.audio.cue()` spec voices. Loading it lights up `Arcade.audio.graph()`
 * (see ARCADE_PLATFORM.md).
 *
 * This is also the exact file `tools/soundpack/render.mjs` injects into headless
 * Chromium to render audition WAVs — the audition and the game run the same
 * code, which is what closes the usual gap between a sound mockup and what
 * actually ships. Keep it free of any dependency on `Arcade`.
 */

//
// Plain script, no imports: the offline renderer injects this verbatim into a
// headless-Chromium page, and the browser runtime can load the identical file
// with a <script> tag. Everything here is real WebAudio, so what gets rendered
// to the audition WAV is bit-identical to what would play live.
//
// The design vocabulary is "elements" — physical gestures, not waveforms. Each
// element models how a real object actually makes its sound: friction, strike,
// stick-slip, a plucked string's decaying feedback loop. Cues (in packs/) layer
// and time-offset elements; the shared room (createBus) is what makes overlaid
// cues fuse into a scene instead of stacking into a pile.

(function (global) {
  'use strict';

  // ── deterministic randomness ──────────────────────────────────────────
  // Every render must be reproducible, so "random" is always a seeded stream.
  // Per-play variation is the antidote to the byte-identical repetition that
  // makes synthesised audio read as chiptune.
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const between = (r, lo, hi) => lo + r() * (hi - lo);
  const cents = (r, n) => Math.pow(2, between(r, -n, n) / 1200);

  // ── envelopes ─────────────────────────────────────────────────────────
  // Exponential decay, not the linear ramp the old engine used. Natural decay
  // is exponential; linear decay is one of the tells the ear reads as "synth".
  const FLOOR = 0.0001;
  function env(param, t, peak, attack, dur) {
    const p = Math.max(peak, FLOOR * 2);
    param.setValueAtTime(FLOOR, t);
    param.exponentialRampToValueAtTime(p, t + attack);
    param.exponentialRampToValueAtTime(FLOOR, t + Math.max(dur, attack + 0.005));
  }

  // A bandpass passes only f/Q Hz of a noise source's full-band energy, so the
  // narrower the resonance the quieter the result — a Q of 7.5 at 250 Hz throws
  // away about 29 dB. Without this makeup, "more resonant" silently means "more
  // inaudible", and the tuning fights itself.
  function bandMakeup(ctx, f, Q) {
    const bw = Math.max(1, f / Math.max(0.1, Q));
    return Math.sqrt((ctx.sampleRate / 2) / bw);
  }

  // ── noise ─────────────────────────────────────────────────────────────
  const _noiseCache = new Map();
  function noiseBuffer(ctx, dur, seed) {
    const key = ctx.sampleRate + ':' + dur.toFixed(3) + ':' + seed;
    if (_noiseCache.has(key)) return _noiseCache.get(key);
    const len = Math.max(1, Math.ceil(dur * ctx.sampleRate));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    const r = rng(seed);
    for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
    _noiseCache.set(key, buf);
    return buf;
  }

  // ── the room ──────────────────────────────────────────────────────────
  // A procedurally generated impulse response: sparse early reflections for the
  // sense of a bounded space, then a noise tail that both decays and *darkens*
  // over time (high frequencies are absorbed first — this is what separates a
  // real room from a reverb preset).
  function impulseResponse(ctx, opts) {
    const o = opts || {};
    const dur = o.dur || 2.0;
    const decay = o.decay || 0.55;
    const preDelay = o.preDelay || 0.012;
    const sr = ctx.sampleRate;
    const len = Math.ceil(dur * sr);
    const buf = ctx.createBuffer(2, len, sr);
    const r = rng(o.seed || 7);
    const pd = Math.floor(preDelay * sr);

    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = pd; i < len; i++) {
        const t = (i - pd) / sr;
        // coefficient shrinks over time → progressively more low-passed
        const k = 0.5 * Math.exp(-t / (decay * 1.1)) + 0.04;
        lp += ((r() * 2 - 1) - lp) * k;
        d[i] += lp * Math.exp(-t / decay);
      }
      // early reflections, decorrelated per channel for width
      for (let i = 0; i < 14; i++) {
        const pos = pd + Math.floor(between(r, 0.004, 0.08) * sr);
        if (pos < len) d[pos] += (1 - i / 14) * between(r, 0.3, 0.8) * (r() < 0.5 ? -1 : 1);
      }
      let peak = 0;
      for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
      if (peak > 0) for (let i = 0; i < len; i++) d[i] /= peak;
    }
    return buf;
  }

  // One room, shared by every cue. This is the single biggest lever for
  // "blends well overlaid": sounds that share a space fuse; sounds pasted onto
  // silence collide.
  function createBus(ctx, destination, room) {
    const o = room || {};
    const dry = ctx.createGain();
    const send = ctx.createGain();
    const wet = ctx.createGain();
    const conv = ctx.createConvolver();
    const shelf = ctx.createBiquadFilter();
    const comp = ctx.createDynamicsCompressor();

    conv.buffer = impulseResponse(ctx, o);
    conv.normalize = true;
    wet.gain.value = o.wet == null ? 0.9 : o.wet;
    dry.gain.value = o.dryLevel == null ? 1.0 : o.dryLevel;

    // gentle warmth: shave the top so nothing reads as brittle/digital
    shelf.type = 'highshelf';
    shelf.frequency.value = o.shelfHz || 6000;
    shelf.gain.value = o.shelfDb == null ? -4 : o.shelfDb;

    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 2.5;
    comp.attack.value = 0.006;
    comp.release.value = 0.18;

    send.connect(conv);
    conv.connect(wet);
    dry.connect(shelf);
    wet.connect(shelf);
    shelf.connect(comp);
    comp.connect(destination || ctx.destination);

    return { ctx, dry, send };
  }

  // Per-cue output: one node to connect sources to, wired to both the dry path
  // and the room send. `sendAmount: 0` renders the cue with no room at all,
  // which the audition uses for its dry/wet comparisons.
  function out(bus, sendAmount) {
    const g = bus.ctx.createGain();
    const s = bus.ctx.createGain();
    s.gain.value = sendAmount == null ? 0.25 : sendAmount;
    g.connect(bus.dry);
    g.connect(s);
    s.connect(bus.send);
    return g;
  }

  // Sustained cues need to stop the sources they started, but an element builds
  // its graph and returns without keeping handles. Pass `collect: []` in any
  // element's params and it reports every source node it creates, so a cue can
  // return a real teardown. The alternative — wrapping ctx.createOscillator
  // around the call — works only because JS is single-threaded and breaks the
  // day a cue does anything async.
  function track(p, node) {
    if (p && Array.isArray(p.collect)) p.collect.push(node);
    return node;
  }

  // ── elements ──────────────────────────────────────────────────────────

  // Contact click. Every physical event starts with one; its absence is why
  // pure tones sound like they were never touched by anything.
  function strike(ctx, dest, t, p) {
    const dur = p.dur || 0.006;
    const src = track(p, ctx.createBufferSource());
    src.buffer = noiseBuffer(ctx, dur + 0.02, p.seed || 11);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = p.hp || 2200;
    const g = ctx.createGain();
    env(g.gain, t, p.gain == null ? 0.3 : p.gain, 0.0006, dur);
    src.connect(hp); hp.connect(g); g.connect(dest);
    src.start(t); src.stop(t + dur + 0.03);
    return dur;
  }

  // Friction/air: noise through a bandpass whose cutoff *moves*. A static
  // filter still sounds synthetic; the sweep is what reads as material.
  // `lp` cascades two lowpass stages after the band, for the same reason creak
  // and stream do: a biquad bandpass only rolls off at 6 dB/octave, so a soft
  // low-register gesture still leaks enough top end to read as hiss rather than
  // as paper, cloth or air. Omit it and the element behaves exactly as before.
  function rustle(ctx, dest, t, p) {
    const dur = p.dur || 0.3;
    const src = track(p, ctx.createBufferSource());
    src.buffer = noiseBuffer(ctx, dur + 0.05, p.seed || 23);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(p.f0 || 900, t);
    bp.frequency.exponentialRampToValueAtTime(p.f1 || 2400, t + dur);
    const Q = p.Q || 1.6;
    bp.Q.value = Q;
    const g = ctx.createGain();
    const atk = p.attack == null ? dur * 0.35 : p.attack;
    const mk = bandMakeup(ctx, ((p.f0 || 900) + (p.f1 || 2400)) / 2, Q);
    env(g.gain, t, (p.gain == null ? 0.25 : p.gain) * mk, atk, dur);
    let tail = bp;
    if (p.lp) {
      for (let i = 0; i < 2; i++) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = p.lp;
        tail.connect(lp);
        tail = lp;
      }
    }
    src.connect(bp); tail.connect(g); g.connect(dest);
    src.start(t); src.stop(t + dur + 0.05);
    return dur;
  }

  // Plucked string, by Karplus–Strong: a noise burst circulating in a delay
  // line one period long, low-passed a little on each lap. Synthesised into a
  // buffer rather than a node cycle, because WebAudio feedback loops are
  // clamped to a 128-sample quantum and that ceiling lands inside our range.
  function pluckBuffer(ctx, freq, dur, damping, seed) {
    const sr = ctx.sampleRate;
    const N = Math.max(2, Math.round(sr / freq));
    const len = Math.ceil(dur * sr);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const r = rng(seed || 5);
    const line = new Float32Array(N);
    let prev = 0;
    for (let i = 0; i < N; i++) {
      prev += ((r() * 2 - 1) - prev) * 0.65; // a pluck excites, but not with pure white
      line[i] = prev;
    }
    let idx = 0;
    const damp = damping == null ? 0.996 : damping;
    for (let i = 0; i < len; i++) {
      const cur = line[idx];
      const nxt = line[(idx + 1) % N];
      d[i] = cur;
      line[idx] = (cur + nxt) * 0.5 * damp;
      idx = (idx + 1) % N;
    }
    return buf;
  }

  function pluck(ctx, dest, t, p) {
    const dur = p.dur || 1.2;
    const src = track(p, ctx.createBufferSource());
    src.buffer = pluckBuffer(ctx, p.freq, dur, p.damping, p.seed);
    if (p.bend) {
      // string tension easing off — real playback-rate glide, not a step
      src.playbackRate.setValueAtTime(1, t);
      src.playbackRate.linearRampToValueAtTime(p.bend, t + dur);
    }
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = p.tone || 3200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(FLOOR, t);
    g.gain.exponentialRampToValueAtTime(Math.max(p.gain || 0.3, FLOOR * 2), t + 0.003);
    g.gain.setValueAtTime(Math.max(p.gain || 0.3, FLOOR * 2), t + Math.min(0.05, dur * 0.4));
    g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
    src.connect(lp); lp.connect(g); g.connect(dest);
    src.start(t); src.stop(t + dur + 0.05);
    return dur;
  }

  // Rope and wood under load. Creak is *stick-slip*: the surfaces grip, tension
  // builds, they release, repeat — irregularly. That irregular amplitude
  // envelope is the whole sound; a smooth envelope just gives filtered hiss.
  // `rate1` (optional) is the stick-slip rate at the END of the gesture, swept
  // from `rate` across the buffer. A mechanism that starts turning and settles
  // grips more slowly as it slows; a constant rate reads as a hand-held creak
  // no matter what the envelope does, because the ear tracks event density.
  function creakBuffer(ctx, dur, seed, rate, rate1) {
    const sr = ctx.sampleRate;
    const len = Math.ceil(dur * sr);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const r = rng(seed || 31);
    const spd0 = rate || 1;
    const spd1 = rate1 == null ? spd0 : rate1;
    let amp = 0, next = 0, k = 1;
    for (let i = 0; i < len; i++) {
      if (i >= next) {
        const spd = spd0 + (spd1 - spd0) * (i / len);
        amp = between(r, 0.35, 1.0);
        k = Math.exp(-1 / (between(r, 0.003, 0.022) * sr));
        next = i + Math.floor(between(r, 0.005, 0.055) * sr / Math.max(0.05, spd));
      }
      amp *= k;
      d[i] = (r() * 2 - 1) * amp;
    }
    return buf;
  }

  function creak(ctx, dest, t, p) {
    const dur = p.dur || 0.5;
    const src = track(p, ctx.createBufferSource());
    src.buffer = creakBuffer(ctx, dur + 0.05, p.seed, p.rate, p.rate1);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(p.f0 || 260, t);
    if (p.f1) bp.frequency.exponentialRampToValueAtTime(p.f1, t + dur);
    const Q = p.Q || 7;
    bp.Q.value = Q;
    // A biquad bandpass only rolls off at 6 dB/octave, so plenty of high end
    // leaks past it. Rope and wood have almost nothing up there — without this
    // second stage a creak measures (and reads) as hiss with a bump in it.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = p.lp || 1100;
    const lp2 = ctx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.value = p.lp || 1100;
    const g = ctx.createGain();
    const mk = bandMakeup(ctx, p.f0 || 260, Q);
    env(g.gain, t, (p.gain == null ? 0.3 : p.gain) * mk, p.attack || dur * 0.25, dur);
    src.connect(bp); bp.connect(lp); lp.connect(lp2); lp2.connect(g); g.connect(dest);
    src.start(t); src.stop(t + dur + 0.05);
    return dur;
  }

  // Water. The "plink" of a droplet is a fast *upward* pitch sweep — the cavity
  // left by the impact shrinks as it collapses, raising its resonance. Sweeping
  // downward, the intuitive choice, sounds nothing like water.
  function droplet(ctx, dest, t, p) {
    const dur = p.dur || 0.05;
    strike(ctx, dest, t, { dur: 0.004, hp: 3500, gain: (p.gain || 0.2) * 0.35, seed: (p.seed || 3) + 1, collect: p.collect });
    const osc = track(p, ctx.createOscillator());
    osc.type = 'sine';
    osc.frequency.setValueAtTime(p.f0 || 320, t);
    osc.frequency.exponentialRampToValueAtTime(p.f1 || 1500, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = p.tone || 2800;
    lp.Q.value = 5;
    const g = ctx.createGain();
    env(g.gain, t, p.gain == null ? 0.2 : p.gain, 0.0015, dur * 1.5);
    osc.connect(lp); lp.connect(g); g.connect(dest);
    osc.start(t); osc.stop(t + dur * 1.6 + 0.02);
    return dur * 1.6;
  }

  // Struck resonant body — bells, chimes, bars. Two things make this sound
  // struck rather than played: partials are INHARMONIC (not integer multiples),
  // and each partial decays at its OWN rate, with the high ones dying first.
  // Every partial is a detuned pair so the stack beats slowly instead of
  // sitting perfectly still.
  function body(ctx, dest, t, p) {
    let longest = 0;
    for (const pt of p.partials) {
      const delay = pt.delay || 0;
      const decay = pt.decay;
      longest = Math.max(longest, delay + decay);
      const det = pt.detune == null ? 3 : pt.detune;
      for (const side of [-1, 1]) {
        const o = track(p, ctx.createOscillator());
        o.type = p.type || 'sine';
        o.frequency.value = p.f0 * pt.ratio;
        o.detune.value = side * det;
        const g = ctx.createGain();
        env(g.gain, t + delay, (p.gain || 0.3) * pt.gain * 0.5, pt.attack || 0.004, decay);
        o.connect(g); g.connect(dest);
        o.start(t + delay); o.stop(t + delay + decay + 0.08);
      }
    }
    return longest;
  }

  // Low impact weight — taiko, a body landing, distant thunder.
  //
  // `attack` (default 4 ms) is the difference between a hit and a swell. Left
  // fast it punches, which is right for an impact and wrong for anything that
  // grows — a fireball, a wave arriving — where the same fast onset is heard as
  // a pop in front of the sound rather than as part of it.
  function thump(ctx, dest, t, p) {
    const dur = p.dur || 0.35;
    const atk = p.attack == null ? 0.004 : p.attack;
    const osc = track(p, ctx.createOscillator());
    osc.type = 'sine';
    osc.frequency.setValueAtTime(p.f0 || 110, t);
    osc.frequency.exponentialRampToValueAtTime(p.f1 || 45, t + dur * 0.8);
    const g = ctx.createGain();
    env(g.gain, t, p.gain == null ? 0.35 : p.gain, atk, dur);
    osc.connect(g); g.connect(dest);
    osc.start(t); osc.stop(t + dur + 0.05);

    const n = track(p, ctx.createBufferSource());
    n.buffer = noiseBuffer(ctx, 0.08, (p.seed || 9) + 4);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    const ng = ctx.createGain();
    env(ng.gain, t, (p.gain == null ? 0.35 : p.gain) * 0.5, 0.002, 0.06);
    n.connect(lp); lp.connect(ng); ng.connect(dest);
    n.start(t); n.stop(t + 0.1);
    return dur;
  }

  // Combustion — a lamp taking flame, a torch catching, a burner lighting.
  // Three things separate this from "noise with an envelope":
  //   · No contact click. Nothing touches anything; a strike here reads as a
  //     thrown object, not as ignition.
  //   · The onset SWELLS. Air catching light takes tens of milliseconds to
  //     bloom; a hard attack is the single most common way this ends up
  //     sounding like a thud with hiss on top.
  //   · The band sweeps DOWNWARD, because the ball of hot air resonates lower
  //     as it expands.
  // `weight` (0..1) is how much low pressure pulse sits under the flame — 0 for
  // a match head, more for something with volume behind it. `bright` scales the
  // whole band, so repeated flares in one cluster don't stack into a tone.
  function flare(ctx, dest, t, p) {
    const dur = p.dur || 0.3;
    const gain = p.gain == null ? 0.12 : p.gain;
    const bright = p.bright || 1;
    const f0 = (p.f0 || 1450) * bright;
    const f1 = (p.f1 || 700) * bright;
    const seed = p.seed || 61;
    const atk = p.attack == null ? Math.min(0.06, dur * 0.2) : p.attack;
    // the flame front
    rustle(ctx, dest, t, {
      f0, f1, Q: p.Q || 0.9, lp: p.lp, dur, gain, attack: atk,
      seed, collect: p.collect,
    });
    // its top — thinner, faster, quieter; this is what makes it airy
    rustle(ctx, dest, t + 0.01, {
      f0: f0 * 2.0, f1: f1 * 2.0, Q: (p.Q || 0.9) * 1.3, lp: p.lp,
      dur: dur * 0.6, gain: gain * 0.35, attack: atk * 0.6,
      seed: seed + 1, collect: p.collect,
    });
    const weight = p.weight == null ? 0.3 : p.weight;
    if (weight > 0) {
      thump(ctx, dest, t + 0.01, {
        f0: p.wf0 || 150, f1: (p.wf0 || 150) * 0.38, dur: dur * 0.9,
        // The weight has to arrive WITH the flame, not before it. A default
        // thump onset is 4 ms, which under a swelling noise front is heard as a
        // pop and then a flare — two events where there should be one.
        attack: p.wAttack == null ? Math.min(0.05, dur * 0.15) : p.wAttack,
        gain: gain * weight, seed: seed + 2, collect: p.collect,
      });
    }
    return dur * 1.1;
  }

  // Explosion. Built the opposite way round from `flare`: the front arrives
  // first and hard, and the low end carries everything after it. `size` scales
  // duration and depth together — a bigger blast is not a louder small one.
  //
  // Everything here is noise and pitch-dropping sine, and that is the point: an
  // explosion has no pitch. An inharmonic `body` under the boom — the obvious
  // way to voice "a shell of hot air" — gives partials that ring at definite
  // frequencies, and the ear picks that out of the noise instantly as a tone
  // sitting inside the bang. `tone` (default 0, off) can add it back for a
  // resonating container: a boiler, a bell struck by the blast, a hull.
  //
  // What replaces it is `rumble`: a long, very low, heavily lowpassed noise
  // layer that swells rather than hits. That is the part heard as size.
  //
  // `crack` (0..1, default 1) is the snap at the very front. It is the whole
  // difference between a detonation — high explosive, a gunshot, something
  // shattering — and a fireball, which is fuel igniting and has no snap at all.
  // Set it to 0 and raise `attack` and what comes out is a whump: the sound
  // arrives as a swell of low air rather than as an edge. A fireball with a
  // crack on it reads as a firecracker no matter how much bass is underneath.
  function blast(ctx, dest, t, p) {
    const size = p.size == null ? 1 : p.size;
    const gain = p.gain == null ? 0.24 : p.gain;
    const seed = p.seed || 71;
    const dur = (p.dur || 0.55) * size;
    const crack = p.crack == null ? 1 : p.crack;
    const attack = p.attack == null ? 0.008 : p.attack;
    // the crack — the body of the front, plus a thin edge on top
    if (crack > 0) {
      strike(ctx, dest, t, { dur: 0.04, hp: 180, gain: gain * 1.1 * crack, seed, collect: p.collect });
      strike(ctx, dest, t + 0.004, { dur: 0.012, hp: 2200, gain: gain * 0.4 * crack, seed: seed + 1, collect: p.collect });
    }
    // the front, sweeping the whole band down as it expands
    rustle(ctx, dest, t, {
      f0: (p.f0 || 2700) / size, f1: (p.f1 || 210) / size, Q: 0.65, lp: p.lp,
      dur, gain: gain * 0.82, attack, seed: seed + 2, collect: p.collect,
    });
    // the boom — as soft-onset as the front, or the snap comes back in through
    // the low end instead of the top
    thump(ctx, dest, t, {
      f0: (p.wf0 || 130) / size, f1: 26, dur: dur * 1.9, gain: gain * 1.15,
      attack: Math.max(0.004, attack * 0.8), seed: seed + 3, collect: p.collect,
    });
    // …and the sub under the boom, an octave down and slower to arrive
    thump(ctx, dest, t + 0.02, {
      f0: (p.wf0 || 130) * 0.5 / size, f1: 22, dur: dur * 2.6, gain: gain * 0.8,
      attack: 0.03, seed: seed + 4, collect: p.collect,
    });
    // the rumble rolling away — noise, not pitch
    const rumble = p.rumble == null ? 1 : p.rumble;
    if (rumble > 0) {
      rustle(ctx, dest, t + 0.01, {
        f0: 190 / size, f1: 42 / size, Q: 0.5, lp: 170,
        dur: dur * 3.0, gain: gain * 0.9 * rumble, attack: dur * 0.25,
        seed: seed + 5, collect: p.collect,
      });
      rustle(ctx, dest, t + 0.04, {
        f0: 420 / size, f1: 120 / size, Q: 0.6, lp: 380,
        dur: dur * 2.2, gain: gain * 0.4 * rumble, attack: dur * 0.35,
        seed: seed + 6, collect: p.collect,
      });
    }
    // an inharmonic shell, only if something around the blast should ring
    if (p.tone) {
      body(ctx, dest, t + 0.02, {
        f0: (p.bf0 || 64) / size, gain: gain * 0.42 * p.tone,
        partials: [
          { ratio: 1.0, gain: 1.0, decay: 1.30 * size, detune: 11, attack: 0.03 },
          { ratio: 2.47, gain: 0.30, decay: 0.55 * size, detune: 15, attack: 0.02 },
          { ratio: 4.13, gain: 0.12, decay: 0.28 * size, detune: 19, attack: 0.015 },
        ],
        collect: p.collect,
      });
    }
    return dur * 3.0 + 0.3;
  }

  // Insect stridulation — a cricket, a katydid, a cicada. A chirp is not a
  // tone: it is a train of 2–5 very short pulses a few tens of milliseconds
  // apart, and the PULSE RATE is what the ear reads as "insect" (and, in real
  // insects, as temperature — they stridulate faster when it is warm). One
  // long note at the same frequency reads as a whistle.
  function chirp(ctx, dest, t, p) {
    const f = p.f || 3600;
    const pulses = p.pulses || 3;
    const step = p.step || 0.04;
    const gain = p.gain == null ? 0.05 : p.gain;
    const pulse = p.pulse || 0.016;
    for (let i = 0; i < pulses; i++) {
      body(ctx, dest, t + i * step, {
        f0: f, gain,
        partials: [
          { ratio: 1.0, gain: 1.0, decay: pulse, detune: p.detune == null ? 9 : p.detune, attack: pulse * 0.25 },
          { ratio: 2.02, gain: 0.16, decay: pulse * 0.55, detune: 14, attack: pulse * 0.2 },
        ],
        collect: p.collect,
      });
    }
    return pulses * step;
  }

  // Sustained filtered-noise layer with a slowly drifting band — the basis for
  // running water, wind, and other ambient beds.
  function stream(ctx, dest, t, dur, p) {
    const src = track(p, ctx.createBufferSource());
    src.buffer = noiseBuffer(ctx, Math.min(dur + 0.5, 8), p.seed || 41);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = p.f || 900;
    bp.Q.value = p.Q || 0.9;
    // Water is broadband but rolled off hard at the top. Without this, a
    // low-Q bandpass on white noise keeps enough high end to read as tape hiss
    // rather than as a river.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = p.lp || 1900;
    const lp2 = ctx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.value = p.lp || 1900;
    const lfo = track(p, ctx.createOscillator());
    lfo.type = 'sine';
    lfo.frequency.value = p.rate || 0.07;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = p.sweep || 300;
    lfo.connect(lfoAmt); lfoAmt.connect(bp.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(FLOOR, t);
    g.gain.exponentialRampToValueAtTime(Math.max(p.gain || 0.05, FLOOR * 2), t + (p.fade || 1.2));
    g.gain.setValueAtTime(Math.max(p.gain || 0.05, FLOOR * 2), t + dur - (p.fade || 1.2));
    g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
    src.connect(bp); bp.connect(lp); lp.connect(lp2); lp2.connect(g); g.connect(dest);
    src.start(t); src.stop(t + dur + 0.05);
    lfo.start(t); lfo.stop(t + dur + 0.05);
    return dur;
  }

  // The teardown a sustained cue is expected to return, given the `collect`
  // array its elements filled in. Stopping a bed has to actually stop its
  // sources: merely disconnecting the output leaves everything scheduled and
  // alive for the rest of the bed's duration, once per start().
  function teardown(collect) {
    return function stopCollected(when) {
      for (const n of collect) { try { n.stop(when); } catch (e) { /* already ended */ } }
    };
  }

  global.ArcadeAudioElements = {
    rng, between, cents, env, noiseBuffer, impulseResponse, createBus, out,
    track, teardown,
    strike, rustle, pluck, pluckBuffer, creak, creakBuffer, droplet, body, thump,
    flare, blast, chirp, stream,
  };
})(typeof window !== 'undefined' ? window : globalThis);
