/* rendezvous-crypto.js — key schedule and sealing for the reconnect
 * rendezvous (see RECONNECT_RENDEZVOUS.md and PROTOCOL.md §7).
 *
 * WebCrypto only, no dependencies. All persistent key material lives as
 * NON-EXTRACTABLE CryptoKeys (structured-clonable into IndexedDB); raw bytes
 * exist only transiently during derivation.
 *
 * Key schedule:
 *   ikm          = lowRand || highRand      (the two 32-byte pairing randoms,
 *                                            bytewise-sorted → order-independent)
 *   pairBase     = HKDF(ikm, salt=0^32, info="qrp2p/rdv/v1/base")           [fixed for the pair's
 *                                                                            life — no ratchet]
 *   topicKey     = HKDF(pairBase, salt=0^32, info="qrp2p/rdv/v1/topic")     [HMAC-SHA256]
 *   aeadKey      = HKDF(pairBase, salt=0^32, info="qrp2p/rdv/v1/aead")      [AES-256-GCM]
 *   topic(day)   = hex( HMAC(topicKey, "topic/" + day)[0..15] )             [day = UTC YYYY-MM-DD]
 *   confirmMac   = hex( HKDF(pairBase, salt=0^32, info="qrp2p/rdv/v1/confirm|" + role)[0..15] )
 *                  (pairing key confirmation — proves the peer derived the
 *                   SAME base before either side persists it; role-bound so
 *                   a reflected confirmation never verifies)
 *   keyCheck     = hex( HKDF(pairBase, salt=0^32, info="qrp2p/rdv/v1/check")[0..3] )
 *                  (short NON-SECRET fingerprint for connection logs)
 * Sealing:
 *   blob = base64url( nonce(12) || AES-256-GCM(aeadKey, plaintext, aad) )
 *   aad  = utf8("qrp2p/rdv/v1|" + direction + "|" + epoch)   direction ∈ {"o","a","r"}
 *          ("o" offer, "a" answer, "r" ring — a listener-role doorbell asking
 *           the caller role to publish a fresh offer, PROTOCOL.md §7.5)
 *          epoch is a fixed literal 1 on the wire (PROTOCOL.md §7.4): the
 *          per-reconnect ratchet was removed until a two-sided commit exists,
 *          so the pair base — and with it the sealed epoch — never advances.
 *          The retired "qrp2p/rdv/v1/ratchet" info label is reserved and MUST
 *          NOT be reused; re-introducing a ratchet requires a protocol
 *          version bump.
 *
 * open() returns null on ANY failure — decrypt-then-parse: unauthenticated
 * bytes never reach a parser.
 */

const INFO_BASE = 'qrp2p/rdv/v1/base';
const INFO_TOPIC = 'qrp2p/rdv/v1/topic';
const INFO_AEAD = 'qrp2p/rdv/v1/aead';
// 'qrp2p/rdv/v1/ratchet' is RETIRED (removed ratchet) — reserved, never reuse.
const INFO_CONFIRM = 'qrp2p/rdv/v1/confirm|'; // + role
const INFO_CHECK = 'qrp2p/rdv/v1/check';
const AAD_PREFIX = 'qrp2p/rdv/v1|';

const te = new TextEncoder();
const td = new TextDecoder();

function bytesToB64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(str) {
    let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function bytesToHex(bytes) {
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function hkdfBits(baseKey, saltBytes, infoStr, bits) {
    return new Uint8Array(await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: te.encode(infoStr) },
        baseKey, bits
    ));
}

async function importHkdfBase(rawBytes) {
    // Non-extractable: after this point the raw bytes can be dropped.
    return crypto.subtle.importKey('raw', rawBytes, 'HKDF', false, ['deriveBits', 'deriveKey']);
}

export class RendezvousCrypto {

    static randBytes(n = 32) {
        const out = new Uint8Array(n);
        crypto.getRandomValues(out);
        return out;
    }

    /**
     * Derives the pair's base key from the two pairing randoms. Bytewise
     * sorting makes it order-independent — both sides derive identically
     * regardless of who sent first.
     */
    static async derivePairBase(randA, randB) {
        if (!(randA instanceof Uint8Array) || !(randB instanceof Uint8Array) ||
            randA.length !== 32 || randB.length !== 32) {
            throw new Error('pairing randoms must be 32-byte Uint8Arrays');
        }
        let aLow = true;
        for (let i = 0; i < 32; i++) {
            if (randA[i] !== randB[i]) { aLow = randA[i] < randB[i]; break; }
        }
        const ikm = new Uint8Array(64);
        ikm.set(aLow ? randA : randB, 0);
        ikm.set(aLow ? randB : randA, 32);
        const ikmKey = await importHkdfBase(ikm);
        const baseBits = await hkdfBits(ikmKey, new Uint8Array(32), INFO_BASE, 256);
        return importHkdfBase(baseBits);
    }

