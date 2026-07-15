/* main.js — Starter App starter app.
 *
 * A tiny but complete example of the Arcade SDK contract:
 *   • await Arcade.ready before reading state (bridged storage isn't live until
 *     the launcher handshake resolves; standalone it resolves on a timeout)
 *   • persist through Arcade.state / Arcade.stats — NEVER raw localStorage
 *     (the launcher namespaces + exports only arcade.v1.<gameId>.* keys)
 *   • re-hydrate on suspend/resume and on save-import (onStateReplaced)
 *   • let the SDK apply launcher settings (font scale, theme) for free
 */

const els = {
  player: document.getElementById('player'),
  tap: document.getElementById('tap'),
  count: document.getElementById('count'),
  best: document.getElementById('best'),
  context: document.getElementById('context'),
};

let sessionCount = 0;

function render() {
  els.count.textContent = String(sessionCount);
  els.best.textContent = String(Arcade.stats.get('taps')?.best ?? 0);
  els.player.textContent = Arcade.player.name() || 'player';
}

async function boot() {
  // Framed apps must wait for the welcome handshake before touching state.
  await Arcade.ready;

  // A one-time write so the app always has at least one arcade.v1.<id>.* key
  // (and so a fresh install shows up in a save export). getOrInit deep-merges.
  const prefs = Arcade.state.getOrInit('prefs', { firstSeen: Date.now() });
  Arcade.stats.getOrInit('taps', { best: 0, total: 0 });

  els.context.textContent = Arcade.context.framed ? 'running in the launcher' : 'standalone';
  render();

  els.tap.addEventListener('click', () => {
    sessionCount += 1;
    // stats.update takes prev → next; the SDK persists the result.
    Arcade.stats.update('taps', (s) => ({
      best: Math.max(s.best, sessionCount),
      total: s.total + 1,
    }));
    Arcade.state.set('lastSession', { count: sessionCount, at: Date.now() });
    render();
  });

  // Keep the greeting current if the player renames themselves in the launcher.
  Arcade.player.onChange(render);
  // A save-import replaced our state wholesale — re-read everything.
  Arcade.onStateReplaced(render);

  // Suspend/resume fire on launcher quit/relaunch AND on tab visibility, so a
  // real game would pause timers/audio here. We just note it and re-render.
  Arcade.onSuspend(() => { /* pause work here */ });
  Arcade.onResume(render);

  void prefs;
}

boot();
