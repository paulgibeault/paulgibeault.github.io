#!/usr/bin/env node
// Offline sound-pack renderer.
//
// Runs the pack's graphs in headless Chromium's OfflineAudioContext and writes
// a single audition WAV plus a timestamped index. The graph code is injected
// verbatim and is the SAME code a browser runtime would execute, so what you
// hear in the WAV is what would ship — there is no mockup-versus-shipped gap.
//
//   node tools/soundpack/render.mjs [packName] [--sr 48000] [--out DIR]
//
// Sections render independently and are concatenated with silence between, so
// reverb tails never spill across a boundary and no single render has to hold
// the whole piece in memory.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const packName = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true) || 'moon-lit';
const SR = parseInt(flag('sr', '48000'), 10);
const OUT_DIR = resolve(flag('out', join(HERE, 'out')));
const VERSION = flag('version', 'v1');

const graphSrc = readFileSync(join(HERE, 'lib', 'graph.js'), 'utf8');
const packSrc = readFileSync(join(HERE, 'packs', `${packName}.js`), 'utf8');

console.log(`sound-pack renderer — ${packName} ${VERSION} @ ${SR} Hz`);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => { console.error('page error:', e.message); });

await page.evaluate((src) => { (0, eval)(src); }, graphSrc);
await page.evaluate((src) => { (0, eval)(src); }, packSrc);

const plan = await page.evaluate(() => {
  const P = globalThis.PACK;
  return {
    name: P.name,
    sections: P.SECTIONS.map((s) => ({
      title: s.title,
      note: s.note || '',
      items: s.items.map((it) => ({ label: it.label, cue: it.cue || null })),
    })),
  };
});

const totalItems = plan.sections.reduce((n, s) => n + s.items.length, 0);
console.log(`  ${plan.sections.length} sections, ${totalItems} items`);

// ── render each section ─────────────────────────────────────────────────
const chunks = [];   // { pcm: Int16Array interleaved, frames }
const index = [];    // { kind, title/label, note, at }
let cursor = 0;      // seconds into the finished file

const SECTION_GAP = 1.6;

function pushSilence(sec) {
  const frames = Math.round(sec * SR);
  chunks.push({ pcm: new Int16Array(frames * 2), frames });
  cursor += frames / SR;
}

for (let si = 0; si < plan.sections.length; si++) {
  const sec = plan.sections[si];
  process.stdout.write(`  [${si + 1}/${plan.sections.length}] ${sec.title} … `);

  const rendered = await page.evaluate(async ({ si, SR }) => {
    const P = globalThis.PACK;
    const S = globalThis.SP;
    const section = P.SECTIONS[si];

    // Two passes: measure item durations first (a cue reports its own length),
    // then render for real into a correctly sized context.
    const probe = new OfflineAudioContext(2, Math.ceil(SR * 0.1), SR);
    const probeBus = S.createBus(probe, P.ROOM);
    const durs = section.items.map((it, i) => {
      if (it.dur != null) return it.dur;
      const r = S.rng(9000 + si * 100 + i);
      const o = S.out(probeBus, 0);
      return P.CUES[it.cue](probe, o, 0, it.params || null, r) || 1.0;
    });

    const marks = [];
    let t = 0;
    for (let i = 0; i < section.items.length; i++) {
      marks.push(t);
      t += durs[i] + P.GAP;
    }
    const total = t + P.TAIL;

    const ctx = new OfflineAudioContext(2, Math.ceil(total * SR), SR);
    const bus = S.createBus(ctx, P.ROOM);
    section.items.forEach((it, i) => {
      const r = S.rng(9000 + si * 100 + i);
      if (it.build) {
        it.build(ctx, bus, marks[i], r);
      } else {
        const o = S.out(bus, it.send === undefined ? null : it.send);
        P.CUES[it.cue](ctx, o, marks[i], it.params || null, r);
      }
    });

    const buf = await ctx.startRendering();
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    const n = buf.length;

    // Interleave to 16-bit PCM in the page; transferring raw Float32 back
    // through CDP would be four times the bytes for no benefit.
    const pcm = new Int16Array(n * 2);
    let peak = 0;
    for (let i = 0; i < n; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > peak) peak = a; if (b > peak) peak = b; }
    for (let i = 0; i < n; i++) {
      pcm[i * 2] = Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767)));
      pcm[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767)));
    }
    let bin = '';
    const bytes = new Uint8Array(pcm.buffer);
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
    }
    return { b64: btoa(bin), frames: n, marks, durs, peak: +peak.toFixed(4) };
  }, { si, SR });

  const bytes = Buffer.from(rendered.b64, 'base64');
  chunks.push({ pcm: new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2), frames: rendered.frames });

  index.push({ kind: 'section', title: sec.title, note: sec.note, at: cursor });
  sec.items.forEach((it, i) => {
    index.push({ kind: 'item', label: it.label, at: cursor + rendered.marks[i], dur: rendered.durs[i] });
  });
  cursor += rendered.frames / SR;

  const clip = rendered.peak >= 0.999 ? '  ⚠ CLIPPING' : '';
  console.log(`${(rendered.frames / SR).toFixed(1)}s  peak ${rendered.peak}${clip}`);

  if (si < plan.sections.length - 1) pushSilence(SECTION_GAP);
}

await browser.close();

// ── write the WAV ───────────────────────────────────────────────────────
const totalFrames = chunks.reduce((n, c) => n + c.frames, 0);
const dataBytes = totalFrames * 2 * 2;
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + dataBytes, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);       // PCM
header.writeUInt16LE(2, 22);       // stereo
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 2 * 2, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(dataBytes, 40);

mkdirSync(OUT_DIR, { recursive: true });
const wavPath = join(OUT_DIR, `${packName}-${VERSION}.wav`);
writeFileSync(wavPath, Buffer.concat([header, ...chunks.map((c) => Buffer.from(c.pcm.buffer, c.pcm.byteOffset, c.pcm.byteLength))]));

// ── write the index ─────────────────────────────────────────────────────
// Tenths matter: items are often under a second apart, and a whole-second
// timestamp puts two different sounds at the same mark.
const mmss = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
let md = `# ${packName} sound pack — audition ${VERSION}\n\n`;
md += `\`${packName}-${VERSION}.wav\` · ${mmss(cursor)} · ${SR} Hz stereo\n\n`;
md += `Generated by \`tools/soundpack/render.mjs\`. Timestamps below are exact — quote one when something is wrong ("1:12 is too bright") and it can be fixed without re-auditioning the rest.\n\n`;
for (const e of index) {
  if (e.kind === 'section') {
    md += `\n## ${mmss(e.at)} — ${e.title}\n\n`;
    if (e.note) md += `${e.note}\n\n`;
  } else {
    md += `- \`${mmss(e.at)}\` ${e.label}\n`;
  }
}
const idxPath = join(OUT_DIR, `${packName}-${VERSION}.INDEX.md`);
writeFileSync(idxPath, md);

// Machine-readable manifest, so analyze.mjs can measure each item in isolation.
writeFileSync(join(OUT_DIR, `${packName}-${VERSION}.manifest.json`),
  JSON.stringify({ pack: packName, version: VERSION, sampleRate: SR, duration: cursor, index }, null, 1));

console.log(`\n  ${wavPath}`);
console.log(`  ${idxPath}`);
console.log(`  ${mmss(cursor)} total\n`);
