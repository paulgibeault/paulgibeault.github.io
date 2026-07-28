#!/usr/bin/env node
// Measure an audition render, item by item.
//
// Nobody authoring these packs can hear them — the renderer is driven by a
// model and reviewed by a human later. This closes part of that gap: it catches
// the failures that show up in numbers (an element that came out inaudible, a
// cue that is all hiss and no tone, a reverb that isn't reaching the mix, a bed
// that drowns the cues) before a human spends a listen on them.
//
//   node tools/soundpack/analyze.mjs <path/to/…manifest.json>
//
// The manifest is what render.mjs printed when it finished; the WAV is read
// from alongside it. Both paths are explicit — this tool knows nothing about
// which apps exist or where any of them keep their renders.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const manifestArg = argv.find((a) => !a.startsWith('--'));
if (!manifestArg) {
  console.error(`sound-pack analyzer

  node tools/soundpack/analyze.mjs <path/to/<name>-<label>.manifest.json>

Measures each item of a finished render and flags what shows up in numbers:
inaudible items, clipping, all-hiss cues, a room that never arrives, a
register plan that has collapsed. Not a substitute for ears.`);
  process.exit(2);
}

const MANIFEST_PATH = resolve(manifestArg);
const OUT = dirname(MANIFEST_PATH);
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const pack = manifest.pack;
const LABEL = manifest.label;
const raw = readFileSync(join(OUT, `${pack}-${LABEL}.wav`));
const SR = manifest.sampleRate;

const pcm = new Int16Array(raw.buffer, raw.byteOffset + 44, (raw.length - 44) / 2);
const frames = pcm.length / 2;
const mono = new Float32Array(frames);
for (let i = 0; i < frames; i++) mono[i] = (pcm[i * 2] + pcm[i * 2 + 1]) / 65536;

const db = (x) => (x <= 1e-7 ? -Infinity : 20 * Math.log10(x));
const fmtDb = (x) => (x === -Infinity ? '  -inf' : x.toFixed(1).padStart(6));

// ── radix-2 FFT ─────────────────────────────────────────────────────────
// In place, and worth having properly: an earlier decimating DFT here silently
// capped the measurable band at ~330 Hz and reported every sound in the pack as
// dark, which would have sent the whole design in the wrong direction.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len >> 1; k++) {
        const ur = re[i + k], ui = im[i + k];
        const xr = re[i + k + (len >> 1)], xi = im[i + k + (len >> 1)];
        const vr = xr * cr - xi * ci, vi = xr * ci + xi * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + (len >> 1)] = ur - vr; im[i + k + (len >> 1)] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const N = 4096;
function spectrum(from) {
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const s = from + i < frames ? mono[from + i] : 0;
    re[i] = s * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))); // Hann
  }
  fft(re, im);
  const mags = new Float32Array(N / 2);
  for (let k = 0; k < N / 2; k++) mags[k] = Math.hypot(re[k], im[k]);
  return mags;
}

function centroid(mags) {
  let num = 0, den = 0;
  for (let k = 1; k < mags.length; k++) { const f = (k * SR) / N; num += f * mags[k]; den += mags[k]; }
  return den > 0 ? num / den : 0;
}

// Fraction of energy above 4 kHz — a decent "is this mostly hiss" detector,
// since broadband noise spreads energy up there and pitched material doesn't.
function highFraction(mags) {
  let hi = 0, all = 0;
  for (let k = 1; k < mags.length; k++) { const f = (k * SR) / N; const m = mags[k] * mags[k]; all += m; if (f > 4000) hi += m; }
  return all > 0 ? hi / all : 0;
}

function rms(from, to) {
  let s = 0; const n = Math.max(1, to - from);
  for (let i = from; i < Math.min(to, frames); i++) s += mono[i] * mono[i];
  return Math.sqrt(s / n);
}

const items = manifest.index.filter((e) => e.kind === 'item');

console.log(`\n${pack} · ${LABEL} — ${manifest.duration.toFixed(1)}s @ ${SR} Hz\n`);
console.log('  item                                  peak    rms   centroid  >4kHz   tail');
console.log('  ' + '─'.repeat(76));

