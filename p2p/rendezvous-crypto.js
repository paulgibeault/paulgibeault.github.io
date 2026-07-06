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
 *   pairBase_0   = HKDF(ikm, salt=0^32, info="qrp2p/rdv/v1/base")
 *   topicKey_n   = HKDF(pairBase_n, salt=0^32, info="qrp2p/rdv/v1/topic")   [HMAC-SHA256]
 *   aeadKey_n    = HKDF(pairBase_n, salt=0^32, info="qrp2p/rdv/v1/aead")    [AES-256-GCM]
 *   topic(day)   = hex( HMAC(topicKey_n, "topic/" + day)[0..15] )           [day = UTC YYYY-MM-DD]
 *   pairBase_n+1 = HKDF(pairBase_n, salt=transcriptHash, info="qrp2p/rdv/v1/ratchet")
 *   transcriptHash = SHA-256( sort(fpA, fpB).join("|") )                    [DTLS fingerprints
 *                                                                            of the NEW connection]
 * Sealing:
 *   blob = base64url( nonce(12) || AES-256-GCM(aeadKey, plaintext, aad) )
 *   aad  = utf8("qrp2p/rdv/v1|" + direction + "|" + epoch)   direction ∈ {"o","a"}
 *
 * open() returns null on ANY failure — decrypt-then-parse: unauthenticated
 * bytes never reach a parser.
 */

const INFO_BASE = 'qrp2p/rdv/v1/base';
const INFO_TOPIC = 'qrp2p/rdv/v1/topic';
const INFO_AEAD = 'qrp2p/rdv/v1/aead';
const INFO_RATCHET = 'qrp2p/rdv/v1/ratchet';
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
        if (direction !== 'o' && direction !== 'a') throw new Error('direction must be "o" or "a"');
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
     * Hash binding a ratchet step to the connection it rode in on: the two
     * DTLS fingerprints of the NEW connection, sorted so both sides agree.
     */
    static async transcriptHash(fpA, fpB) {
        const joined = [fpA, fpB].sort().join('|');
        return new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(joined)));
    }

    /**
     * Post-reconnect ratchet: pairBase_{n+1} = HKDF(pairBase_n,
     * salt=transcriptHash, info=ratchet). Old relay recordings never decrypt
     * under future keys; a stolen key snapshot goes stale at the pair's next
     * successful reconnect.
     */
    static async ratchet(pairBase, transcriptHashBytes) {
        const bits = await hkdfBits(pairBase, transcriptHashBytes, INFO_RATCHET, 256);
        return importHkdfBase(bits);
    }
}

export default RendezvousCrypto;
