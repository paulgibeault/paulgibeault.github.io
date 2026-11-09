// The real staged launcher and worker, driven through a player's update life:
// first visit, a deploy they didn't ask for, a broken update, a good update,
// and airplane mode. Served on a non-loopback name because the launcher
// disables its worker on loopback.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { stage, PRECACHE_EXCLUDE } from "./stage.mjs";
import { precacheList } from "./inject-precache.mjs";
import { writeRelease } from "./write-release.mjs";
import { buildPack } from "./build-pack.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offline-launcher-"));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".wasm": "application/wasm" };

function build(version) {
  const dir = path.join(tmp, version);
  stage(dir);
  const sw = path.join(dir, "sw.js");
  fs.writeFileSync(sw, fs.readFileSync(sw, "utf8").replace(/^const APP_VERSION = '[^']*';$/m, `const APP_VERSION = '${version}';`));
  fs.appendFileSync(path.join(dir, "index.html"), `\n<!--build:${version}-->\n`);
  writeRelease(dir, precacheList(dir, PRECACHE_EXCLUDE));
  return dir;
}

// The fixture game, published under a real catalog id so the launcher offers it.
const GAME = JSON.parse(fs.readFileSync(new URL("../catalog.json", import.meta.url), "utf8")).games[0].id;
const gameDir = path.join(tmp, "game");
fs.cpSync(new URL("./fixtures/starter-app", import.meta.url), gameDir, { recursive: true });
const gameIndex = path.join(gameDir, "index.html");
fs.writeFileSync(gameIndex, fs.readFileSync(gameIndex, "utf8").replaceAll("starter-app", GAME));
const packJson = JSON.stringify(await buildPack(gameDir, GAME));

let live = build("1.0.0");
const requests = [];
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]);
  requests.push(p);
  if (p === `/${GAME}/arcade-pack.json`) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(packJson);
  }
  const file = path.join(live, p.endsWith("/") ? p + "index.html" : p);
  if (!file.startsWith(live) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "max-age=0" });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
// *.localhost is a secure context, and is not the bare name the launcher skips.
const origin = `http://arcade.localhost:${port}`;

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

let failed = 0;
function check(name, cond, detail = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failed++;
}
const build_ = () => page.evaluate(() => {
  for (const n of document.childNodes) if (n.nodeType === 8 && n.data.startsWith("build:")) return n.data.slice(6);
  const w = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
  let found = null;
  while (w.nextNode()) if (w.currentNode.data.startsWith("build:")) found = w.currentNode.data.slice(6);
  return found;
});
const pin = () => page.evaluate(async () => {
  const hit = await (await caches.open("paul-arcade-release")).match("__release-pin");
  return hit ? (await hit.json()).version : null;
});
const tag = () => page.locator("#menu-update-status").textContent();
const accept = async () => {
  await page.locator("#launcher-menu-toggle").click();
  await page.locator("#menu-update").click();
  await page.getByRole("button", { name: "Install", exact: true }).click();
};

try {
  await page.goto(origin + "/");
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 30000 });
  await page.waitForFunction(async () => (await caches.keys()).includes("paul-arcade-release"));
  check("first visit pins the deployed release", (await pin()) === "1.0.0", await pin());

  live = build("2.0.0");
  requests.length = 0;
  await page.reload();
  check("a deploy does not change what loads", (await build_()) === "1.0.0", await build_());
  check("the shell never touched the network", !requests.includes("/index.html") && !requests.includes("/"), requests.join(" "));
  await page.waitForFunction(() => document.querySelector("#menu-update-status").textContent === "update ready", null, { timeout: 15000 });
  check("a new build is flagged", true);
  check("the check raises no dialog", (await page.getByRole("button", { name: "Install", exact: true }).count()) === 0);
  check("the check downloads nothing", !requests.includes("/arcade-sdk.js") && !requests.includes("/styles.css"), requests.join(" "));

  const good = fs.readFileSync(path.join(live, "styles.css"));
  fs.appendFileSync(path.join(live, "styles.css"), "/* corrupt */");
  await accept();
  await page.waitForFunction(() => document.querySelector("#menu-update-status").textContent === "update ready", null, { timeout: 15000 });
  check("a corrupt download aborts", (await pin()) === "1.0.0", await pin());
  await page.reload();
  check("the old release still boots after an abort", (await build_()) === "1.0.0", await build_());

  fs.writeFileSync(path.join(live, "styles.css"), good);
  await Promise.all([page.waitForEvent("load", { timeout: 30000 }), accept()]);
  check("an accepted update lands", (await pin()) === "2.0.0" && (await build_()) === "2.0.0", `${await pin()} ${await build_()}`);
  check("the old release is cleaned up", !(await page.evaluate(() => caches.keys())).includes("paul-arcade-v1.0.0"));

  await page.waitForFunction(async (g) => {
    const c = await caches.open("arcade-packs");
    return !!(await c.match(`__pack/${g}`));
  }, GAME, { timeout: 20000 });
  check("the game's pack is stored for offline", true);

  await context.setOffline(true);
  await page.reload();
  check("airplane mode boots the launcher", (await build_()) === "2.0.0", await build_());
  check("airplane mode renders the game grid", await page.waitForFunction(
    () => document.querySelectorAll(".launcher-grid > *").length > 0, null, { timeout: 10000 }).then(() => true, () => false));

  await page.evaluate((g) => { location.hash = `#app=${g}`; location.reload(); }, GAME);
  const frame = page.locator(`iframe[data-game-id="${GAME}"]`);
  await frame.waitFor({ state: "attached", timeout: 15000 });
  await page.waitForFunction((g) => document.querySelector(`iframe[data-game-id="${g}"]`).hasAttribute("srcdoc"), GAME, { timeout: 10000 });
  check("the game mounts from its pack", true);
  check("the frame keeps its opaque-origin sandbox", (await frame.getAttribute("sandbox")) === "allow-scripts allow-downloads");
  await page.waitForFunction(() => document.querySelector("#game-loading").classList.contains("hidden"), null, { timeout: 15000 });
  check("the game finishes its handshake in airplane mode", !(await page.locator("#game-error").isVisible()));
} catch (e) {
  failed++;
  console.log("  ✗ threw: " + e.message.split("\n")[0]);
} finally {
  await browser.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
