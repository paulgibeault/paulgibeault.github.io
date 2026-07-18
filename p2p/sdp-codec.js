// ==========================================
// SDP CODEC — binary template packing
//
// A WebRTC datachannel-only session description contains only four pieces of
// real entropy: ice-ufrag, ice-pwd, the DTLS fingerprint, and the candidate
// list. Everything else is boilerplate identical across browsers, so instead
// of compressing SDP text we transmit a small binary struct and rebuild the
// full SDP from a template on the receiving side.
//
// Packed string format:  "1." + base64url(bytes)
// ('.' never appears in the legacy deflate-base64url payloads, so the two
// formats are unambiguous.)
//
// Binary layout — see PROTOCOL.md §3.1 for the byte-level spec.
//
// After the candidate list the payload may carry an EXTRAS trailer: TLV
// entries of (tag u8, value lstr). This is a format-1-compatible superset,
// not a version bump, because decoders shipped before the trailer existed
// stop reading after the last candidate and ignore trailing bytes — an old
// device decodes a new payload exactly as it always did, and a new device
// decodes an old payload as one with no extras. Every extra value is an
// lstr, so unknown tags are skippable by construction. Current tags:
//   1 = n — the rendezvous offer/answer exchange nonce (PROTOCOL.md §7.4).
//       Before the trailer existed, pack() silently DROPPED `n`, leaving
//       the offer↔answer replay binding inert on the packed wire path.
//
// This module is environment-agnostic (browser + Node) for testability.
// ==========================================

const FORMAT_VERSION = 1;
const EXTRA_TAG = { NONCE: 1 };

const ADDR_KIND = { IPV4: 0, IPV6: 1, MDNS: 2, RAW: 3 };
const CAND_TYPE = ['host', 'srflx', 'prflx', 'relay'];
// RFC 5245 type preferences used to synthesize candidate priorities
const TYPE_PREF = { host: 126, prflx: 110, srflx: 100, relay: 0 };
const HASH_BY_LEN = { 20: 'sha-1', 32: 'sha-256', 48: 'sha-384', 64: 'sha-512' };

const UUID_LOCAL_RE = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;

// ---------- byte helpers ----------

class ByteWriter {
    constructor() { this.bytes = []; }
    u8(v) { this.bytes.push(v & 0xff); return this; }
    u16(v) { this.bytes.push((v >> 8) & 0xff, v & 0xff); return this; }
    raw(arr) { for (const b of arr) this.bytes.push(b & 0xff); return this; }
    lstr(str) { // 1 length byte + ASCII bytes
        if (str.length > 255) throw new Error(`string too long to pack (${str.length})`);
        this.u8(str.length);
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            if (c > 127) throw new Error(`non-ASCII char in packed string: ${str}`);
            this.bytes.push(c);
        }
        return this;
    }
    toUint8Array() { return new Uint8Array(this.bytes); }
}

class ByteReader {
    constructor(bytes) { this.bytes = bytes; this.pos = 0; }
    _need(n) { if (this.pos + n > this.bytes.length) throw new Error('packed payload truncated'); }
    u8() { this._need(1); return this.bytes[this.pos++]; }
    u16() { this._need(2); return (this.bytes[this.pos++] << 8) | this.bytes[this.pos++]; }
    raw(n) { this._need(n); const out = this.bytes.slice(this.pos, this.pos + n); this.pos += n; return out; }
    lstr() {
        const len = this.u8();
        const b = this.raw(len);
        let s = '';
        for (const c of b) s += String.fromCharCode(c);
        return s;
    }
}

function bytesToBase64url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(str) {
    let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// ---------- address helpers ----------

function ipv4ToBytes(str) {
    const parts = str.split('.');
    if (parts.length !== 4) throw new Error('bad ipv4');
    const bytes = parts.map(p => {
        const v = parseInt(p, 10);
        if (isNaN(v) || v < 0 || v > 255 || String(v) !== p) throw new Error('bad ipv4');
        return v;
    });
    return new Uint8Array(bytes);
}

function bytesToIpv4(bytes) {
    return Array.from(bytes).join('.');
}

function ipv6ToBytes(str) {
    if (str.includes('.')) throw new Error('embedded ipv4 not supported'); // fall back to RAW kind
    const halves = str.split('::');
    if (halves.length > 2) throw new Error('bad ipv6');
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const fill = 8 - head.length - tail.length;
    if (halves.length === 1 && head.length !== 8) throw new Error('bad ipv6');
    if (halves.length === 2 && fill < 0) throw new Error('bad ipv6');
    const groups = halves.length === 2
        ? [...head, ...new Array(fill).fill('0'), ...tail]
        : head;
    const bytes = new Uint8Array(16);
    groups.forEach((g, i) => {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) throw new Error('bad ipv6 group');
        const v = parseInt(g, 16);
        bytes[i * 2] = v >> 8;
        bytes[i * 2 + 1] = v & 0xff;
    });
    return bytes;
}

function bytesToIpv6(bytes) {
    // Full uncompressed form — always valid in SDP, keeps the code simple.
    const groups = [];
    for (let i = 0; i < 16; i += 2) {
        groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
    }
    return groups.join(':');
}

