// An app that never reads the setting. Several fleet apps don't — they consume
// the CSS token and nothing else — so Gate C must not assert that it found any
// calls. A `calls.length > 0` assertion makes the gate unrunnable fleet-wide.
export function init() {
  document.documentElement.dataset.ready = 'true';
}
