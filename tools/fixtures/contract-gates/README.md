# contract-gates fixtures

Run by `node tools/contract-gates.mjs --self-test`.

Everything under `pass/` is an idiom a fleet repo **actually ships**, quoted
verbatim with its source noted in a comment. A gate that rejects one of these
turns a clean repo red for no reason, which is worse than no gate at all — the
first thing anyone does with a gate that cries wolf is stop reading it.

Everything under `fail/` is a planted violation, named `gate-<a|b|c>-…` for the
gate it must trip. The self-test checks that **that specific gate** fired, not
merely that something did: a Gate B typo inside a Gate A fixture would
otherwise read as a pass.

These files are deliberate violations. They live under `tools/`, which the
gate's own dev-set exclusion already skips, so the launcher never scans them as
if they were shipped code.

## What each pass fixture is defending

| fixture | the trap it pins |
|---|---|
| `guards-ternary.js` | the plain `X.powerSaver ? X.powerSaver() : false` read, three repos |
| `guards-typeof.js` | the multi-line `typeof … === 'function' &&` form, spanning three lines |
| `guards-alias.js` | a guard through an **aliased receiver** (`s.powerSaver`), where the literal `Arcade.settings.powerSaver` never appears at the call site |
| `guards-in-html.html` | an app that ships its whole game inside `index.html` — invisible to a `*.js`-only scan, and two fleet apps are built this way |
| `counts.css` | every legitimate count shape: `1 !important` kill switches, a bare `1` power-saver override, and the token |
| `counts-multivalue.css` | a stacked list — `1, var(--arcade-pulse-count, 3)` — which a whole-declaration comparison wrongly flags |
| `shorthand-multiline.css` | a multi-line `animation:` shorthand with no `infinite`, so Gate A's whole-file window doesn't over-match |
| `prose-about-the-rule.css` | a CSS comment quoting `animation-iteration-count: 1 !important` and the word "infinite", as three repos' comments do |
| `prose-in-script.html` | a **JS** comment inside `<script>` quoting the CSS declaration, which no CSS-comment stripper would remove |
| `no-reads-at-all.js` | an app that never reads the setting — four fleet apps don't, so the gate must not assert it found any calls |