function mdnsToBytes(str) {
    const m = UUID_LOCAL_RE.exec(str);
    if (!m) throw new Error('not a uuid.local mdns name');
    const hex = m.slice(1).join('');
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
}

function bytesToMdns(bytes) {
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}.local`;
}

// ---------- fingerprint helpers ----------

function fingerprintToBytes(hexColonStr) {
    const parts = hexColonStr.trim().split(':');
    const bytes = new Uint8Array(parts.length);
    parts.forEach((p, i) => {
        if (!/^[0-9a-fA-F]{2}$/.test(p)) throw new Error('bad fingerprint');
        bytes[i] = parseInt(p, 16);
    });
    return bytes;
}

function bytesToFingerprint(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

// ---------- SDP parsing (pack side) ----------

function parseSDP(sdpStr) {
    const lines = sdpStr.split(/\r?\n/);
    const out = { ufrag: null, pwd: null, fingerprint: null, hash: null, mid: '0', candidates: [] };
    const seen = new Set();

    for (const line of lines) {
        if (line.startsWith('a=ice-ufrag:')) out.ufrag = line.slice(12).trim();
        else if (line.startsWith('a=ice-pwd:')) out.pwd = line.slice(10).trim();
        else if (line.startsWith('a=mid:')) out.mid = line.slice(6).trim();
        else if (line.startsWith('a=fingerprint:')) {
            const [hash, hex] = line.slice(14).trim().split(/\s+/);
            out.hash = hash.toLowerCase();
            out.fingerprint = hex;
        } else if (line.startsWith('a=candidate:')) {
            // a=candidate:foundation component protocol priority address port typ type ...
            const parts = line.slice(2).split(/\s+/);
            if (parts.length < 8) continue;
            const protocol = parts[2].toLowerCase();
            if (protocol !== 'udp') continue; // UDP only — TCP candidates are dead weight for datachannels
            const address = parts[4];
            const port = parseInt(parts[5], 10);
            const typIdx = parts.indexOf('typ');
            const type = typIdx >= 0 ? parts[typIdx + 1] : 'host';
            if (!CAND_TYPE.includes(type)) continue;
            const key = `${address}:${port}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.candidates.push({ address, port, type });
        }
    }

    if (!out.ufrag || !out.pwd || !out.fingerprint) {
        throw new Error('SDP missing ice-ufrag, ice-pwd, or fingerprint — cannot pack');
    }
    return out;
}

// ---------- SDP template (unpack side) ----------

function buildSDP({ type, ufrag, pwd, fingerprint, hash, mid, candidates }) {
    const setup = type === 'offer' ? 'actpass' : 'active';
    const candidateLines = candidates.map((c, i) => {
        const typePref = TYPE_PREF[c.type] ?? 0;
        // RFC 5245 priority formula; localPref descends with index to preserve order
        const priority = (typePref << 24) + ((65535 - i) << 8) + 255;
        let line = `a=candidate:${i + 1} 1 udp ${priority} ${c.address} ${c.port} typ ${c.type}`;
        if (c.type !== 'host') {
            const relAddr = c.address.includes(':') && !c.address.endsWith('.local') ? '::' : '0.0.0.0';
            line += ` raddr ${relAddr} rport 0`;
        }
        return line;
    });

    return [
        'v=0',
        'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
        's=-',
        't=0 0',
        `a=group:BUNDLE ${mid}`,
        'a=msid-semantic: WMS',
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
        'c=IN IP4 0.0.0.0',
        ...candidateLines,
        `a=ice-ufrag:${ufrag}`,
        `a=ice-pwd:${pwd}`,
        'a=ice-options:trickle',
        `a=fingerprint:${hash} ${fingerprint}`,
        `a=setup:${setup}`,
        `a=mid:${mid}`,
        'a=sctp-port:5000',
        'a=max-message-size:262144',
        ''
    ].join('\r\n');
}

// ---------- public API ----------

