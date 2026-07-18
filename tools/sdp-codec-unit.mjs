/* sdp-codec-unit.mjs — hermetic Node unit tests for p2p/sdp-codec.js,
 * centered on the extras trailer that carries the rendezvous exchange nonce
 * `n` (PROTOCOL.md §3.1/§7.4).
 *
 * History this suite pins: pack() used to serialize ONLY {peerId,
 * sessionDesc}, silently dropping `n` — which left the §7.4 offer↔answer
 * replay binding inert on the packed wire path. The fix is a
 * format-1-compatible TRAILER, and the compat story rests on one byte-level
 * property tested here: a payload with extras is a strict prefix-extension
 * of the same payload without them, and decoders stop after the candidate
 * list unless they know the trailer. No browser, no network.
 */
import { SDPCodec } from '../p2p/sdp-codec.js';
import { ConnectionUtils } from '../p2p/p2p-core.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}
function throws(fn, label) {
    try { fn(); ok(false, label + ' (did not throw)'); }
    catch (e) { ok(true, label); }
}

// A minimal but complete datachannel SDP the packer understands.
const FP = Array.from({ length: 32 }, (_, i) => (i * 7 + 3 & 0xff).toString(16).padStart(2, '0').toUpperCase()).join(':');
const SDP = [
    'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=candidate:1 1 udp 2113937151 192.168.1.7 54123 typ host',
    'a=candidate:2 1 udp 1685790463 203.0.113.9 61000 typ srflx',
    'a=ice-ufrag:AbCd',
    'a=ice-pwd:0123456789abcdefghijklmn',
    `a=fingerprint:sha-256 ${FP}`,
    'a=setup:actpass', 'a=mid:0', ''
].join('\r\n');
const PAYLOAD = { peerId: 'peer-A1', sessionDesc: { type: 'offer', sdp: SDP } };
const NONCE = 'a1b2c3d4e5f60718'; // hex(randBytes(8)) shape, like rendezvous mints

function b64urlToBytes(str) {
    let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
function bytesToB64url(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const packedBody = (packed) => b64urlToBytes(packed.split('.')[1]);

function trailerTests() {
    console.log('\nextras trailer — nonce round trip');
    const bare = SDPCodec.pack(PAYLOAD);
    const withN = SDPCodec.pack({ ...PAYLOAD, n: NONCE });

    let out = SDPCodec.unpack(bare);
    ok(!('n' in out), 'a payload packed without a nonce unpacks without one (old senders look like this)');
    ok(out.peerId === 'peer-A1' && out.sessionDesc.type === 'offer', 'bare round trip keeps peerId + type');
    ok(out.sessionDesc.sdp.includes('a=ice-ufrag:AbCd') && out.sessionDesc.sdp.includes(FP), 'bare round trip rebuilds the SDP entropy');

    out = SDPCodec.unpack(withN);
    ok(out.n === NONCE, 'the exchange nonce survives the packed wire path (the §7.4 binding is live again)');
    ok(out.sessionDesc.sdp === SDPCodec.unpack(bare).sessionDesc.sdp, 'the trailer does not perturb the rebuilt SDP');

    const ans = SDPCodec.unpack(SDPCodec.pack({ ...PAYLOAD, sessionDesc: { type: 'answer', sdp: SDP }, n: NONCE }));
    ok(ans.sessionDesc.type === 'answer' && ans.n === NONCE, 'answer flag and nonce coexist');

    ok(SDPCodec.unpack(SDPCodec.pack({ ...PAYLOAD, n: null })).n === undefined
        && !('n' in SDPCodec.unpack(SDPCodec.pack({ ...PAYLOAD, n: undefined }))),
        'null/undefined nonce packs no trailer at all');
}

function compatTests() {
    console.log('\nbackward/forward compatibility — the load-bearing byte property');
    const bare = packedBody(SDPCodec.pack(PAYLOAD));
    const withN = packedBody(SDPCodec.pack({ ...PAYLOAD, n: NONCE }));
    ok(withN.length === bare.length + 2 + NONCE.length, 'trailer costs exactly tag + len + nonce bytes');
    ok(bare.every((b, i) => withN[i] === b), 'payload-with-nonce is a strict prefix-extension of payload-without (an old reader that stops after candidates sees the identical bytes it always did)');
    ok(SDPCodec.pack(PAYLOAD).startsWith('1.'), 'format version stays 1 — no version-gate flag day');

    // A future sender's unknown extra must skip cleanly, before or after ours.
    const unknown = [99, 2, 'z'.charCodeAt(0), 'q'.charCodeAt(0)];
    const nonceTlv = [1, NONCE.length, ...[...NONCE].map(c => c.charCodeAt(0))];
    let crafted = bytesToB64url(new Uint8Array([...bare, ...unknown]));
    ok(!('n' in SDPCodec.unpack(`1.${crafted}`)), 'an unknown extra tag alone is ignored');
    crafted = bytesToB64url(new Uint8Array([...bare, ...unknown, ...nonceTlv]));
    ok(SDPCodec.unpack(`1.${crafted}`).n === NONCE, 'the nonce is still read past an unknown leading extra');
}

function hostileTests() {
    console.log('\nhostile trailers');
    const bare = packedBody(SDPCodec.pack(PAYLOAD));
    let crafted = bytesToB64url(new Uint8Array([...bare, 1, 200, 65, 66])); // declared len 200, 2 bytes present
    throws(() => SDPCodec.unpack(`1.${crafted}`), 'a truncated trailer entry throws (corruption, not silence)');
    crafted = bytesToB64url(new Uint8Array([...bare, 1])); // tag with no length byte
    throws(() => SDPCodec.unpack(`1.${crafted}`), 'a bare trailing tag byte throws');
    crafted = bytesToB64url(new Uint8Array([...bare, 1, 2, 0x0d, 0x0a])); // CR LF as "nonce"
    throws(() => SDPCodec.unpack(`1.${crafted}`), 'control characters in a crafted nonce are rejected (token guard)');
    throws(() => SDPCodec.pack({ ...PAYLOAD, n: 'ñ0t-ascii' }), 'pack refuses a non-ASCII nonce (encodePayload then falls back to deflate, which preserves it)');
    throws(() => SDPCodec.pack({ ...PAYLOAD, n: 'x'.repeat(300) }), 'pack refuses an oversize nonce');
}

async function integrationTests() {
    console.log('\nConnectionUtils integration — both wire paths carry n');
    const enc = await ConnectionUtils.encodePayload({ ...PAYLOAD, n: NONCE });
    ok(SDPCodec.isPacked(enc), 'a normal payload takes the packed path');
    const dec = await ConnectionUtils.decodePayload(enc);
    ok(dec.n === NONCE, 'encodePayload → decodePayload round-trips the nonce (packed)');

    // A shape the packer refuses (non-ASCII nonce) must fall back to deflate
    // and STILL carry the nonce — the drop bug must not resurface there.
    const weird = await ConnectionUtils.encodePayload({ ...PAYLOAD, n: 'ñonce' });
    ok(!SDPCodec.isPacked(weird), 'a payload the packer refuses falls back to legacy deflate');
    ok((await ConnectionUtils.decodePayload(weird)).n === 'ñonce', 'the deflate fallback preserves the nonce too');
}

console.log('SDP codec unit tests — extras trailer, prefix compat, hostile input');
trailerTests();
compatTests();
hostileTests();
await integrationTests();
console.log('');
if (fail) { console.log(fail + ' check(s) FAILED.'); process.exit(1); }
console.log('All ' + pass + ' SDP codec unit checks passed.');
