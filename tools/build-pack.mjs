// A game's offline pack: its whole staged artifact as one srcdoc document, so a
// sandboxed launcher frame needs no network (plans/offline-first-2026-11.md).
//
// Modules become data: URLs behind an import map because that is what loads in
// an opaque-origin frame in both Chromium and WebKit; blob URLs do not. Module
// specifiers are rewritten to bare `pack/...` names rather than to each other's
// data: URLs so that import cycles still resolve.
//
// Launcher-root scripts (/arcade-sdk.js and friends) become placeholders that
// the launcher fills from its pinned release when it mounts the game.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { init, parse } from "./vendor/es-module-lexer.js";
import { artifactFiles } from "./inject-precache.mjs";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".gif": "image/gif", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4" };

// Files a game can reach only by a name built at runtime (fetch, new Image).
// Code is excluded because the document already carries it.
const NOT_ASSET = /^(sw\.js|manifest\.json|LICENSE|NOTICE)$|\.(js|mjs|html|css|map|md)$/i;

// Runs before anything else in the frame and answers those lookups from the
// pack. Anything it doesn't hold goes to the network as usual.
const shim = (assets, gameId) => `<script>(function(){
var A=${JSON.stringify(assets).replace(/<\//g, "<\\/")},O=${JSON.stringify("/" + gameId + "/")};
function hit(u){try{var s=String(u&&u.url||u);if(/^(data|blob):/i.test(s))return null;
var p=new URL(s,"http://pack.invalid/").pathname;if(p.indexOf(O)===0)p=p.slice(O.length);else p=p.slice(1);
return A[decodeURIComponent(p)]||null}catch(e){return null}}
var f=window.fetch;window.fetch=function(u,o){var h=hit(u);return f.call(window,h||u,h?undefined:o)};
[HTMLImageElement,HTMLMediaElement,HTMLSourceElement].forEach(function(C){
var d=Object.getOwnPropertyDescriptor(C.prototype,"src");if(!d)return;
Object.defineProperty(C.prototype,"src",{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){d.set.call(this,hit(v)||v)}})});
var sa=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){
return sa.call(this,n,String(n).toLowerCase()==="src"&&/^(img|audio|video|source)$/i.test(this.tagName)?(hit(v)||v):v)};
})();</script>`;

export const ROOT_SCRIPT = (src) => `<!--arcade:root ${src}-->`;
const isLocal = (u) => !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(u);
const dataUrl = (mime, buf) => `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
const safeInline = (s) => s.replace(/<\/(script|style)/gi, "<\\/$1");

export async function buildPack(dir, gameId) {
  await init;
  // A game may name its own files root-relative (/<gameId>/js/x.js).
  const own = `/${gameId}/`;
  const localise = (u) => u.startsWith(own) ? u.slice(own.length) : u;
  const read = (rel) => fs.readFileSync(path.join(dir, rel));
  const modules = new Map();

  const rewrite = (src, fromRel) => {
    const [imports] = parse(src);
    let out = "";
    let at = 0;
    for (const i of imports) {
      const spec = i.n && localise(i.n);
      if (!spec || !isLocal(spec)) continue;   // non-literal dynamic import, or not ours
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec.split("?")[0]));
      addModule(target);
      out += src.slice(at, i.s) + (i.d > -1 ? JSON.stringify(`pack/${target}`) : `pack/${target}`);
      at = i.e;
    }
    return out + src.slice(at);
  };
  const addModule = (rel) => {
    if (modules.has(rel)) return;
    modules.set(rel, null);
    modules.set(rel, dataUrl("text/javascript", rewrite(read(rel).toString("utf8"), rel)));
  };
  const inlineCss = (css, fromRel) => css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, _q, raw) => {
    const u = localise(raw);
    if (!isLocal(u) || /^%23/i.test(u)) return m;
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), u.split(/[?#]/)[0]));
    return `url("${dataUrl(MIME[path.extname(rel)] || "application/octet-stream", read(rel))}")`;
  });

  let html = read("index.html").toString("utf8");
  const roots = new Set();
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = /\brel=["']?([^"'\s>]+)/i.exec(tag)?.[1];
    const rawHref = /\bhref=["']?([^"'\s>]+)/i.exec(tag)?.[1];
    const href = rawHref && localise(rawHref);
    if (rel === "manifest" || rel === "icon") return "";
    if (rel === "preload" && href && isLocal(href)) return "";
    if (rel === "stylesheet" && href && isLocal(href)) {
      const file = href.split("?")[0];
      return `<style>${safeInline(inlineCss(read(file).toString("utf8"), file))}</style>`;
    }
    return tag;
  });
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, css, close) =>
    open + inlineCss(css, "index.html") + close);
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (tag, attrs, body) => {
    const rawSrc = /\bsrc=["']?([^"'\s>]+)/i.exec(attrs)?.[1];
    const src = rawSrc && localise(rawSrc);
    const isModule = /\btype=["']?module/i.test(attrs);
    if (src && !isLocal(src)) {
      if (src.startsWith("/")) { roots.add(src.split("?")[0]); return ROOT_SCRIPT(src.split("?")[0]); }
      return tag;
    }
    if (src) {
      const file = src.split("?")[0];
      if (isModule) { addModule(file); return `<script type="module">import "pack/${file}";</script>`; }
      return `<script>${safeInline(read(file).toString("utf8"))}</script>`;
    }
    return isModule ? `<script type="module">${safeInline(rewrite(body, "index.html"))}</script>` : tag;
  });
  html = html.replace(/(<(?:img|audio|source)\b[^>]*\bsrc=)(["'])([^"']+)\2/gi, (m, pre, q, u) => {
    if (!isLocal(u)) return m;
    const file = u.split(/[?#]/)[0];
    return `${pre}${q}${dataUrl(MIME[path.extname(file)] || "application/octet-stream", read(file))}${q}`;
  });

  const imports = Object.fromEntries([...modules].map(([rel, url]) => [`pack/${rel}`, url]));
  const map = `<script type="importmap">${JSON.stringify({ imports })}</script>`;
  const assets = Object.fromEntries(artifactFiles(dir).filter((f) => !NOT_ASSET.test(f))
    .map((f) => [f, dataUrl(MIME[path.extname(f)] || (f.endsWith(".json") ? "application/json" : "application/octet-stream"), read(f))]));
  // The import map must precede every module, and the shim every script.
  const head = map + shim(assets, gameId);
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + head) : head + html;
  const version = crypto.createHash("sha256").update(html).update(JSON.stringify([...roots])).digest("hex");
  return { html, roots: [...roots], version };
}

// fleet-ci.yml: node build-pack.mjs <stagedDir> <gameId>
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [dir, gameId] = process.argv.slice(2);
  if (!dir || !gameId) { console.error("usage: node build-pack.mjs <stagedDir> <gameId>"); process.exit(1); }
  const pack = await buildPack(dir, gameId);
  fs.writeFileSync(path.join(dir, "arcade-pack.json"), JSON.stringify(pack));
  fs.writeFileSync(path.join(dir, "arcade-pack.version.json"), JSON.stringify({ version: pack.version }));
  console.log(`pack for ${gameId}: ${Math.round(pack.html.length / 1024)} KB`);
}
