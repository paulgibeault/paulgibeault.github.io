#!/usr/bin/env node
// Offline sound-pack renderer.
//
// Runs the pack's graphs in headless Chromium's OfflineAudioContext and writes
// a single audition WAV plus a timestamped index. The graph code injected here
// is the shipped /arcade-audio.js itself, so the audition and the game run the
// same code — no mockup-versus-shipped gap.
//
//   node tools/soundpack/render.mjs --config <app>/soundpack.config.json
//
// Sections render independently and are concatenated with silence between, so
// reverb tails never spill across a boundary and no single render has to hold
// the whole piece in memory.
//
// ── what "reproducible" does and does not mean here ──────────────────────
//
// The PACK is fully seeded: every cue draws from `rng(seed)`, there is no
// Math.random(), Date or other entropy anywhere in the render path, and the
// same seed always produces the same scheduled graph. That is the guarantee
// the design depends on, and it holds.
//
// The RENDER is not bit-reproducible. Chromium's OfflineAudioContext gives
// last-bit-different output between runs once enough sources sum concurrently:
// measured deterministic at 4 concurrent oscillators, nondeterministic at 8+
// (oscillators, buffer sources, biquads, compressors and convolvers are all
// individually bit-exact, within a process and across processes — it is the
// concurrent fan-in that does it, presumably summation order). Across a full
// 27M-sample audition this shows up as ~300 samples differing by exactly
// 1 LSB: -90 dBFS peak, ~109 dB under the signal, and inaudible.
//
// The practical consequence: DO NOT compare auditions with `shasum`. It reports
// a difference every time and cannot answer "did my change to the shared
// element library affect this pack?". Use the differ, which measures the
// difference and knows what the noise floor looks like:
//
//   node tools/soundpack/wavdiff.mjs A.wav B.wav --manifest A.manifest.json
//
// It exits 0 when the delta is within run-to-run noise and 1 when the sound
// actually changed, so it can gate CI.

// playwright is imported lazily, AFTER the arguments are validated — see the
// dynamic import further down. A top-level import would make `render.mjs` with
// no arguments die on a missing module instead of printing usage, and would
// couple the no-browser unit tier (which runs before `npm install` in CI) to a
// browser toolchain it deliberately does not have.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const configFlag = flag('config', null);
if (!configFlag) {
  console.error(`sound-pack renderer

  node tools/soundpack/render.mjs --config <path/to/soundpack.config.json>
                                  [--audition <key>] [--label <name>]
                                  [--sr 48000] [--out <dir>]

The config lives in the app that owns the pack, and every path inside it
resolves relative to the config file. This tool has no notion of which apps
exist and no default config — point it at one.

  {
    "name": "my-app",
    "pack": "js/soundpack.js",
    "auditions": { "full": "audio/audition.js", "short": "audio/audition-short.js" },
    "out": "audio/auditions/out",
    "sampleRate": 48000
  }

  --audition  key into "auditions" (default: the first one declared)
  --label     output basename suffix (default: the audition key)
              → <out>/<name>-<label>.{wav,INDEX.md,manifest.json}`);
  process.exit(2);
}

const CONFIG_PATH = resolve(configFlag);
const CONFIG_DIR = dirname(CONFIG_PATH);
let config;
try { config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
catch (e) { console.error(`render: cannot read config ${CONFIG_PATH}: ${e.message}`); process.exit(2); }

const fromConfig = (p) => resolve(CONFIG_DIR, p);
const required = (key) => {
  if (!config[key]) { console.error(`render: config is missing required "${key}"`); process.exit(2); }
  return config[key];
};

const packName = required('name');
const auditions = required('auditions');
const auditionKeys = Object.keys(auditions);
if (!auditionKeys.length) { console.error('render: config declares no auditions'); process.exit(2); }

const auditionKey = flag('audition', auditionKeys[0]);
if (!auditions[auditionKey]) {
  console.error(`render: no audition '${auditionKey}' in config (have: ${auditionKeys.join(', ')})`);
  process.exit(2);
}

const LABEL = flag('label', auditionKey);
const SR = parseInt(flag('sr', String(config.sampleRate || 48000)), 10);
const OUT_DIR = resolve(flag('out', fromConfig(config.out || 'out')));

// The SHIPPED element library and the SHIPPED audition archetypes — not copies.
// Injecting the same arcade-audio.js the launcher serves is what makes an
// approved audition bit-identical to what plays in the app.
const graphSrc = readFileSync(join(HERE, '..', '..', 'arcade-audio.js'), 'utf8');
const auditionLibSrc = readFileSync(join(HERE, 'lib', 'audition.js'), 'utf8');
// The pack and the timeline both belong to the app that ships them. A copy kept
// here would drift from the one actually playing, which defeats the point of
// auditioning at all.
const packPath = fromConfig(required('pack'));
const auditionPath = fromConfig(auditions[auditionKey]);
const packSrc = readFileSync(packPath, 'utf8');
const auditionSrc = readFileSync(auditionPath, 'utf8');

console.log(`sound-pack renderer — ${packName} · ${auditionKey} → ${LABEL} @ ${SR} Hz`);
console.log(`  config   ${CONFIG_PATH}`);
console.log(`  pack     ${packPath}`);
console.log(`  audition ${auditionPath}`);

// Everything above this line is pure argument/config handling, so a bad
// invocation reports itself without needing a browser installed.
const { chromium } = await import('playwright');

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => { console.error('page error:', e.message); });

