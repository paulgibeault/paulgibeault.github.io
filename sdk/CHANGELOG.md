# Arcade SDK changelog

The SDK publishes at two launcher-origin URLs:

- **`/sdk/v<major>/arcade-sdk.js`** — major-pinned. This URL keeps serving its
  major line even after a breaking major ships, so a pinned game can never be
  bricked by a launcher deploy. **Games should pin this URL.**
- **`/arcade-sdk.js`** — evergreen alias, always the newest major. Kept for
  the existing fleet and for casual standalone use.

`/arcade-sdk.js` (repo root) is the canonical source file; `sdk/v<major>/` is
a byte-identical checked-in copy while that major is current.
`tools/sdk-version-unit.mjs` gates the whole scheme in CI: copy in sync,
`SDK_SEMVER` major == `VERSION` == newest changelog entry's major, no
directory for an unshipped major.

**Release procedure** (any behavior-visible SDK change):

1. Edit `/arcade-sdk.js`; bump `SDK_SEMVER` (patch = fix, minor = additive
   feature, major = breaking — see below).
2. `cp arcade-sdk.js sdk/v3/arcade-sdk.js` (current major's directory).
3. Add an entry at the top of this file.
4. Bump `CACHE_NAME` in `sw.js` (both SDK paths are precached).

**Breaking change (new major N)**: the old directory `sdk/v<N-1>/` is frozen
as-is (its last release keeps serving forever), `VERSION`/`SDK_SEMVER` bump to
`N.0.0`, a new `sdk/v<N>/` directory is created, and the evergreen alias moves
with it. Compatibility is still negotiated at runtime by `welcome.caps` —
semver is for humans and URLs, never checked on the wire.

---

## 3.0.0 — 2026-07-17

First versioned release. Establishes the `/sdk/v3/` pinned path, the evergreen
alias contract, and this changelog. Adds `Arcade.context.sdkVersion` (the
semver string). No behavior changes otherwise: v3 is the SDK generation that
introduced bridged storage mode (opaque-origin frames), already fleet-wide.
