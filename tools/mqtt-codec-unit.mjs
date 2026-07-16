/* mqtt-codec-unit.mjs — hermetic Node unit tests for the hand-rolled MQTT
 * 3.1.1 codec in p2p/rendezvous-carriers.js (#61, the compensating control
 * from the #21 standardization roadmap: the codec parses bytes from untrusted
 * public brokers below the AEAD layer, so every malformed-input class must be
 * rejected without an exception escaping feed() and without wedging or
 * growing the stream buffer).
 *
 * rendezvous-unit.mjs keeps its original resync coverage; this suite is the
 * dedicated exhaustive one. No browser, no network. Run: `npm run mqtt-codec-unit`.
 */
import { mqttCodec } from '../p2p/rendezvous-carriers.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}
function noThrow(fn, label) {
    try { const v = fn(); ok(true, label); return v; }
    catch (e) { ok(false, label + ' (threw: ' + e.message + ')'); return null; }
}

// Local replicas of the module's unexported encode helpers (established
// precedent: rendezvous-unit.mjs replicates encodeVarint the same way).
function varint(n) {
    const out = [];
    do {
        let b = n % 128;
        n = Math.floor(n / 128);
        if (n > 0) b |= 0x80;
        out.push(b);
    } while (n > 0);
    return out;
}
function packet(header, body) {
    return new Uint8Array([header, ...varint(body.length), ...body]);
}
const te = new TextEncoder();
function pubBody(topic, payload, packetId) {
    const t = te.encode(topic);
    const mid = packetId === undefined ? [] : [(packetId >> 8) & 0xff, packetId & 0xff];
    return [ (t.length >> 8) & 0xff, t.length & 0xff, ...t, ...mid, ...te.encode(payload) ];
}
const MAX_PACKET_BYTES = 16 * 1024; // mirror of the parser's inbound cap

function roundTripTests() {
    console.log('\nround trips (encoders → parser)');
    let p = mqttCodec.makeParser()(mqttCodec.publish('a/b', 'hello'));
    ok(p.length === 1 && p[0].type === 'publish' && p[0].topic === 'a/b' && p[0].payload === 'hello',
        'publish round-trips topic + payload');
    p = mqttCodec.makeParser()(mqttCodec.publish('t', ''));
    ok(p.length === 1 && p[0].type === 'publish' && p[0].payload === '', 'empty payload round-trips');
    p = mqttCodec.makeParser()(mqttCodec.publish('', 'x'));
    ok(p.length === 1 && p[0].type === 'publish' && p[0].topic === '' && p[0].payload === 'x',
        'empty topic round-trips');
    p = mqttCodec.makeParser()(mqttCodec.publish('qrp2p/r/v1/日本語', 'påylöad→'));
    ok(p.length === 1 && p[0].topic === 'qrp2p/r/v1/日本語' && p[0].payload === 'påylöad→',
        'multibyte UTF-8 topic and payload survive');
    const two = new Uint8Array([...mqttCodec.publish('t1', 'p1'), ...mqttCodec.publish('t2', 'p2')]);
    p = mqttCodec.makeParser()(two);
    ok(p.length === 2 && p[0].topic === 't1' && p[1].topic === 't2', 'two packets in one chunk, in order');
    ok(mqttCodec.connect('cid')[0] === 0x10, 'connect header byte');
    ok(mqttCodec.subscribe(1, 't')[0] === 0x82, 'subscribe header byte (QoS-0 request)');
    ok(mqttCodec.pingreq()[0] === 0xC0 && mqttCodec.pingreq()[1] === 0, 'pingreq fixed bytes');
    ok(mqttCodec.disconnect()[0] === 0xE0 && mqttCodec.disconnect()[1] === 0, 'disconnect fixed bytes');
}

