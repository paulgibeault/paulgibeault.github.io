#!/usr/bin/env node
// Compare two audition WAVs numerically.
//
//   node tools/soundpack/wavdiff.mjs A.wav B.wav [--manifest A.manifest.json]
//
// Why this exists instead of `shasum`: the renderer is NOT bit-reproducible
// between runs (see the note in render.mjs). Two renders of identical code
// differ in the last bit on a handful of samples, so a checksum comparison
// reports a false positive every time and cannot answer the question you
// actually have — "did my change to the shared element library affect this
// pack?"
//
// This answers it by measuring the difference instead. The number that matters
// is the peak: a run-to-run artifact is 1 LSB (-90 dBFS at 16-bit), while any
// real audio change is orders of magnitude above that. Pass --manifest and it
// also names the audition items the differences land in, which turns "something
// moved" into "the carousel cue moved".
//
// Exit code is 0 when the difference is within the run-to-run noise floor and 1
// when it is not, so this can gate CI.

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

if (files.length !== 2) {
  console.error('usage: wavdiff.mjs A.wav B.wav [--manifest A.manifest.json] [--threshold LSB]');
  process.exit(2);
}

// Anything at or below this peak difference is indistinguishable from the
// renderer's own run-to-run variation. Measured at 1 LSB across a full
// 27M-sample audition; 2 gives a little headroom without hiding a real change,
// since the quietest audible edit moves hundreds of LSB.
const THRESHOLD = parseInt(flag('threshold', '2'), 10);

function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`not a RIFF/WAVE file: ${path}`);
  }
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = { channels: b.readUInt16LE(off + 10), sampleRate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    } else if (id === 'data') {
      data = new Int16Array(b.buffer, b.byteOffset + off + 8, Math.floor(size / 2));
    }
    off += 8 + size + (size & 1); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error(`missing fmt/data chunk: ${path}`);
  if (fmt.bits !== 16) throw new Error(`only 16-bit PCM supported, got ${fmt.bits}-bit: ${path}`);
  return { ...fmt, data };
}

const A = readWav(files[0]);
const B = readWav(files[1]);

if (A.sampleRate !== B.sampleRate || A.channels !== B.channels) {
  console.error(`format mismatch: ${A.sampleRate}Hz/${A.channels}ch vs ${B.sampleRate}Hz/${B.channels}ch`);
  process.exit(2);
}

const db = (x) => (x <= 0 ? -Infinity : 20 * Math.log10(x / 32768));
const fmtDb = (x) => (x <= 0 ? '   -inf' : db(x).toFixed(1).padStart(7));

const n = Math.min(A.data.length, B.data.length);
const truncated = A.data.length !== B.data.length;

let peak = 0, sumSq = 0, refSq = 0, ndiff = 0;
const hotspots = [];   // sample index of each differing frame, for manifest mapping
for (let i = 0; i < n; i++) {
  const d = Math.abs(A.data[i] - B.data[i]);
  if (d > 0) { ndiff++; if (hotspots.length < 100000) hotspots.push(i); }
  if (d > peak) peak = d;
  sumSq += d * d;
  refSq += A.data[i] * A.data[i];
}

const frames = Math.floor(n / A.channels);
const secs = (i) => i / A.channels / A.sampleRate;
const mmss = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

console.log(`\n  A  ${files[0]}`);
console.log(`  B  ${files[1]}`);
console.log(`     ${A.sampleRate} Hz · ${A.channels}ch · ${mmss(frames / A.sampleRate)}`);
if (truncated) {
  console.log(`\n  ⚠ LENGTH MISMATCH — ${A.data.length} vs ${B.data.length} samples; compared the shorter.`);
}

console.log(`\n  differing samples  ${ndiff} of ${n} (${((ndiff / n) * 100).toFixed(4)}%)`);
console.log(`  peak difference    ${peak} LSB  (${fmtDb(peak)} dBFS)`);
console.log(`  rms  difference    ${fmtDb(Math.sqrt(sumSq / n))} dBFS`);
console.log(`  signal rms         ${fmtDb(Math.sqrt(refSq / n))} dBFS`);

// Locate the differences against the audition index, so a real change points at
// the cue that caused it rather than at a timestamp you then have to look up.
const manifestPath = flag('manifest', null);
if (manifestPath && hotspots.length) {
  const man = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const items = man.index.filter((e) => e.kind === 'item');
  const hits = new Map();
  for (const h of hotspots) {
    const t = secs(h);
    // last item whose start is at or before t
    let lo = 0, hi = items.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid].at <= t) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (found >= 0) {
      const it = items[found];
      hits.set(it.label, (hits.get(it.label) || 0) + 1);
    }
  }
  const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`\n  where the differences land:`);
  for (const [label, count] of ranked) {
    console.log(`    ${String(count).padStart(6)}  ${label}`);
  }
  if (hits.size > ranked.length) console.log(`    … and ${hits.size - ranked.length} more item(s)`);
}

const clean = peak <= THRESHOLD && !truncated;
console.log(
  clean
    ? `\n  ✅ within the run-to-run noise floor (peak ≤ ${THRESHOLD} LSB) — no audible change\n`
    : `\n  ❌ real difference (peak ${peak} LSB > ${THRESHOLD}) — this changed the sound\n`,
);
process.exit(clean ? 0 : 1);
