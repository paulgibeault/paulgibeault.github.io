/* rendezvous-unit.mjs — hermetic Node unit tests for the two rendezvous
 * building blocks that the browser acceptance harnesses architecturally bypass:
 *   • rendezvous-crypto.js  — key schedule + AEAD sealing (WebCrypto only)
 *   • rendezvous-carriers.js `mqttCodec` — MQTT 3.1.1 encode + incremental parse
 *
 * No browser, no network — runs anywhere Node exposes global crypto.subtle
 * (Node 20+). Run: `npm run rendezvous-unit`.
 */
import { RendezvousCrypto as RC } from '../p2p/rendezvous-crypto.js';
import { mqttCodec } from '../p2p/rendezvous-carriers.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}
async function throwsAsync(fn) {
    try { await fn(); return false; } catch (e) { return true; }
}

// base64url <-> bytes via Node Buffer (the module's own helpers aren't exported).
const b64urlToBytes = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const bytesToB64url = (b) => Buffer.from(b).toString('base64url');

async function cryptoTests() {
    console.log('\nrendezvous-crypto');

    const a = RC.randBytes(32), b = RC.randBytes(32);
    const c = RC.randBytes(32), d = RC.randBytes(32);

    // Order independence: both sides derive the same base regardless of order.
    const baseAB = await RC.derivePairBase(a, b);
    const baseBA = await RC.derivePairBase(b, a);
    ok((await RC.keyCheck(baseAB)) === (await RC.keyCheck(baseBA)), 'derivePairBase is order-independent (same keyCheck)');

    // A different pair derives a different base.
    const baseCD = await RC.derivePairBase(c, d);
    ok((await RC.keyCheck(baseAB)) !== (await RC.keyCheck(baseCD)), 'a different pair yields a different base');

    // Bad randoms rejected.
    ok(await throwsAsync(() => RC.derivePairBase(RC.randBytes(31), b)), 'derivePairBase rejects non-32-byte randoms');

    const aead1 = await RC.deriveAeadKey(baseAB);
    const aead2 = await RC.deriveAeadKey(baseCD);

    // Round-trip.
    const pt = JSON.stringify({ peerId: 'p1', n: 'deadbeef', hello: 'world' });
    const sealed = await RC.seal(aead1, pt, 'o', 1);
    ok((await RC.open(aead1, sealed, 'o', 1)) === pt, 'seal/open round-trips (same key, direction, epoch)');

    // Direction binding — an offer must not open as an answer or ring.
    ok((await RC.open(aead1, sealed, 'a', 1)) === null, 'direction binding: offer does not open as answer');
    ok((await RC.open(aead1, sealed, 'r', 1)) === null, 'direction binding: offer does not open as ring');

    // Epoch binding.
    ok((await RC.open(aead1, sealed, 'o', 2)) === null, 'epoch binding: epoch 1 does not open at epoch 2');

    // Wrong key.
    ok((await RC.open(aead2, sealed, 'o', 1)) === null, "another pair's key does not open the blob");

    // Tamper: flip one ciphertext byte.
    const raw = b64urlToBytes(sealed);
    raw[raw.length - 1] ^= 0x01;
    ok((await RC.open(aead1, bytesToB64url(raw), 'o', 1)) === null, 'tampered ciphertext opens to null');

    // Truncated / malformed input.
    ok((await RC.open(aead1, 'AAAB', 'o', 1)) === null, 'too-short blob opens to null');
    ok((await RC.open(aead1, '!!!not base64!!!', 'o', 1)) === null, 'garbage input opens to null (no throw)');

    // aad guards direction.
    ok(await throwsAsync(async () => RC.aad('x', 1)), 'aad() rejects an unknown direction');

    // Topics: deterministic, day-scoped, 32 hex chars.
    const tk = await RC.deriveTopicKey(baseAB);
    const day = '2026-07-14';
    const t1 = await RC.topicForDay(tk, day);
    const t2 = await RC.topicForDay(tk, day);
    const tNext = await RC.topicForDay(tk, '2026-07-15');
    ok(t1 === t2, 'topicForDay is deterministic for a given day');
    ok(t1 !== tNext, 'topicForDay differs across days');
    ok(/^[0-9a-f]{32}$/.test(t1), 'topic is 32 hex chars');
    const tkCD = await RC.deriveTopicKey(baseCD);
    ok((await RC.topicForDay(tkCD, day)) !== t1, 'topics differ across pairs on the same day');

    // confirmMac role asymmetry (reflection resistance).
    const cCaller = await RC.confirmMac(baseAB, 'caller');
    const cListener = await RC.confirmMac(baseAB, 'listener');
    ok(cCaller !== cListener, 'confirmMac is role-bound (caller != listener)');
    ok(await throwsAsync(async () => RC.confirmMac(baseAB, 'nobody')), 'confirmMac rejects an unknown role');

    // Ratchet advances the base.
    const th = await RC.transcriptHash('AA:BB', 'CC:DD');
    const thSwap = await RC.transcriptHash('CC:DD', 'AA:BB');
    ok(Buffer.compare(Buffer.from(th), Buffer.from(thSwap)) === 0, 'transcriptHash is order-independent');
    const ratcheted = await RC.ratchet(baseAB, th);
    ok((await RC.keyCheck(ratcheted)) !== (await RC.keyCheck(baseAB)), 'ratchet produces a new base (different keyCheck)');
}