export class SDPCodec {
    /**
     * Packs a signaling payload {peerId, sessionDesc:{type, sdp}, n?} into a
     * compact string: "1." + base64url(binary). `n` (the rendezvous exchange
     * nonce) rides the extras trailer; a payload with a nonce the trailer
     * can't carry (non-ASCII/oversize) throws, which the encodePayload
     * caller turns into the legacy deflate fallback — the nonce is never
     * silently dropped again.
     */
    static pack(payload) {
        const { peerId, sessionDesc } = payload;
        const isAnswer = sessionDesc.type === 'answer';
        const parsed = parseSDP(sessionDesc.sdp);

        const w = new ByteWriter();
        w.u8((FORMAT_VERSION << 4) | (isAnswer ? 1 : 0));
        w.lstr(String(peerId));
        w.lstr(parsed.mid);
        w.lstr(parsed.ufrag);
        w.lstr(parsed.pwd);

        const fpBytes = fingerprintToBytes(parsed.fingerprint);
        if (!HASH_BY_LEN[fpBytes.length]) {
            throw new Error(`unsupported fingerprint hash length: ${fpBytes.length}`);
        }
        w.u8(fpBytes.length);
        w.raw(fpBytes);

        if (parsed.candidates.length > 255) throw new Error('too many candidates');
        w.u8(parsed.candidates.length);

        for (const cand of parsed.candidates) {
            const typeIdx = CAND_TYPE.indexOf(cand.type);
            let kind, addrBytes;
            try {
                if (UUID_LOCAL_RE.test(cand.address)) {
                    kind = ADDR_KIND.MDNS; addrBytes = mdnsToBytes(cand.address);
                } else if (cand.address.includes(':')) {
                    kind = ADDR_KIND.IPV6; addrBytes = ipv6ToBytes(cand.address);
                } else if (/^\d+\.\d+\.\d+\.\d+$/.test(cand.address)) {
                    kind = ADDR_KIND.IPV4; addrBytes = ipv4ToBytes(cand.address);
                } else {
                    throw new Error('unrecognized');
                }
            } catch (_) {
                kind = ADDR_KIND.RAW; addrBytes = null;
            }

            w.u8(kind | (typeIdx << 2));
            if (kind === ADDR_KIND.RAW) w.lstr(cand.address);
            else w.raw(addrBytes);
            w.u16(cand.port);
        }

        // Extras trailer (see header). A payload without extras stays
        // byte-identical to the pre-trailer format.
        if (payload.n !== undefined && payload.n !== null) {
            w.u8(EXTRA_TAG.NONCE);
            w.lstr(String(payload.n)); // throws on non-ASCII/oversize → deflate fallback
        }

        return `${FORMAT_VERSION}.${bytesToBase64url(w.toUint8Array())}`;
    }

    /** True if the string looks like a packed payload (vs legacy deflate). */
    static isPacked(str) {
        return /^\d+\.[A-Za-z0-9_-]+$/.test(str);
    }

    /**
     * Unpacks a packed string back into {peerId, sessionDesc:{type, sdp}} with
     * a full SDP reconstructed from the template.
     */
    static unpack(str) {
        const m = /^(\d+)\.([A-Za-z0-9_-]+)$/.exec(str);
        if (!m) throw new Error('not a packed payload');
        if (parseInt(m[1], 10) !== FORMAT_VERSION) {
            throw new Error(`unsupported packed format version ${m[1]}`);
        }

        const r = new ByteReader(base64urlToBytes(m[2]));
        const header = r.u8();
        if ((header >> 4) !== FORMAT_VERSION) throw new Error('packed header version mismatch');
        const type = (header & 1) ? 'answer' : 'offer';

        // Every string field below is interpolated into SDP lines by buildSDP.
        // A packed payload is smaller and more constrained than raw SDP, but its
        // strings are still attacker-controlled — reject any that carry control
        // characters (above all CR/LF, which would inject new SDP lines) or run
        // absurdly long, so the "only entropy travels, the template constrains
        // the rest" property actually holds.
        const assertSdpToken = (v, what) => {
            if (typeof v !== 'string' || v.length > 256 || !/^[\x21-\x7e]*$/.test(v)) {
                throw new Error(`packed payload: invalid ${what}`);
            }
            return v;
        };
        const peerId = assertSdpToken(r.lstr(), 'peerId');
        const mid = assertSdpToken(r.lstr(), 'mid');
        const ufrag = assertSdpToken(r.lstr(), 'ufrag');
        const pwd = assertSdpToken(r.lstr(), 'pwd');

        const fpLen = r.u8();
        const hash = HASH_BY_LEN[fpLen];
        if (!hash) throw new Error(`unsupported fingerprint length ${fpLen}`);
        const fingerprint = bytesToFingerprint(r.raw(fpLen));

        const candCount = r.u8();
        const candidates = [];
        for (let i = 0; i < candCount; i++) {
            const meta = r.u8();
            const kind = meta & 0b11;
            const type_ = CAND_TYPE[(meta >> 2) & 0b11];
            let address;
            if (kind === ADDR_KIND.IPV4) address = bytesToIpv4(r.raw(4));
            else if (kind === ADDR_KIND.IPV6) address = bytesToIpv6(r.raw(16));
            else if (kind === ADDR_KIND.MDNS) address = bytesToMdns(r.raw(16));
            else address = assertSdpToken(r.lstr(), 'candidate address');
            const port = r.u16();
            candidates.push({ address, port, type: type_ });
        }

        const out = {
            peerId,
            sessionDesc: {
                type,
                sdp: buildSDP({ type, ufrag, pwd, fingerprint, hash, mid, candidates })
            }
        };

        // Extras trailer: uniform (tag u8, value lstr) entries, so tags from
        // a future sender skip cleanly; a truncated entry throws like any
        // other corruption. Absent trailer (every pre-trailer sender) ⇒ no
        // extras on the payload.
        while (r.pos < r.bytes.length) {
            const tag = r.u8();
            const value = r.lstr();
            if (tag === EXTRA_TAG.NONCE) out.n = assertSdpToken(value, 'nonce extra');
        }

        return out;
    }
}

export default SDPCodec;