    /** HMAC key for topic derivation (kept alongside the base in memory). */
    static async deriveTopicKey(pairBase) {
        const bits = await hkdfBits(pairBase, new Uint8Array(32), INFO_TOPIC, 256);
        return crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    }

    /** AES-256-GCM key for sealing signaling payloads. */
    static async deriveAeadKey(pairBase) {
        return crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(INFO_AEAD) },
            pairBase, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        );
    }

    /**
     * Detached, non-extractable AES-256-GCM key derived from the pair base
     * under a CALLER-supplied info label — for features outside this wire
     * protocol (e.g. the launcher's backup-at-rest encryption) that want a
     * per-pair key without touching the signaling key schedule. HKDF info
     * labels give cryptographic domain separation, so a detached key can
     * never collide with the topic/AEAD/confirm keys above; callers own
     * their label ('qrp2p/rdv/v1/*' stays reserved for this protocol).
     */
    static async deriveDetachedKey(pairBase, infoLabel) {
        if (typeof infoLabel !== 'string' || !infoLabel || infoLabel.startsWith('qrp2p/rdv/v1/')) {
            throw new Error('deriveDetachedKey: caller must supply its own non-reserved info label');
        }
        return crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(infoLabel) },
            pairBase, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        );
    }

    /** UTC day string (YYYY-MM-DD) for a timestamp. */
    static dayString(ts) {
        return new Date(ts).toISOString().slice(0, 10);
    }

    /** [yesterday, today, tomorrow] — subscribe to all three for clock skew. */
    static daysAround(ts) {
        const DAY = 86400000;
        return [ts - DAY, ts, ts + DAY].map(t => RendezvousCrypto.dayString(t));
    }

    /**
     * The rendezvous topic for one UTC day: unlinkable across days and
     * across pairs, computable only with the pair's topic key.
     */
    static async topicForDay(topicKey, dayStr) {
        const mac = new Uint8Array(await crypto.subtle.sign('HMAC', topicKey, te.encode('topic/' + dayStr)));
        return bytesToHex(mac.slice(0, 16));
    }

    static aad(direction, epoch) {
        if (direction !== 'o' && direction !== 'a' && direction !== 'r') {
            throw new Error('direction must be "o", "a" or "r"');
        }
        return te.encode(AAD_PREFIX + direction + '|' + epoch);
    }

    /** Seals a plaintext string → base64url(nonce || ciphertext). */
    static async seal(aeadKey, plaintextStr, direction, epoch) {
        const nonce = RendezvousCrypto.randBytes(12);
        const ct = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonce, additionalData: RendezvousCrypto.aad(direction, epoch) },
            aeadKey, te.encode(plaintextStr)
        ));
        const blob = new Uint8Array(12 + ct.length);
        blob.set(nonce, 0);
        blob.set(ct, 12);
        return bytesToB64url(blob);
    }

    /**
     * Opens a sealed blob. Returns the plaintext string, or null on ANY
     * failure (malformed, wrong key, wrong AAD, tampered) — callers must
     * treat null as silence, never as an error to parse or report on.
     */
    static async open(aeadKey, blobB64url, direction, epoch) {
        try {
            const blob = b64urlToBytes(blobB64url);
            if (blob.length < 13) return null;
            const pt = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: blob.slice(0, 12), additionalData: RendezvousCrypto.aad(direction, epoch) },
                aeadKey, blob.slice(12)
            );
            return td.decode(pt);
        } catch (e) {
            return null;
        }
    }

    /**
     * Pairing key confirmation: proves to the peer that this side derived
     * the same base, before either side persists anything. Bound to the
     * sender's role so a reflected confirmation never verifies as the
     * peer's. Rides the DTLS-authenticated control channel; 128 bits is
     * ample there.
     */
    static async confirmMac(pairBase, role) {
        if (role !== 'caller' && role !== 'listener') throw new Error('role must be "caller" or "listener"');
        const bits = await hkdfBits(pairBase, new Uint8Array(32), INFO_CONFIRM + role, 128);
        return bytesToHex(bits);
    }

    /**
     * Short NON-SECRET fingerprint of the base for connection logs: two
     * devices whose logs show the same key check hold the same base (and so
     * meet on the same topics); different checks explain mutual deafness at
     * a glance. One-way and truncated to 32 bits — useless for key recovery.
     */
    static async keyCheck(pairBase) {
        const bits = await hkdfBits(pairBase, new Uint8Array(32), INFO_CHECK, 32);
        return bytesToHex(bits);
    }

    /**
     * Short log tag for a pairing random (SHA-256, first 4 bytes): lets two
     * devices' logs show WHICH random each exchange consumed without ever
     * logging the random itself.
     */
    static async tag(bytes) {
        const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return bytesToHex(d.slice(0, 4));
    }
}

export default RendezvousCrypto;
