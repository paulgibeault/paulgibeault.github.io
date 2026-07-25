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

  // ── elements ──────────────────────────────────────────────────────────

  // Contact click. Every physical event starts with one; its absence is why
  // pure tones sound like they were never touched by anything.
  function strike(ctx, dest, t, p) {
    const dur = p.dur || 0.006;
    const src = ctx.createBufferSource();
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
  function rustle(ctx, dest, t, p) {
    const dur = p.dur || 0.3;
    const src = ctx.createBufferSource();
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
    src.connect(bp); bp.connect(g); g.connect(dest);
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
    const src = ctx.createBufferSource();
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
  function creakBuffer(ctx, dur, seed, rate) {
    const sr = ctx.sampleRate;
    const len = Math.ceil(dur * sr);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const r = rng(seed || 31);
    const spd = rate || 1;
    let amp = 0, next = 0, k = 1;
    for (let i = 0; i < len; i++) {
      if (i >= next) {
        amp = between(r, 0.35, 1.0);
        k = Math.exp(-1 / (between(r, 0.003, 0.022) * sr));
        next = i + Math.floor(between(r, 0.005, 0.055) * sr / spd);
      }
      amp *= k;
      d[i] = (r() * 2 - 1) * amp;
    }
    return buf;
  }

  function creak(ctx, dest, t, p) {
    const dur = p.dur || 0.5;
    const src = ctx.createBufferSource();
    src.buffer = creakBuffer(ctx, dur + 0.05, p.seed, p.rate);
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
    strike(ctx, dest, t, { dur: 0.004, hp: 3500, gain: (p.gain || 0.2) * 0.35, seed: (p.seed || 3) + 1 });
    const osc = ctx.createOscillator();
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
        const o = ctx.createOscillator();
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
  function thump(ctx, dest, t, p) {
    const dur = p.dur || 0.35;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(p.f0 || 110, t);
    osc.frequency.exponentialRampToValueAtTime(p.f1 || 45, t + dur * 0.8);
    const g = ctx.createGain();
    env(g.gain, t, p.gain == null ? 0.35 : p.gain, 0.004, dur);
    osc.connect(g); g.connect(dest);
    osc.start(t); osc.stop(t + dur + 0.05);

    const n = ctx.createBufferSource();
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

  // Sustained filtered-noise layer with a slowly drifting band — the basis for
  // running water, wind, and other ambient beds.
  function stream(ctx, dest, t, dur, p) {
    const src = ctx.createBufferSource();
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
    const lfo = ctx.createOscillator();
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

  global.ArcadeAudioElements = {
    rng, between, cents, env, noiseBuffer, impulseResponse, createBus, out,
    strike, rustle, pluck, pluckBuffer, creak, creakBuffer, droplet, body, thump, stream,
  };
})(typeof window !== 'undefined' ? window : globalThis);
