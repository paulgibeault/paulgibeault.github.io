// release.json: the manifest behind the launcher's pinned-release updates
// (plans/offline-first-2026-11.md). Written from the staged artifact, last, so
// the hashes describe the bytes that actually deploy.
//
// The hashes are what make an update all-or-nothing across a deploy: a player
// who downloads mid-publish gets a mismatch and an aborted update, not a
// launcher assembled from two builds.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Write `dir/release.json` for the precache `entries` of this artifact. */
export function writeRelease(dir, entries) {
  if (!entries) return null;
  const sw = fs.readFileSync(path.join(dir, "sw.js"), "utf8");
  const version = (/^const APP_VERSION = '([^']+)';$/m.exec(sw) || [])[1];
  if (!version) throw new Error("sw.js has no APP_VERSION line; cannot write release.json");

  const assets = {};
  for (const entry of entries) {
    const rel = entry === "./" ? "index.html" : entry.slice(2);
    assets[entry] = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, rel))).digest("hex");
  }
  // Icons belong to each game's repo and deploy on its own schedule, so they
  // are listed without hashes and fetched best-effort.
  const catalog = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json"), "utf8"));
  const icons = (catalog.games || []).map((g) => g && g.icon)
    .filter((i) => typeof i === "string" && i)
    .map((i) => "./" + i.replace(/^\.?\//, ""));

  const release = { version, assets, icons };
  fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify(release));
  return release;
}
