/* caps-contract-unit.mjs — pins the launcher↔SDK compatibility contract.
 *
 * There is deliberately no version number on the arcade:* wire: welcome.caps
 * is THE compat contract (GAME_INTEGRATION.md §14). This suite pins the
 * shipped list against a literal so no edit to arcade-router.js can change
 * the contract silently, and cross-checks the docs so the published contract
 * can't drift from the code. The end-to-end half (the list actually arriving
 * through a real sandboxed frame, and the SDK degrading under an older
 * launcher's reduced caps) lives in tools/acceptance.mjs checks 11–12.
 *
 * Changing EXPECTED_CAPS is a deliberate contract change: additive caps are
 * fine (append here + document in GAME_INTEGRATION.md §14 in the same PR);
 * REMOVING or RENAMING a cap breaks deployed games that feature-detect it.
 *
 * No browser, no network. Run: `node tools/caps-contract-unit.mjs`.
 */
import { readFile } from 'node:fs/promises';
import { ARCADE_PEER_CAPS } from '../arcade-router.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}

// The contract, spelled out. Order is part of the pin only to keep diffs
// honest — the SDK treats caps as a set.
const EXPECTED_CAPS = ['peer.sendTo', 'peer.roster', 'peer.meta', 'storage.bridge', 'ui.bridge'];

console.log('caps contract — welcome.caps is the launcher↔SDK compat contract');

console.log('\nshipped list pin');
ok(Array.isArray(ARCADE_PEER_CAPS), 'ARCADE_PEER_CAPS is exported as an array');
ok(ARCADE_PEER_CAPS.length === EXPECTED_CAPS.length
    && EXPECTED_CAPS.every((c, i) => ARCADE_PEER_CAPS[i] === c),
    `list matches the pinned contract exactly [${EXPECTED_CAPS.join(', ')}]`);
ok(new Set(ARCADE_PEER_CAPS).size === ARCADE_PEER_CAPS.length, 'no duplicate caps');
ok(ARCADE_PEER_CAPS.every((c) => typeof c === 'string' && /^[a-z]+\.[a-zA-Z]+$/.test(c)),
    'every cap is a namespaced string (area.feature)');
ok(Object.isFrozen(ARCADE_PEER_CAPS), 'the exported list is frozen (no runtime mutation)');

console.log('\ndoc drift — every shipped cap is documented');
const gameDoc = await readFile(new URL('../GAME_INTEGRATION.md', import.meta.url), 'utf8');
const platDoc = await readFile(new URL('../ARCADE_PLATFORM.md', import.meta.url), 'utf8');
for (const cap of ARCADE_PEER_CAPS) {
    ok(gameDoc.includes(cap), `GAME_INTEGRATION.md documents '${cap}'`);
    ok(platDoc.includes(cap), `ARCADE_PLATFORM.md documents '${cap}'`);
}
ok(gameDoc.includes('welcome.caps'), 'GAME_INTEGRATION.md names welcome.caps as the contract');

console.log('');
if (fail) { console.log(fail + ' check(s) FAILED.'); process.exit(1); }
console.log('All ' + pass + ' caps-contract checks passed.');