function codecTests() {
    console.log('\nmqttCodec');

    // Fixed-format control packets.
    const ping = mqttCodec.pingreq();
    ok(ping.length === 2 && ping[0] === 0xC0 && ping[1] === 0, 'pingreq is [0xC0, 0]');
    const conn = mqttCodec.connect('client-x', 60);
    ok(conn[0] === 0x10, 'connect has CONNECT header');
    const sub = mqttCodec.subscribe(1, 'topic/abc');
    ok(sub[0] === 0x82, 'subscribe has SUBSCRIBE header (0x82, QoS1 reserved bit)');

    // Round-trip a publish through the parser.
    const parse = mqttCodec.makeParser();
    const pub = mqttCodec.publish('t/day', 'hello-blob');
    let out = parse(pub);
    ok(out.length === 1 && out[0].type === 'publish' && out[0].topic === 't/day' && out[0].payload === 'hello-blob',
        'parser round-trips a publish (topic + payload)');

    // Split across chunk boundaries: nothing until the packet completes.
    const parse2 = mqttCodec.makeParser();
    const pub2 = mqttCodec.publish('t/split', 'abcdefhij');
    const mid = Math.floor(pub2.length / 2);
    ok(parse2(pub2.subarray(0, mid)).length === 0, 'partial packet yields no output');
    const done = parse2(pub2.subarray(mid));
    ok(done.length === 1 && done[0].payload === 'abcdefhij', 'packet emerges once the second chunk arrives');

    // Multi-byte remaining-length varint (payload > 127 bytes).
    const parse3 = mqttCodec.makeParser();
    const big = 'x'.repeat(500);
    const pub3 = mqttCodec.publish('t/big', big);
    const out3 = parse3(pub3);
    ok(out3.length === 1 && out3[0].payload.length === 500, 'multi-byte varint length parses (500-byte payload)');

    // Oversize packet is discarded, and a following valid packet still parses
    // (frame resync via the skip counter), including across a chunk boundary.
    const parse4 = mqttCodec.makeParser();
    // Hand-build a PUBLISH header declaring 20000 bytes (> 16 KB cap).
    const declaredLen = 20000;
    const varint = [];
    let n = declaredLen;
    do { let bb = n % 128; n = Math.floor(n / 128); if (n > 0) bb |= 0x80; varint.push(bb); } while (n > 0);
    const oversizeHeader = Uint8Array.from([0x30, ...varint]);
    // Feed the header + only PART of its body, then the rest, then a real publish.
    const partialBody = new Uint8Array(5000);
    ok(parse4(oversizeHeader).length === 0 && parse4(partialBody).length === 0, 'oversize packet buffers nothing');
    const restBody = new Uint8Array(declaredLen - 5000);
    parse4(restBody); // consumes the remaining skip
    const after = parse4(mqttCodec.publish('t/resync', 'survived'));
    ok(after.length === 1 && after[0].topic === 't/resync' && after[0].payload === 'survived',
        'stream resyncs after an oversize packet (valid packet still parses)');

    // Recognizes CONNACK / SUBACK / PINGRESP.
    const parse5 = mqttCodec.makeParser();
    ok(parse5(Uint8Array.from([0x20, 2, 0, 0]))[0].type === 'connack', 'parses CONNACK');
    ok(parse5(Uint8Array.from([0x90, 3, 0, 1, 0]))[0].type === 'suback', 'parses SUBACK');
    ok(parse5(Uint8Array.from([0xD0, 0]))[0].type === 'pingresp', 'parses PINGRESP');
}

(async () => {
    console.log('Rendezvous unit tests — crypto + MQTT codec');
    await cryptoTests();
    codecTests();
    console.log('');
    if (fail) { console.log(fail + ' check(s) FAILED.'); process.exit(1); }
    console.log('All ' + pass + ' rendezvous unit checks passed.');
})();
