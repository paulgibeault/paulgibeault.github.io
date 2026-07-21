/* configs-unit.mjs — hermetic tests for the game-config exchange validators
 * (#config-exchange): arcade-configs-core.js (decode / payload / fragment) and
 * arcade-envelope.js's validateConfigsOp. Pins the anchored deep-link parse
 * (rejects trailing junk, #p2p fragments, oversized codes), the launcher-side
 * decode's byte-parity with the SDK's share codec + its prototype-pollution
 * guard, and the hostile-input tables. Auto-discovered by run-units.mjs.
 */
import {
    parseAppFragment, decodeShareCode, validateConfigPayload, validateConfigEnvelope,
    CFG_DATA_MAX
} from '../arcade-configs-core.js';
import { validateConfigsOp } from '../arcade-envelope.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}

// Reproduces the SDK's shareApi.encode exactly (arcade-sdk.js shareEncode) so
// the launcher decode is proven byte-compatible with real SDK output.
function shareEncode(obj, v) {
    const json = JSON.stringify({ v: v >>> 0, d: obj === undefined ? null : obj });
    const bytes = new TextEncoder().encode(json);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

console.log('\nparseAppFragment (anchored, charset-gated)');
ok(parseAppFragment('#app=moon-lit').app === 'moon-lit', 'plain #app parses the id');
ok(parseAppFragment('#app=moon-lit').cfg === null, 'plain #app has null cfg');
const pf = parseAppFragment('#app=sowduku&cfg=AbC-_123');
ok(pf && pf.app === 'sowduku' && pf.cfg === 'AbC-_123', '#app&cfg parses both');
ok(parseAppFragment('#app=x&cfg=' + 'A'.repeat(5000)) === null, 'oversized cfg (>4096) rejected');
ok(parseAppFragment('#p2p-offer=xyz') === null, '#p2p-offer not matched (precedence preserved)');
ok(parseAppFragment('#app=x&evil=1') === null, 'trailing junk rejected (anchored)');
ok(parseAppFragment('#app=x&cfg=has spaces') === null, 'bad cfg charset rejected');
ok(parseAppFragment('#app=a b') === null, 'bad app charset rejected');
ok(parseAppFragment('') === null, 'empty hash → null');
ok(parseAppFragment(null) === null, 'non-string → null');

console.log('\ndecodeShareCode (parity with SDK encode + pollution guard)');
{
    const code = shareEncode({ g: 'moon-lit', t: 'pack', d: { name: 'Weekend', boards: [{ code: 'A1' }] } }, 1);
    const dec = decodeShareCode(code);
    ok(dec && dec.v === 1 && dec.data.g === 'moon-lit' && dec.data.t === 'pack', 'round-trips an SDK-shaped code');
    ok(dec.data.d.boards[0].code === 'A1', 'nested payload preserved');
    ok(decodeShareCode('not valid base64!!') === null, 'bad charset → null');
    ok(decodeShareCode('') === null, 'empty → null');
    ok(decodeShareCode('x'.repeat(9000)) === null, 'oversized → null');
    ok(decodeShareCode(42) === null, 'non-string → null');
    const evil = btoa(JSON.stringify({ v: 1, d: { '__proto__': { polluted: 1 } } })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    decodeShareCode(evil);
    ok(({}).polluted === undefined, 'decode never pollutes Object.prototype');
}

console.log('\nvalidateConfigPayload (transport shape only)');
{
    const ids = new Set(['moon-lit', 'sowduku']);
    ok(validateConfigPayload({ g: 'moon-lit', t: 'pack', d: {} }, 1, ids).g === 'moon-lit', 'valid payload accepted');
    ok(validateConfigPayload({ g: 'unknown', t: 'pack', d: {} }, 1, ids) === null, 'game not in catalog rejected');
    ok(validateConfigPayload({ g: 'moon-lit', t: 'BAD TYPE', d: {} }, 1, ids) === null, 'bad type charset rejected');
    ok(validateConfigPayload({ g: 'moon-lit', t: 'pack' }, 1, ids) === null, 'missing d rejected');
    ok(validateConfigPayload({ g: 'moon-lit', t: 'pack', d: { big: 'x'.repeat(CFG_DATA_MAX) } }, 1, ids) === null, 'oversized d rejected');
    ok(validateConfigPayload({ g: 'moon-lit', t: 'pack', d: {} }, undefined, ids).v === 1, 'missing version defaults to 1');
    ok(validateConfigPayload({ g: 'moon-lit', t: 'pack', d: {} }, 1, ['moon-lit']).g === 'moon-lit', 'array catalog id list works');
    ok(validateConfigPayload('nope', 1, ids) === null, 'non-object rejected');
}

console.log('\nvalidateConfigEnvelope (kind:config peer body)');
{
    const ids = new Set(['moon-lit']);
    ok(validateConfigEnvelope({ arcade: 1, kind: 'config', v: 1, g: 'moon-lit', t: 'pack', d: {} }, ids).t === 'pack', 'valid envelope accepted');
    ok(validateConfigEnvelope({ g: 'unknown', t: 'pack', d: {} }, ids) === null, 'envelope game not in catalog rejected');
    ok(validateConfigEnvelope({ g: 'moon-lit', t: 'pack', d: { big: 'x'.repeat(20000) } }, ids) === null, 'oversized envelope rejected');
}

console.log('\nvalidateConfigsOp (arcade:configs.op shape gate)');
ok(validateConfigsOp({ id: 'r1', op: 'share', code: 'AbC123_-' }).op === 'share', 'share op accepted');
ok(validateConfigsOp({ id: 'r1', op: 'share', code: 'has spaces' }) === null, 'bad code charset rejected');
ok(validateConfigsOp({ id: 'r1', op: 'share', code: 'A'.repeat(5000) }) === null, 'oversized code rejected');
ok(validateConfigsOp({ op: 'share', code: 'A' }) === null, 'missing id rejected');
ok(validateConfigsOp({ id: 'r1', op: 'send', t: 'pack', d: {} }).op === 'send', 'send op accepted');
ok(validateConfigsOp({ id: 'r1', op: 'send', t: 'BAD', d: {} }) === null, 'send bad type rejected');
ok(validateConfigsOp({ id: 'r1', op: 'send', t: 'pack' }) === null, 'send missing d rejected');
ok(validateConfigsOp({ id: 'r1', op: 'nope' }) === null, 'unknown op rejected');

console.log('');
if (fail) { console.log('✗ configs-unit: ' + fail + ' of ' + (pass + fail) + ' checks FAILED'); process.exit(1); }
console.log('✓ configs-unit: all ' + pass + ' checks passed');