const rows = [];
for (let i = 0; i < items.length; i++) {
  const at = items[i].at;
  const next = i + 1 < items.length ? items[i + 1].at : manifest.duration;
  const from = Math.floor(at * SR);
  const to = Math.min(frames, Math.floor(Math.min(next, at + 9) * SR));
  if (to <= from) continue;

  // Level is measured over the item's WHOLE span, not the first nine seconds.
  // The nine-second cap belongs to the spectral window below (an FFT wants the
  // onset, not a minute of room tone); applying it to peak and RMS reported a
  // sparse ambient bed — silence with an event every twenty seconds — as
  // inaudible, which is exactly the kind of bed most worth measuring.
  const span = Math.min(frames, Math.floor(next * SR));
  let peak = 0;
  for (let n = from; n < span; n++) { const a = Math.abs(mono[n]); if (a > peak) peak = a; }
  const r = rms(from, span);

  const mags = spectrum(from + Math.floor(0.004 * SR));
  const c = centroid(mags);
  const hf = highFraction(mags);

  // "tail" = late energy relative to the onset, in dB — what the room adds
  // after the sound itself has stopped. Measured strictly inside this item's
  // own window: an earlier version ran past the gap and measured the *next*
  // item's onset, which made the dry/wet comparison swing wildly and report
  // reverb failures that weren't real.
  const lateFrom = from + Math.floor(0.35 * SR);
  const lateTo = Math.min(to, from + Math.floor(((items[i].dur ?? 0.5) + 0.45) * SR));
  const onset = rms(from, from + Math.floor(0.10 * SR));
  const late = lateTo - lateFrom > 0.15 * SR ? rms(lateFrom, lateTo) : null;
  const tail = late != null && onset > 0 ? db(late / onset) : null;

  rows.push({ label: items[i].label, peak, rms: r, centroid: c, hf, tail });
  console.log(
    `  ${items[i].label.slice(0, 36).padEnd(36)}${fmtDb(db(peak))} ${fmtDb(db(r))}   ${String(Math.round(c)).padStart(5)} Hz  ${(hf * 100).toFixed(0).padStart(3)}%  ${tail == null ? '   n/a' : fmtDb(tail)}`
  );
}

console.log('\n  findings');
console.log('  ' + '─'.repeat(76));
const flags = [];
for (const r of rows) {
  if (db(r.peak) < -40) flags.push(`inaudible — "${r.label}" peaks at ${db(r.peak).toFixed(1)} dBFS`);
  if (db(r.peak) > -1.0) flags.push(`too hot — "${r.label}" peaks at ${db(r.peak).toFixed(1)} dBFS`);
  if (r.hf > 0.65) flags.push(`mostly high-frequency noise — "${r.label}" has ${(r.hf * 100).toFixed(0)}% of energy above 4 kHz`);
}
const byLabel = new Map(rows.map((r) => [r.label, r]));
for (const r of rows) {
  if (!r.label.endsWith('— dry')) continue;
  const wet = byLabel.get(r.label.replace('— dry', '— in the room'));
  if (!wet) continue;
  if (r.tail == null || wet.tail == null) continue;
  // Only meaningful once the cue itself has stopped. For cues that ring longer
  // than the measurement window (the bell, the koto, the swelling creak) their
  // own decay dominates the late window and the room can't be isolated.
  if (r.tail > -12) continue;
  // Long cues (the bell, the koto) ring for seconds; their own decay swamps the
  // room in the late window, so the comparison says nothing about the reverb.
  const nominal = items.find((it) => it.label === r.label)?.dur ?? 0;
  if (nominal > 1.5) continue;
  const gain = wet.tail - r.tail;
  if (gain < 3) flags.push(`room barely reaching "${r.label.replace(' — dry', '')}" — tail only ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB vs dry`);
}
if (!flags.length) console.log('  nothing automatic to report — needs ears.');
else flags.forEach((f) => console.log('  • ' + f));

// spread of the register plan: cues should NOT all sit in one band
const cueRows = rows.filter((r) => r.label.endsWith('— in the room'));
if (cueRows.length > 2) {
  const cs = cueRows.map((r) => r.centroid).sort((a, b) => a - b);
  console.log(`\n  register spread across cues: ${Math.round(cs[0])} Hz … ${Math.round(cs[cs.length - 1])} Hz (ratio ${(cs[cs.length - 1] / Math.max(1, cs[0])).toFixed(1)}×)`);
  if (cs[cs.length - 1] / Math.max(1, cs[0]) < 2.5) console.log('  ⚠ cues are clustered in one register — they will mask each other when overlaid');
}
console.log();