function varintEdgeTests() {
    console.log('\nremaining-length varint edges');
    const cases = [
        [0, [0]], [127, [127]], [128, [0x80, 1]], [16383, [0xff, 0x7f]],
        [16384, [0x80, 0x80, 1]], [268435455, [0xff, 0xff, 0xff, 0x7f]]
    ];
    for (const [n, bytes] of cases) {
        ok(JSON.stringify(varint(n)) === JSON.stringify(bytes), 'varint(' + n + ') encodes ' + JSON.stringify(bytes));
    }
    // Parser accepts remaining lengths at the interesting boundaries. The cap
    // is `len > MAX_PACKET_BYTES`, so exactly-16384 must still parse.
    for (const len of [127, 128, 16383, MAX_PACKET_BYTES]) {
        const body = pubBody('t', 'x'.repeat(len - 3)); // 2 (topicLen) + 1 (topic) + payload
        const p = mqttCodec.makeParser()(packet(0x30, body));
        ok(p.length === 1 && p[0].type === 'publish' && p[0].payload.length === len - 3,
            'remaining length ' + len + ' parses');
    }
    // One past the cap: discarded, and the stream resyncs onto a valid packet.
    const over = packet(0x30, pubBody('t', 'x'.repeat(MAX_PACKET_BYTES - 2)));
    const feed = mqttCodec.makeParser();
    let p = feed(over);
    ok(p.length === 0, 'remaining length ' + (MAX_PACKET_BYTES + 1) + ' discarded');
    p = feed(mqttCodec.publish('after', 'ok'));
    ok(p.length === 1 && p[0].topic === 'after', 'stream resyncs after oversize discard');
}

function splitReassemblyTests() {
    console.log('\nsplit-chunk reassembly');
    const whole = mqttCodec.publish('topic/x', 'payload-y');
    let feed = mqttCodec.makeParser();
    let interim = 0, got = [];
    for (let i = 0; i < whole.length; i++) {
        const out = feed(whole.subarray(i, i + 1));
        if (i < whole.length - 1) interim += out.length;
        else got = out;
    }
    ok(interim === 0, 'byte-at-a-time: every intermediate feed returns []');
    ok(got.length === 1 && got[0].topic === 'topic/x' && got[0].payload === 'payload-y',
        'byte-at-a-time: final byte yields the packet');

    // Split inside a 2-byte varint (remaining length 300 needs two bytes).
    const big = packet(0x30, pubBody('t', 'x'.repeat(295)));
    feed = mqttCodec.makeParser();
    let out = feed(big.subarray(0, 2)); // header + first varint byte only
    ok(out.length === 0, 'split inside the varint buffers');
    out = feed(big.subarray(2));
    ok(out.length === 1 && out[0].payload.length === 295, 'varint completes across chunks');

    // Split inside the topic-length prefix.
    const tp = mqttCodec.publish('ab', 'cd');
    feed = mqttCodec.makeParser();
    out = feed(tp.subarray(0, 3)); // header, varint, first topicLen byte
    ok(out.length === 0, 'split inside the topic-length prefix buffers');
    out = feed(tp.subarray(3));
    ok(out.length === 1 && out[0].topic === 'ab' && out[0].payload === 'cd',
        'topic-length prefix completes across chunks');

    // Oversize packet split across three chunks, then a valid packet.
    const huge = packet(0x30, pubBody('t', 'x'.repeat(MAX_PACKET_BYTES + 500)));
    feed = mqttCodec.makeParser();
    const third = Math.floor(huge.length / 3);
    ok(feed(huge.subarray(0, third)).length === 0
        && feed(huge.subarray(third, 2 * third)).length === 0
        && feed(huge.subarray(2 * third)).length === 0, 'oversize split across three chunks yields nothing');
    out = feed(mqttCodec.publish('alive', 'yes'));
    ok(out.length === 1 && out[0].topic === 'alive', 'skip-counter resync after split oversize');
}

