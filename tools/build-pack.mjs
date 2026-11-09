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
import { init, parse } from "es-module-lexer";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".gif": "image/gif", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4" };

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
    if (!isLocal(u)) return m;
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
  // The import map must precede every module, so it goes first in <head>.
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + map) : map + html;
  return { html, roots: [...roots] };
}