// Order matters only for the pack: registerPack() needs the element library.
// The archetype library resolves the pack lazily, so it may load either side.
await page.evaluate((src) => { (0, eval)(src); }, graphSrc);
await page.evaluate((src) => { (0, eval)(src); }, auditionLibSrc);
await page.evaluate((src) => { (0, eval)(src); }, packSrc);
await page.evaluate((src) => { (0, eval)(src); }, auditionSrc);

const ready = await page.evaluate(() => ({ pack: !!globalThis.ArcadeSoundPack, plan: !!globalThis.PACK }));
if (!ready.pack) {
  console.error(`render: ${packPath} did not register a pack.\n` +
    '  The pack file must end with ArcadeAudioElements.registerPack({ name, ROOM, SENDS, CUES }).');
  await browser.close(); process.exit(1);
}
if (!ready.plan) {
  console.error(`render: ${auditionPath} did not publish a timeline.\n` +
    '  The audition must end with ArcadeAudition.publish({ gap, tail, sections }).');
  await browser.close(); process.exit(1);
}

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
    const S = globalThis.ArcadeAudioElements;
    const section = P.SECTIONS[si];

    // Two passes: measure item durations first (a cue reports its own length),
    // then render for real into a correctly sized context.
    const probe = new OfflineAudioContext(2, Math.ceil(SR * 0.1), SR);
    const probeBus = S.createBus(probe, probe.destination, P.ROOM);
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
    const bus = S.createBus(ctx, ctx.destination, P.ROOM);
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
const wavPath = join(OUT_DIR, `${packName}-${LABEL}.wav`);
writeFileSync(wavPath, Buffer.concat([header, ...chunks.map((c) => Buffer.from(c.pcm.buffer, c.pcm.byteOffset, c.pcm.byteLength))]));

// ── write the index ─────────────────────────────────────────────────────
// Tenths matter: items are often under a second apart, and a whole-second
// timestamp puts two different sounds at the same mark.
const mmss = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
let md = `# ${packName} sound pack — audition ${LABEL}\n\n`;
md += `\`${packName}-${LABEL}.wav\` · ${mmss(cursor)} · ${SR} Hz stereo\n\n`;
md += `Generated by \`tools/soundpack/render.mjs\`. Timestamps below are exact — quote one when something is wrong ("1:12 is too bright") and it can be fixed without re-auditioning the rest.\n\n`;
for (const e of index) {
  if (e.kind === 'section') {
    md += `\n## ${mmss(e.at)} — ${e.title}\n\n`;
    if (e.note) md += `${e.note}\n\n`;
  } else {
    md += `- \`${mmss(e.at)}\` ${e.label}\n`;
  }
}
const idxPath = join(OUT_DIR, `${packName}-${LABEL}.INDEX.md`);
writeFileSync(idxPath, md);

// Machine-readable manifest, so analyze.mjs can measure each item in isolation.
const manifestPath = join(OUT_DIR, `${packName}-${LABEL}.manifest.json`);
writeFileSync(manifestPath,
  JSON.stringify({ pack: packName, label: LABEL, audition: auditionKey, sampleRate: SR, duration: cursor, index }, null, 1));

console.log(`\n  ${wavPath}`);
console.log(`  ${idxPath}`);
console.log(`  ${mmss(cursor)} total\n`);