function malformedInputTests() {
    console.log('\nmalformed input (reject without throwing or hanging)');
    let p = noThrow(() => mqttCodec.makeParser()(packet(0x00, [1, 2, 3])), 'unknown packet type 0x00 feeds cleanly');
    ok(p && p.length === 1 && p[0].type === 'other', 'unknown packet type 0x00 → other');
    p = noThrow(() => mqttCodec.makeParser()(packet(0xF0, [])), 'unknown packet type 0xF0 feeds cleanly');
    ok(p && p.length === 1 && p[0].type === 'other', 'unknown packet type 0xF0 → other');

    p = noThrow(() => mqttCodec.makeParser()(packet(0x30, [])), 'PUBLISH with empty body feeds cleanly');
    ok(p && p.length === 1 && p[0].type === 'other', 'PUBLISH with no room for the topic-length prefix → other');
    p = noThrow(() => mqttCodec.makeParser()(packet(0x30, [0x00])), 'PUBLISH with 1-byte body feeds cleanly');
    ok(p && p.length === 1 && p[0].type === 'other', 'PUBLISH with truncated length prefix → other');

    // Declared topic length overruns the body (inside the packet cap).
    const overrun = packet(0x30, [0x00, 0x10, 0x61, 0x62]); // claims 16 topic bytes, has 2
    const feed = mqttCodec.makeParser();
    p = noThrow(() => feed(overrun), 'topicLen > body feeds cleanly');
    ok(p && p.length === 1 && p[0].type === 'other', 'topicLen overrunning the body → other, not garbage publish');
    p = feed(mqttCodec.publish('next', 'ok'));
    ok(p.length === 1 && p[0].type === 'publish' && p[0].topic === 'next',
        'frame stays synced after a malformed publish');

    // Invalid UTF-8 topic bytes with CONSISTENT lengths: decoder policy is
    // replacement (U+FFFD), not rejection — assert no throw, typed publish.
    p = noThrow(() => mqttCodec.makeParser()(packet(0x30, [0x00, 0x02, 0xff, 0xfe, 0x68, 0x69])),
        'invalid-UTF8 topic feeds cleanly');
    ok(p && p.length === 1 && p[0].type === 'publish' && p[0].payload === 'hi',
        'invalid-UTF8 topic decodes via replacement, payload intact');

    p = noThrow(() => mqttCodec.makeParser()(packet(0x20, [0x00])), 'short CONNACK feeds cleanly');
    ok(p && p.length === 1 && p[0].type === 'connack' && p[0].ok === false, 'short CONNACK → connack not-ok');

    // QoS-1 publish (hand-built — the encoder is QoS-0 only, the parser must
    // still skip the 2-byte packet id).
    p = noThrow(() => mqttCodec.makeParser()(packet(0x32, pubBody('q', 'data', 7))), 'QoS-1 publish feeds cleanly');
    ok(p && p.length === 1 && p[0].type === 'publish' && p[0].topic === 'q' && p[0].payload === 'data',
        'QoS-1 packet-id bytes consumed, payload correct');

    // Non-terminating remaining-length varint: >4 continuation bytes is a
    // protocol violation with no frame boundary. Must not throw, must not
    // buffer forever, and the parser must accept a valid packet in a LATER
    // feed (pre-guard this stalled the stream and grew memory unboundedly).
    const stall = mqttCodec.makeParser();
    p = noThrow(() => stall(new Uint8Array([0x30, 0x80, 0x80, 0x80, 0x80])), 'non-terminating varint feeds cleanly');
    ok(p && p.length === 0, 'non-terminating varint yields no packets');
    p = stall(mqttCodec.publish('recovered', 'yes'));
    ok(p.length === 1 && p[0].type === 'publish' && p[0].topic === 'recovered',
        'stream recovers after a non-terminating varint');

    // Max legal varint (268 MB declared): header lands, then a few KB of the
    // "body" — no output, no throw, no unbounded buffering (skip-counter).
    const maxDecl = mqttCodec.makeParser();
    p = noThrow(() => maxDecl(new Uint8Array([0x30, 0xff, 0xff, 0xff, 0x7f])), 'max-varint header feeds cleanly');
    ok(p && p.length === 0, 'max-varint declaration yields nothing');
    p = noThrow(() => maxDecl(new Uint8Array(4096)), 'body bytes against a max-varint declaration feed cleanly');
    ok(p && p.length === 0, 'oversize body bytes are skipped, not buffered');
}

console.log('MQTT codec unit tests — varint edges + malformed-input rejection');
roundTripTests();
varintEdgeTests();
splitReassemblyTests();
malformedInputTests();
console.log('');
if (fail) { console.log(fail + ' check(s) FAILED.'); process.exit(1); }
console.log('All ' + pass + ' MQTT codec unit checks passed.');
