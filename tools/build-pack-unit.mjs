// build-pack.mjs against a small staged game. Run: node tools/build-pack-unit.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPack, ROOT_SCRIPT } from "./build-pack.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-pack-"));
const files = {
  "index.html": `<head><link rel="manifest" href="manifest.json"><link rel="preload" href="a/f.woff2" as="font">
<link rel="stylesheet" href="s.css"><style>.x{filter:url(%23n);background:url(a/i.png)}</style>
<script src="/arcade-sdk.js"></script><script type="module" src="/g/main.js"></script></head>`,
  "s.css": "a{background:url(a/i.png)}",
  "main.js": 'import "./dep.js"; const p = import("./dep.js");',
  "dep.js": 'import "./main.js";',
  "manifest.json": "{}",
  "a/i.png": "PNG",
  "a/f.woff2": "F",
  "a/nested/manifest.json": '{"nested":1}',
};
for (const [f, body] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
  fs.writeFileSync(path.join(dir, f), body);
}
const pack = await buildPack(dir, "g");
fs.rmSync(dir, { recursive: true, force: true });
const map = JSON.parse(/<script type="importmap">(.*?)<\/script>/s.exec(pack.html)[1]).imports;
const source = (rel) => Buffer.from(map[`pack/${rel}`].split(",")[1], "base64").toString();

assert.deepEqual(pack.roots, ["/arcade-sdk.js"]);
assert.ok(pack.html.includes(ROOT_SCRIPT("/arcade-sdk.js")));
assert.ok(pack.html.includes('import "pack/main.js"'), "a game's own absolute module path is local");
assert.ok(source("main.js").includes('import "pack/dep.js"'), "static imports are rewritten");
assert.ok(source("main.js").includes('import("pack/dep.js")'), "dynamic imports are rewritten");
assert.ok(source("dep.js").includes('import "pack/main.js"'), "cycles resolve");
assert.ok(!/rel="(manifest|preload)"/.test(pack.html), "manifest and preload links are dropped");
assert.ok(pack.html.includes("url(%23n)"), "an encoded fragment is left alone");
assert.ok(!pack.html.includes("url(a/i.png)"), "stylesheet and inline-style assets are inlined");
assert.ok(pack.html.includes('"a/nested/manifest.json":'), "nested JSON is reachable by fetch");
assert.ok(!pack.html.includes('"manifest.json":'), "the PWA manifest is not an asset");
assert.match(pack.version, /^[0-9a-f]{64}$/);
console.log("  ✓ build-pack");
