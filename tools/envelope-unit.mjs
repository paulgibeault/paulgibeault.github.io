/* envelope-unit.mjs — hermetic Node unit tests for the shared wire-envelope
 * validators (#59):
 *   • arcade-envelope.js — deviceId pattern, dunder/shape helpers, transport
 *     envelope classifier, toast normalizer
 *   • p2p/p2p-core.js `ConnectionUtils.validatePayload` — the signaling-payload
 *     gate, tested in place (the p2p/ tree stays import-self-contained)
 *   • arcade-sync-core.js `HLC_RE` — composed from DEVICE_ID_PATTERN; guarded
 *     here against pattern drift
 *
 * No browser, no network. Run: `npm run envelope-unit`.
 */
import {
    DEVICE_ID_PATTERN,
    DEVICE_ID_RE,
    isDeviceId,
    isDunderKey,
    isPlainObject,
    isCappedString,
    validatePeerEnvelope,
    validateToast,
    validateUiOp
} from '../arcade-envelope.js';
import { ConnectionUtils } from '../p2p/p2p-core.js';
import { HLC_RE, hlcPack } from '../arcade-sync-core.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}
function throwsWith(fn, message) {
    try { fn(); return false; } catch (e) { return e.message === message; }
}

const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';

function deviceIdTests() {
    console.log('\ndeviceId pattern');
    ok(isDeviceId(UUID), 'accepts a fixed uuid literal');
    ok(isDeviceId(crypto.randomUUID()), 'accepts crypto.randomUUID() output');
    ok(isDeviceId(UUID.toUpperCase()), 'accepts uppercase uuid (case-insensitive)');
    ok(isDeviceId('dev-a1b2c3'), 'accepts dev- with 6-char tail (minimum)');
    ok(isDeviceId('dev-' + 'a'.repeat(50)), 'accepts dev- with 50-char tail (maximum)');
    // The exact shape both minting sites' fallback produces
    // (arcade-p2p.js randomDeviceId / arcade-sync.js randomDeviceId).
    ok(isDeviceId('dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36)),
        'accepts the dev- fallback minting shape');
    ok(!isDeviceId(null), 'rejects non-string');
    ok(!isDeviceId(''), 'rejects empty string');
    ok(!isDeviceId('dev-abc12'), 'rejects dev- with 5-char tail');
    ok(!isDeviceId('dev-' + 'a'.repeat(51)), 'rejects dev- with 51-char tail');
    ok(!isDeviceId('g1b2c3d4-e5f6-7890-abcd-ef0123456789'), 'rejects uuid with non-hex digit');
    ok(!isDeviceId('x'.repeat(65)), 'rejects 65-char string');
    ok(!isDeviceId('__proto__'), 'rejects __proto__');
    ok(!isDeviceId('x\n' + UUID), 'rejects multiline smuggle (anchors are not multiline)');
    ok(!isDeviceId(UUID + '\nx'), 'rejects trailing-newline smuggle');
}

function helperTests() {
    console.log('\nshape helpers');
    ok(isDunderKey('__proto__') && isDunderKey('constructor') && isDunderKey('prototype'),
        'isDunderKey hits all three');
    ok(!isDunderKey('proto') && !isDunderKey('__proto') && !isDunderKey(''),
        'isDunderKey misses near-misses');
    ok(isPlainObject({}) && !isPlainObject([]) && !isPlainObject(null) && !isPlainObject('x'),
        'isPlainObject: object yes; array/null/string no');
    ok(isCappedString('abc', 3) && !isCappedString('abcd', 3) && !isCappedString(3, 10),
        'isCappedString boundary + non-string');
}

function signalPayloadTests() {
    console.log('\nsignaling payload (ConnectionUtils.validatePayload, tested in place)');
    const desc = { type: 'offer', sdp: 'v=0...' };
    ok(ConnectionUtils.validatePayload({ peerId: 'p', sessionDesc: desc }).peerId === 'p',
        'valid payload passes through');
    ok(throwsWith(() => ConnectionUtils.validatePayload(null),
        'Invalid payload: expected a plain object'), 'null rejected');
    ok(throwsWith(() => ConnectionUtils.validatePayload([1]),
        'Invalid payload: expected a plain object'), 'array rejected');
    ok(throwsWith(() => ConnectionUtils.validatePayload('str'),
        'Invalid payload: expected a plain object'), 'string rejected');
    ok(throwsWith(() => ConnectionUtils.validatePayload({ sessionDesc: desc }),
        'Invalid payload: missing required field "peerId"'), 'missing peerId rejected');
    ok(throwsWith(() => ConnectionUtils.validatePayload({ peerId: 'p', sessionDesc: { type: 'offer' } }),
        'Invalid payload: sessionDesc must have string fields "type" and "sdp"'),
        'sessionDesc without sdp rejected');
    ok(throwsWith(() => ConnectionUtils.validatePayload({ peerId: 'p', sessionDesc: { type: 1, sdp: 's' } }),
        'Invalid payload: sessionDesc must have string fields "type" and "sdp"'),
        'sessionDesc with non-string type rejected');
    ok(throwsWith(() => ConnectionUtils.validatePayload({ a: 1 }, ['a', 'b']),
        'Invalid payload: missing required field "b"'), 'custom requiredFields honored');
    // Historical behavior: sessionDesc is only structurally checked when present
    // AND truthy; a required-but-falsy sessionDesc passes the field check.
    ok(ConnectionUtils.validatePayload({ peerId: 'p', sessionDesc: null }).peerId === 'p',
        'null sessionDesc passes (field present, structural check skipped)');
}

function peerEnvelopeTests() {
    console.log('\ntransport envelope classifier');
    ok(!validatePeerEnvelope(null).ok, 'null rejected');
    ok(!validatePeerEnvelope([]).ok, 'array rejected');
    ok(validatePeerEnvelope({ arcade: '1', gameId: 'g' }).reason === 'not-arcade',
        'string discriminator rejected (no coercion)');
    ok(validatePeerEnvelope({ arcade: 2, gameId: 'g' }).reason === 'not-arcade',
        'wrong version rejected');
    ok(validatePeerEnvelope({ arcade: 1, kind: 'presence' }).reason === 'bad-gameId',
        'presence without gameId rejected');
    ok(validatePeerEnvelope({ arcade: 1, kind: 'presence', gameId: 'g' }).kind === 'presence',
        'presence classified');
    ok(validatePeerEnvelope({ arcade: 1, kind: 'presence-ack', gameId: 'g' }).kind === 'presence',
        'presence-ack classified as presence');
    ok(validatePeerEnvelope({ arcade: 1, kind: 'sync' }).kind === 'sync',
        'sync passes structurally (body owned by validateSyncEnvelope)');
    ok(validatePeerEnvelope({ arcade: 1, kind: 'backup' }).kind === 'backup',
        'backup passes structurally (body owned by validateBackupEnvelope)');
    ok(validatePeerEnvelope({ arcade: 1, kind: 'backup', gameId: 'g' }).kind === 'backup',
        'backup with a smuggled gameId still classifies as backup, never game');
    ok(validatePeerEnvelope({ arcade: 1, kind: 'identity', deviceId: 'evil<script>' }).reason === 'bad-deviceId',
        'identity with malformed deviceId rejected');
    ok(validatePeerEnvelope({ arcade: 1, kind: 'identity', deviceId: UUID }).kind === 'identity',
        'identity with uuid deviceId classified');
    ok(validatePeerEnvelope({ arcade: 1 }).reason === 'bad-gameId',
        'kindless frame without gameId rejected');
    ok(validatePeerEnvelope({ arcade: 1, gameId: 'g', payload: {} }).kind === 'game',
        'kindless frame with gameId is a game frame');
    // Deliberate fall-through: an UNKNOWN kind with a string gameId routes as
    // a game frame (historical router behavior — do not "fix").
    ok(validatePeerEnvelope({ arcade: 1, kind: 'future-kind', gameId: 'g' }).kind === 'game',
        'unknown kind falls through to game routing');
    ok(validatePeerEnvelope({ arcade: 1, gameId: 'g', fromDevice: 12345 }).ok,
        'malformed fromDevice does NOT reject (attribution is routing, not shape)');
}

function toastTests() {
    console.log('\ntoast normalizer');
    ok(validateToast(null) === null, 'null data → null');
    ok(validateToast({}) === null, 'missing message → null');
    ok(validateToast({ message: '' }) === null, 'empty message → null');
    ok(validateToast({ message: 42 }) === null, 'non-string message → null');
    const t1 = validateToast({ message: 'hi' });
    ok(t1 && t1.kind === 'info' && t1.duration === 2500, 'defaults: kind info, duration 2500');
    ok(validateToast({ message: 'hi', kind: 'sparkle' }).kind === 'info', 'unknown kind → info');
    for (const k of ['info', 'success', 'warning', 'error']) {
        ok(validateToast({ message: 'hi', kind: k }).kind === k, 'kind ' + k + ' passes through');
    }
    ok(validateToast({ message: 'hi', duration: 0 }).duration === 2500, 'duration 0 → default');
    ok(validateToast({ message: 'hi', duration: -5 }).duration === 2500, 'negative duration → default');
    ok(validateToast({ message: 'hi', duration: '9' }).duration === 2500, 'non-number duration → default');
    ok(validateToast({ message: 'hi', duration: 400 }).duration === 400, 'positive duration passes');
}

function uiOpTests() {
    console.log('\nui.op normalizer');
    ok(validateUiOp(null) === null, 'null data → null');
    ok(validateUiOp({}) === null, 'missing op → null');
    ok(validateUiOp({ op: 'destroy' }) === null, 'unknown op → null');

    // RPC ops require a plausible id.
    ok(validateUiOp({ op: 'confirm', message: 'hi' }) === null, 'confirm without id → null');
    ok(validateUiOp({ op: 'confirm', id: '', message: 'hi' }) === null, 'empty id → null');
    ok(validateUiOp({ op: 'confirm', id: 'r'.repeat(65), message: 'hi' }) === null, '65-char id → null');
    ok(validateUiOp({ op: 'confirm', id: 'r1' }) === null, 'confirm without message → null');
    const c1 = validateUiOp({ op: 'confirm', id: 'r1', message: 'Sure?' });
    ok(c1 && c1.okLabel === 'OK' && c1.cancelLabel === 'Cancel', 'confirm label defaults');
    ok(validateUiOp({ op: 'confirm', id: 'r1', message: 'x'.repeat(600) }).message.length === 500,
        'confirm message clipped to 500');
    ok(validateUiOp({ op: 'confirm', id: 'r1', message: 'm', okLabel: 'y'.repeat(30) }).okLabel.length === 24,
        'okLabel clipped to 24');
    ok(validateUiOp({ op: 'confirm', id: 'r1', message: 'm', okLabel: 7 }).okLabel === 'OK',
        'non-string okLabel → default');

    const p1 = validateUiOp({ op: 'prompt', id: 'r2', message: 'Name?', value: 'bob' });
    ok(p1 && p1.value === 'bob', 'prompt carries default value');
    ok(validateUiOp({ op: 'prompt', id: 'r2', message: 'Name?' }).value === '', 'prompt value defaults empty');
    // The security property is structural: the normalized shape has no
    // inputType at all, so a game can never reach the password-masked input.
    ok(!('inputType' in validateUiOp({ op: 'prompt', id: 'r2', message: 'm', inputType: 'password' })),
        'inputType is never passed through (dialog-spoof guard)');

    ok(validateUiOp({ op: 'openFile', id: 'r3' }).accept === '', 'openFile accept defaults empty');
    ok(validateUiOp({ op: 'openFile', id: 'r3', accept: '.png, image/*' }).accept === '.png, image/*',
        'openFile accept passes the input alphabet');
    ok(validateUiOp({ op: 'openFile', id: 'r3', accept: '"><script>' }).accept === '',
        'openFile accept outside alphabet dropped');
    ok(validateUiOp({ op: 'openFile', id: 'r3', accept: 'a'.repeat(201) }).accept === '',
        'openFile accept over 200 chars dropped');

    ok(validateUiOp({ op: 'share', id: 'r4' }) === null, 'share with no content → null');
    const s1 = validateUiOp({ op: 'share', id: 'r4', text: 'come play', url: 'https://x.test/g' });
    ok(s1 && s1.url === 'https://x.test/g', 'share keeps http(s) url');
    ok(validateUiOp({ op: 'share', id: 'r4', text: 't', url: 'javascript:alert(1)' }).url === '',
        'share drops javascript: url, keeps the share');
    ok(validateUiOp({ op: 'share', id: 'r4', text: 't', url: 'not a url' }).url === '',
        'share drops unparseable url');
    ok(validateUiOp({ op: 'share', id: 'r4', text: 'x'.repeat(3000) }).text.length === 2000,
        'share text clipped to 2000');

    // Fire-and-forget ops need no id.
    ok(validateUiOp({ op: 'setTitle', title: 'Journal — draft' }).title === 'Journal — draft',
        'setTitle passes title');
    ok(validateUiOp({ op: 'setTitle' }).title === '', 'setTitle without title → reset op');
    ok(validateUiOp({ op: 'setTitle', title: 'x'.repeat(100) }).title.length === 80,
        'setTitle clipped to 80');
    ok(validateUiOp({ op: 'quitHook', enabled: true }).enabled === true, 'quitHook enabled');
    ok(validateUiOp({ op: 'quitHook', enabled: 'yes' }).enabled === false,
        'quitHook coerces only literal true');
}

function crossModuleConsistencyTests() {
    console.log('\ncross-module consistency');
    // Guards accidental drift of the shared pattern from its historical form
    // (which arcade-sdk.js still carries as a synced literal — see its
    // DEVICE_ID_RE comment).
    const HISTORICAL =
        '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|dev-[a-z0-9]{6,50})$';
    ok(DEVICE_ID_RE.source === HISTORICAL, 'DEVICE_ID_RE matches the historical literal');
    ok(DEVICE_ID_RE.flags === 'i', 'DEVICE_ID_RE stays case-insensitive, not multiline');
    ok(HLC_RE.source === '^\\d{13}:\\d{4}:' + DEVICE_ID_PATTERN + '$',
        'HLC_RE composes DEVICE_ID_PATTERN');
    ok(HLC_RE.test(hlcPack(1751500000000, 0, UUID)), 'HLC_RE accepts packed uuid stamp');
    ok(HLC_RE.test(hlcPack(1751500000000, 3, 'dev-abc123')), 'HLC_RE accepts packed dev- stamp');
    ok(!HLC_RE.test(hlcPack(1751500000000, 0, 'nonsense')), 'HLC_RE rejects malformed deviceId');
}

console.log('Envelope unit tests — shared wire-envelope validators (#59)');
deviceIdTests();
helperTests();
signalPayloadTests();
peerEnvelopeTests();
toastTests();
uiOpTests();
crossModuleConsistencyTests();
console.log('');
if (fail) { console.log(fail + ' check(s) FAILED.'); process.exit(1); }
console.log('All ' + pass + ' envelope unit checks passed.');
