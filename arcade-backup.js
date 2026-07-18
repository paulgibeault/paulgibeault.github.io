/* arcade-backup.js — the launcher-side backup-to-trusted-peer engine (#31).
 *
 * "My phone backs up to my laptop whenever they're paired" — no cloud. On
 * connect (and on the Multiplayer dialog's 💾 toggle), a device with
 * knownPeers[deviceId].backupTarget === true builds its full save bundle
 * (arcade-save.js buildBundle: localStorage + Arcade.store + Arcade.files,
 * checksummed) and offers it to that peer over the launcher-level
 * kind:'backup' envelope (arcade-p2p.js onBackupEnvelope/sendBackupEnvelope
 * — direct links with a completed identity binding only, same delivery rules
 * as Arcade.sync). The receiver keeps the last BACKUP_GENERATIONS bundles per
 * sender in the 'arcade-backup' IndexedDB and can restore one through the
 * SAME import pipeline a save-file load uses (validateSaveBundle gates,
 * confirm, auto-backup, snapshot/rollback commit) — a backup restore is never
 * a second, weaker import path.
 *
 * Trust posture (mirrors arcade-sync.js):
 *   - The backupTarget flag is SYMMETRIC and per-pair: true means this device
 *     both offers its bundle and accepts the peer's. Mutual opt-in is
 *     enforced socially by the consent flow, structurally by each side
 *     gating on its OWN flag: an offer from a peer whose flag here is absent
 *     triggers a consent prompt (host.confirmBackupOffer), false declines
 *     silently forever, and a suspect fingerprint (isFingerprintSuspect —
 *     the gate pairing itself uses) drops everything until re-trusted.
 *   - Every inbound frame is validated (validateBackupEnvelope) before it is
 *     buffered, and a completed transfer must parse AND pass the full
 *     validateSaveBundle gate (shape, per-key allowlist, checksum) before a
 *     generation is stored — a malicious-but-paired peer cannot park junk
 *     bytes in this device's IDB, and IMPORT_PROTECTED_KEYS still shields
 *     device identity / trust records at restore time.
 *
 * Wire protocol (v1, all frames {arcade:1, kind:'backup', v:1, op, id, ...}):
 *   offer → (consent gate) → accept | decline → chunk×parts → ack
 * The ack names the stored checksum; the sender persists it per-peer and
 * skips future offers while its state is unchanged, so reconnect churn moves
 * zero bundle bytes. An 'accept' for an offer the sender no longer holds
 * (expired while the peer's consent prompt sat open) re-offers instead of
 * failing silently.
 *
 * Delta transfers (durability design §6, additive on v1): an offer may name
 * `deltaFrom` (the per-peer acked base checksum, guarded by the sync
 * engine's GC eviction watermark); a receiver still holding that generation
 * answers `accept-delta`, the sender ships a diff document (delta-info +
 * the same chunk frames), and the receiver MATERIALIZES the full bundle
 * from its stored base, requires the offer's exact checksum, and runs the
 * full validateSaveBundle gate before storing — a delta can never smuggle
 * state a full transfer couldn't, and every failure falls back to the
 * plain full transfer. Old peers interoperate with zero negotiation: an
 * old receiver ignores deltaFrom and plain-accepts (full transfer); an old
 * sender never offers deltaFrom. Generations remain full bundles at rest —
 * a delta is a transfer optimization, never a storage format.
 *
 * Memory discipline: the multi-MB bundle string is never parked. A pending
 * offer holds only its checksum/size; the string is (re)built from the
 * short-lived bundle cache when the accept actually arrives, and if the
 * device's state changed in between (checksum drift) the transfer restarts
 * with a fresh offer rather than shipping bytes that contradict the offer.
 * Generations are stored as split rows — 'm|' meta beside the 'g|' bundle
 * string — so the startup index build reads keys + small meta records only.
 *
 * Lazy by design: initBackupEngine(host) opens no IDB at call time. The
 * 'arcade-backup' database is touched only once a transfer is actually
 * accepted, a generation is listed/restored, or an offer needs the
 * last-acked checksum — a device that never opts in never creates it.
 *
 * Encrypt-at-rest (the #31 deferral, now implemented): stored generations
 * are AES-256-GCM-sealed under a key HKDF-derived from the rendezvous pair
 * secret for that sender (pairDetachedKey, non-extractable, own info label
 * — full domain separation from the signaling key schedule), with the
 * sender's deviceId bound as AAD so a generation can't be swapped between
 * peers. DTLS protects transit; this protects the bundle sitting in the
 * TARGET's IDB from being read without the pair record. Availability beats
 * confidentiality for a backup feature: when no pair secret exists (manual
 * ceremony only, or the pair was forgotten) generations fall back to
 * plaintext with a diag note, and legacy plaintext generations stay
 * restorable forever. A generation sealed under a FORMER pair secret
 * (re-paired since) is unreadable by design — restore surfaces that instead
 * of silently yielding bytes nobody authenticated.
 */

import {
    BACKUP_DB,
    BACKUP_GENERATIONS,
    BACKUP_CHUNK_CHARS,
    BACKUP_MAX_CHARS,
    BACKUP_PROTOCOL_V,
    BACKUP_DELTA_FORMAT,
    chunkString,
    genKey,
    planGenerationStore,
    validateBackupEnvelope,
    senderBaseInfo,
    deltaOfferAllowed,
    buildBackupDelta,
    validateBackupDelta,
    applyBackupDelta
} from './arcade-backup-core.js';
import { validateSaveBundle, bytesToB64, b64ToBytes } from './arcade-save.js';
import { SAVE_FORMAT, SAVE_SCHEMA, checksumBundle, idbOpen, idbGet, idbPut, idbKeys, idbDel } from './arcade-storage-core.js';
import { readKnownPeers, setKnownPeerBackupTarget } from './arcade-known-peers.js';
import { ArcadeDiag } from './arcade-diag.js';

// Dedupe window for onPeerIdentity-triggered offers — reconnect/roster churn
// shouldn't rebuild the bundle every beat. kick() (explicit UI toggle-on)
// bypasses this.
const OFFER_DEDUPE_MS = 60 * 1000;
// A transfer must fully deliver within this window of its last frame…
const REASSEMBLY_TIMEOUT_MS = 60 * 1000;
// …AND within this absolute deadline of its first — the per-chunk idle timer
// alone would let a hostile peer drip one duplicate chunk a minute and pin
// the (up to 32 MB) receive buffer forever.
const TRANSFER_MAX_MS = 2 * 60 * 1000;
// Sender keeps an unanswered offer this long — long enough for the peer's
// user to sit on the consent prompt, short enough not to pin a stale claim.
const OFFER_TTL_MS = 5 * 60 * 1000;
// One bundle build serves every peer offered in the same burst (a reconnect
// wave fires onPeerIdentity once per peer within seconds).
const BUNDLE_CACHE_MS = 30 * 1000;
// Chunk frames sent per macrotask — same pacing idea as the SDK's blob
// sender: never monopolize the event loop or flood the transport outbox.
const SEND_BATCH = 8;
// HKDF info label for the at-rest key (see header). Versioned so a future
// envelope change can re-derive under a fresh label instead of ambiguating
// old ciphertexts.
const AT_REST_INFO = 'arcade-backup/at-rest/v1';

// Lazily resolves the per-pair at-rest key. Dynamic import on purpose:
// initBackupEngine is loaded eagerly by index.html's module block, and the
// rendezvous module (and its subtree) must keep loading only when P2P
// features are actually exercised.
async function atRestKey(deviceId) {
    try {
        const { pairDetachedKey } = await import('./p2p/rendezvous.js');
        return await pairDetachedKey(deviceId, AT_REST_INFO);
    } catch (e) { return null; }
}

function atRestAad(deviceId) {
    return new TextEncoder().encode(AT_REST_INFO + '|' + deviceId);
}

// {json} (plaintext fallback / legacy) or {enc:1, iv, ct} (sealed).
async function sealAtRest(deviceId, json) {
    const key = await atRestKey(deviceId);
    if (!key) {
        ArcadeDiag.log('backup', `no pair secret for ${deviceId} — generation stored unencrypted (availability over confidentiality)`);
        return { json };
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: atRestAad(deviceId) },
        key, new TextEncoder().encode(json));
    return { enc: 1, iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)) };
}

// Returns the bundle JSON string, or null on ANY failure (missing pair
// record, re-paired-since key mismatch, tampered ciphertext) — mirroring
// decryptBundleJson's fail-closed discipline.
async function openAtRest(deviceId, rec) {
    if (rec && typeof rec.json === 'string') return rec.json; // legacy/fallback plaintext
    if (!rec || rec.enc !== 1 || typeof rec.iv !== 'string' || typeof rec.ct !== 'string') return null;
    const key = await atRestKey(deviceId);
    if (!key) {
        ArcadeDiag.log('backup', `generation from ${deviceId} is sealed but no pair secret exists — unreadable (re-pair with the device that sent it)`);
        return null;
    }
    try {
        const pt = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: b64ToBytes(rec.iv), additionalData: atRestAad(deviceId) },
            key, b64ToBytes(rec.ct));
        return new TextDecoder().decode(pt);
    } catch (e) {
        ArcadeDiag.log('backup', `sealed generation from ${deviceId} failed to decrypt — pair secret changed since it was stored`);
        return null;
    }
}

export function initBackupEngine(host) {
    const showToast = host.showToast || (() => {});

    // ---- lazy-loaded engine state ----
    let db = null;
    let loadingPromise = null;
    const genIndex = new Map();  // deviceId -> [{key, checksum, chars, exportedAt, receivedAt}] oldest-first (json stays in IDB)
    const acked = new Map();     // deviceId -> checksum of the peer-confirmed stored copy of OUR bundle
    const ackedInfo = new Map(); // deviceId -> full 'a|' row: {checksum, at, clock?, dataHashes?, storeHashes?, fileHashes?}
                                 // — the delta base info persisted at ack time (durability §6)
    let p2p = null;

    const outbound = new Map();       // deviceId -> {id, checksum, chars, parts, at, timer} — never the bundle string
    const inbound = new Map();        // deviceId -> {id, checksum, chars, parts, chunks: Map, startedAt, timer}
    const lastOfferAt = new Map();    // deviceId -> ms of last offer built (dedupe window)
    const declined = new Set();       // deviceIds that declined an offer this session — stop asking until kick()
    const consentPending = new Map(); // deviceId -> latest offer env while the consent prompt is up
    let bundleCache = null;           // {at, value} — value is getBundleJson()'s result (may be null)

    function ensureDb() {
        if (db) return Promise.resolve();
        if (loadingPromise) return loadingPromise;
        loadingPromise = (async () => {
            db = await idbOpen(BACKUP_DB);
            // Keys + per-generation META rows only — never the 'g|' bundle
            // strings (idbAll would materialize every stored backup at once
            // just to build this index).
            const keys = await idbKeys(db);
            for (const key of keys) {
                if (typeof key !== 'string') continue;
                if (key.charAt(0) === 'm' && key.charAt(1) === '|') {
                    const deviceId = key.slice(2, key.lastIndexOf('|'));
                    const v = (await idbGet(db, key)) || {};
                    if (!genIndex.has(deviceId)) genIndex.set(deviceId, []);
                    genIndex.get(deviceId).push({
                        key: 'g' + key.slice(1), checksum: v.checksum, chars: v.chars,
                        exportedAt: v.exportedAt, receivedAt: v.receivedAt
                    });
                } else if (key.charAt(0) === 'a' && key.charAt(1) === '|') {
                    const row = (await idbGet(db, key)) || {};
                    acked.set(key.slice(2), row.checksum);
                    ackedInfo.set(key.slice(2), row);
                }
            }
            for (const list of genIndex.values()) list.sort((a, b) => a.key < b.key ? -1 : 1);
        })();
        return loadingPromise;
    }

    async function getBundle() {
        if (bundleCache && Date.now() - bundleCache.at < BUNDLE_CACHE_MS) return bundleCache.value;
        const value = await host.getBundleJson();
        bundleCache = { at: Date.now(), value };
        return value;
    }

    function peerName(deviceId) {
        const rec = readKnownPeers()[deviceId];
        return (rec && rec.name) || 'Unnamed device';
    }
    // ---- peer eligibility gate (cheap: no IDB) ----
    function backupFlag(deviceId) {
        const rec = readKnownPeers()[deviceId];
        return rec ? rec.backupTarget : undefined;
    }
    function peerSuspect(deviceId) {
        return !!(p2p && typeof p2p.isFingerprintSuspect === 'function' && p2p.isFingerprintSuspect(deviceId));
    }

    function send(deviceId, body) {
        return !!(p2p && p2p.sendBackupEnvelope(deviceId, { v: BACKUP_PROTOCOL_V, ...body }));
    }

    // Idempotent drop shared by both transfer directions: only clears the
    // entry if it is still the one the caller holds (a superseding transfer
    // must not be torn down by its predecessor's stale timer).
    function dropTransfer(map, deviceId, entry) {
        const cur = map.get(deviceId);
        if (cur !== entry) return;
        if (cur.timer) clearTimeout(cur.timer);
        map.delete(deviceId);
    }

    // ---- outbound: offer + chunk delivery ----
    async function maybeOffer(deviceId, force) {
        if (!p2p || backupFlag(deviceId) !== true || peerSuspect(deviceId)) return;
        if (!force && declined.has(deviceId)) return; // they said no this session — stop asking
        const now = Date.now();
        if (!force) {
            const last = lastOfferAt.get(deviceId);
            if (last !== undefined && now - last < OFFER_DEDUPE_MS) return;
        }
        lastOfferAt.set(deviceId, now);

        // A forced offer is a deliberate touch (kick, consent grant): it must
        // capture the state as of NOW, never a cached burst-mate.
        if (force) bundleCache = null;
        let bundle;
        try { bundle = await getBundle(); }
        catch (e) {
            ArcadeDiag.log('backup', `bundle build failed: ${(e && e.message) || e}`);
            return;
        }
        if (!bundle) return; // nothing to back up
        if (bundle.json.length > BACKUP_MAX_CHARS) {
            ArcadeDiag.log('backup', `bundle too large to back up (${bundle.json.length} > ${BACKUP_MAX_CHARS} chars)`);
            return;
        }
        await ensureDb();
        if (acked.get(deviceId) === bundle.checksum) return; // peer already holds this exact state

        const prev = outbound.get(deviceId);
        if (prev && prev.timer) clearTimeout(prev.timer);
        const transfer = {
            id: Math.random().toString(36).slice(2) + Date.now().toString(36),
            checksum: bundle.checksum,
            chars: bundle.json.length,
            parts: Math.max(1, Math.ceil(bundle.json.length / BACKUP_CHUNK_CHARS)),
            at: now,
            timer: null
        };
        transfer.timer = setTimeout(() => dropTransfer(outbound, deviceId, transfer), OFFER_TTL_MS);
        outbound.set(deviceId, transfer);
        // Delta base (durability §6): offer deltaFrom only when we hold the
        // acked bundle's diff material AND its journal clock clears the GC
        // eviction watermark (a base older than an evicted tombstone can't
        // be trusted to express that deletion). Old receivers ignore the
        // field and reply plain 'accept' ⇒ full transfer, no negotiation.
        const offer = {
            op: 'offer', id: transfer.id, checksum: transfer.checksum,
            chars: transfer.chars, parts: transfer.parts,
            exportedAt: String(bundle.exportedAt || '').slice(0, 40)
        };
        const info = ackedInfo.get(deviceId);
        if (info && info.checksum === acked.get(deviceId) && info.checksum !== bundle.checksum) {
            let ceiling = null;
            try { ceiling = host.getWatermarkCeiling ? await host.getWatermarkCeiling() : null; } catch (e) {}
            if (deltaOfferAllowed(info, ceiling)) offer.deltaFrom = info.checksum;
        }
        const sent = send(deviceId, offer);
        if (!sent) dropTransfer(outbound, deviceId, transfer);
    }

    // Rebuilds the current bundle (cheap while the cache is warm) and
    // verifies it is still the state the offer promised — the receiver
    // hard-rejects a checksum switch, so a drifted bundle must restart as a
    // new offer. Also stashes the parsed bundle + its delta base info on the
    // transfer: the base info is small (hashes only, never values) and is
    // what the ack persists so the NEXT offer can go out as a delta.
    async function bundleForTransfer(deviceId, transfer) {
        let bundle;
        try { bundle = await getBundle(); } catch (e) { bundle = null; }
        if (!bundle || bundle.checksum !== transfer.checksum) {
            dropTransfer(outbound, deviceId, transfer);
            if (bundle) maybeOffer(deviceId, true).catch(() => {});
            return null;
        }
        // The parsed object is returned as same-call scratch only — the
        // transfer parks nothing bigger than baseInfo (hashes, never values).
        let parsed = null;
        try {
            parsed = JSON.parse(bundle.json);
            if (!transfer.baseInfo) {
                const info = await senderBaseInfo(parsed);
                if (info) transfer.baseInfo = { checksum: transfer.checksum, ...info };
            }
        } catch (e) {}
        return { bundle, parsed };
    }

    async function sendChunkFrames(deviceId, transfer, payload) {
        const chunks = chunkString(payload, BACKUP_CHUNK_CHARS);
        for (let i = 0; i < chunks.length; i++) {
            if (outbound.get(deviceId) !== transfer) return; // superseded/dropped mid-flight
            const ok = send(deviceId, { op: 'chunk', id: transfer.id, seq: i, parts: chunks.length, body: chunks[i] });
            if (!ok) {
                ArcadeDiag.log('backup', `chunk send failed mid-transfer to ${deviceId} — aborted`);
                dropTransfer(outbound, deviceId, transfer);
                return;
            }
            if ((i + 1) % SEND_BATCH === 0) await new Promise((r) => setTimeout(r, 0));
        }
    }

    async function deliverChunks(deviceId, transfer) {
        const r = await bundleForTransfer(deviceId, transfer);
        if (!r) return;
        await sendChunkFrames(deviceId, transfer, r.bundle.json);
    }

    // accept-delta arrived: ship a delta document instead of the bundle —
    // when one can actually be built, is smaller than the full bundle, and
    // the base the receiver named is the base we hold diff material for.
    // Every bail-out lands on deliverChunks: the receiver's delta-mode
    // reassembly recognizes a full bundle by its format field, so shipping
    // full instead of delta needs no extra signaling.
    async function deliverDelta(deviceId, transfer, base) {
        const r = await bundleForTransfer(deviceId, transfer);
        if (!r) return;
        const info = ackedInfo.get(deviceId);
        if (!info || info.checksum !== base || !deltaOfferAllowed(info, null) || !r.parsed) {
            await sendChunkFrames(deviceId, transfer, r.bundle.json);
            return;
        }
        let deltaJson = null;
        try {
            const doc = await buildBackupDelta(info, r.parsed);
            if (doc) deltaJson = JSON.stringify(doc);
        } catch (e) {
            ArcadeDiag.log('backup', `delta build failed for ${deviceId}: ${(e && e.message) || e}`);
        }
        if (!deltaJson || deltaJson.length >= r.bundle.json.length) {
            // No delta, or one that wouldn't save anything — full transfer.
            await sendChunkFrames(deviceId, transfer, r.bundle.json);
            return;
        }
        const parts = Math.max(1, Math.ceil(deltaJson.length / BACKUP_CHUNK_CHARS));
        if (!send(deviceId, { op: 'delta-info', id: transfer.id, chars: deltaJson.length, parts })) {
            dropTransfer(outbound, deviceId, transfer);
            return;
        }
        ArcadeDiag.log('backup', `delta transfer to ${peerName(deviceId)}: ${deltaJson.length} chars (full bundle ${r.bundle.json.length})`);
        await sendChunkFrames(deviceId, transfer, deltaJson);
    }

    // ---- inbound: consent gate, reassembly, generation storage ----
    async function acceptOffer(deviceId, env) {
        // Delta eligibility (durability §6): the sender named a base bundle
        // it can diff against — answer accept-delta only if we actually
        // HOLD a stored generation with that exact checksum to materialize
        // from. Anything else (no deltaFrom, base pruned, never stored)
        // stays a plain accept ⇒ full transfer.
        let base = null;
        if (typeof env.deltaFrom === 'string') {
            await ensureDb();
            const list = genIndex.get(deviceId) || [];
            if (list.some((g) => g.checksum === env.deltaFrom)) base = env.deltaFrom;
        }
        const prev = inbound.get(deviceId);
        if (prev && prev.timer) clearTimeout(prev.timer);
        const buf = {
            id: env.id, checksum: env.checksum, chars: env.chars, parts: env.parts,
            // The offer's counts describe the FULL bundle — kept so a failed
            // delta can re-arm for the full-transfer fallback.
            offerChars: env.chars, offerParts: env.parts, base,
            chunks: new Map(), startedAt: Date.now(), timer: null
        };
        buf.timer = setTimeout(() => dropTransfer(inbound, deviceId, buf), REASSEMBLY_TIMEOUT_MS);
        inbound.set(deviceId, buf);
        send(deviceId, base ? { op: 'accept-delta', id: env.id, base } : { op: 'accept', id: env.id });
    }

    function handleInboundOffer(fromDeviceId, env) {
        const flag = backupFlag(fromDeviceId);
        if (flag === true) {
            acceptOffer(fromDeviceId, env).catch((e) => ArcadeDiag.log('backup', `accept failed: ${(e && e.message) || e}`));
            return;
        }
        if (flag === false) { send(fromDeviceId, { op: 'decline', id: env.id, reason: 'off' }); return; }
        // Never asked yet: consent prompt, exactly once even if offers churn
        // while it is up — the freshest offer wins when the user says yes.
        const alreadyPrompting = consentPending.has(fromDeviceId);
        consentPending.set(fromDeviceId, env);
        if (alreadyPrompting) return;
        Promise.resolve(host.confirmBackupOffer({ deviceId: fromDeviceId, name: peerName(fromDeviceId) }))
            .then((yes) => {
                const latest = consentPending.get(fromDeviceId);
                consentPending.delete(fromDeviceId);
                setKnownPeerBackupTarget(fromDeviceId, !!yes);
                if (yes) {
                    acceptOffer(fromDeviceId, latest).catch((e) => ArcadeDiag.log('backup', `accept failed: ${(e && e.message) || e}`));
                    // Symmetric flag: our side now offers too. Consent was
                    // this moment's deliberate touch — skip the dedupe.
                    maybeOffer(fromDeviceId, true).catch(() => {});
                } else {
                    send(fromDeviceId, { op: 'decline', id: latest.id, reason: 'declined' });
                }
            })
            .catch((e) => {
                consentPending.delete(fromDeviceId);
                ArcadeDiag.log('backup', `consent prompt failed: ${(e && e.message) || e}`);
            });
    }

    // Sender's answer to accept-delta: the delta document's own size/parts
    // (the offer's counts describe the full bundle). Accepted only before
    // any chunk has landed — a mid-transfer resize is a malformed sender.
    function handleDeltaInfo(fromDeviceId, env) {
        const buf = inbound.get(fromDeviceId);
        if (!buf || buf.id !== env.id || !buf.base || buf.chunks.size > 0) return;
        buf.chars = env.chars;
        buf.parts = env.parts;
    }

    // §6 fallback: the delta could not produce the offered bundle — drop it
    // and re-arm for the ORIGINAL full transfer under the same id. The
    // sender's outbound transfer is still alive (it drops only on ack/
    // decline/TTL), so a plain 'accept' makes it deliver the full bundle;
    // if it already expired, handleInboundAnswer's no-transfer path turns
    // the accept into a fresh offer instead.
    function requestFullFallback(deviceId, buf, why) {
        ArcadeDiag.log('backup', `delta from ${deviceId} unusable (${why}) — requesting full transfer`);
        const fresh = {
            id: buf.id, checksum: buf.checksum, chars: buf.offerChars, parts: buf.offerParts,
            offerChars: buf.offerChars, offerParts: buf.offerParts, base: null,
            chunks: new Map(), startedAt: Date.now(), timer: null
        };
        fresh.timer = setTimeout(() => dropTransfer(inbound, deviceId, fresh), REASSEMBLY_TIMEOUT_MS);
        inbound.set(deviceId, fresh);
        send(deviceId, { op: 'accept', id: buf.id });
    }

    // A reassembled payload in delta mode: materialize the full bundle from
    // the stored base generation + the delta, require the offer's exact
    // checksum, then run the FULL validateSaveBundle gate before storing —
    // a delta can never smuggle state a full transfer couldn't (§7.2).
    async function handleDeltaPayload(fromDeviceId, buf, doc, deltaChars) {
        const dv = validateBackupDelta(doc);
        if (!dv.ok || doc.to !== buf.checksum || doc.from !== buf.base) {
            requestFullFallback(fromDeviceId, buf, dv.ok ? 'checksum-fields' : dv.reason);
            return;
        }
        await ensureDb();
        const list = genIndex.get(fromDeviceId) || [];
        const gen = list.filter((g) => g.checksum === buf.base).pop();
        let baseObj = null;
        if (gen) {
            let rec;
            try { rec = await idbGet(db, gen.key); } catch (e) { rec = null; }
            const baseJson = rec ? await openAtRest(fromDeviceId, rec) : null;
            if (typeof baseJson === 'string') {
                try { baseObj = JSON.parse(baseJson); } catch (e) { baseObj = null; }
            }
        }
        if (!baseObj) {
            requestFullFallback(fromDeviceId, buf, 'base-unreadable');
            return;
        }
        let m = null;
        try { m = applyBackupDelta(baseObj, doc); } catch (e) { m = null; }
        if (!m) {
            requestFullFallback(fromDeviceId, buf, 'apply-failed');
            return;
        }
        let checksum = null;
        try { checksum = await checksumBundle(m.data, m.stores, m.files); } catch (e) {}
        if (checksum !== buf.checksum) {
            requestFullFallback(fromDeviceId, buf, 'materialized-checksum-mismatch');
            return;
        }
        const bundle = {
            format: SAVE_FORMAT, schemaVersion: SAVE_SCHEMA,
            exportedAt: String(doc.exportedAt || ''), appVersion: '1.0.0',
            checksum, data: m.data, stores: m.stores, files: m.files
        };
        if (doc.journal) bundle.journal = doc.journal;
        if (doc.manifest) bundle.manifest = doc.manifest;
        const outJson = JSON.stringify(bundle);
        if (outJson.length > BACKUP_MAX_CHARS) {
            // A full transfer of this state couldn't have been offered
            // either — nothing to fall back to.
            ArcadeDiag.log('backup', `materialized bundle from ${fromDeviceId} exceeds ${BACKUP_MAX_CHARS} chars — dropped`);
            return;
        }
        const v = await validateSaveBundle(bundle);
        if (!v.ok) {
            requestFullFallback(fromDeviceId, buf, 'bundle-validation:' + v.reason);
            return;
        }
        ArcadeDiag.log('backup', `delta from ${peerName(fromDeviceId)} materialized (${deltaChars} delta chars -> ${outJson.length} bundle chars)`);
        buf.exportedAt = String(doc.exportedAt || '').slice(0, 40);
        await storeGeneration(fromDeviceId, buf, outJson);
    }

    async function storeGeneration(fromDeviceId, buf, json) {
        await ensureDb();
        const existing = genIndex.get(fromDeviceId) || [];
        const plan = planGenerationStore(existing, buf.checksum, BACKUP_GENERATIONS);
        if (plan.store) {
            let ms = Date.now();
            let key = genKey(fromDeviceId, ms);
            while (existing.some((g) => g.key === key)) key = genKey(fromDeviceId, ++ms);
            const meta = { checksum: buf.checksum, chars: json.length, exportedAt: buf.exportedAt || '', receivedAt: ms };
            // Split rows: the bundle string under 'g|…' (sealed at rest when
            // a pair secret exists — see sealAtRest), its meta under 'm|…'
            // — ensureDb's index build reads only the latter.
            await idbPut(db, key, await sealAtRest(fromDeviceId, json));
            await idbPut(db, 'm' + key.slice(1), meta);
            existing.push({ key, ...meta });
            for (const pk of plan.prune) {
                try { await idbDel(db, pk); await idbDel(db, 'm' + pk.slice(1)); } catch (e) {}
            }
            // plan.prune is exactly the oldest entries of the pre-push list,
            // so the survivors are the same list minus that prefix.
            const kept = existing.slice(plan.prune.length);
            genIndex.set(fromDeviceId, kept);
            showToast('💾 Backed up "' + peerName(fromDeviceId) + '" — ' + kept.length
                + (kept.length === 1 ? ' generation' : ' generations') + ' kept.');
        }
        // Ack either way: stored now, or this exact state was already the
        // newest kept generation — the sender's data is safe, tell it so.
        send(fromDeviceId, { op: 'ack', id: buf.id, checksum: buf.checksum });
    }

    async function handleInboundChunk(fromDeviceId, env) {
        const buf = inbound.get(fromDeviceId);
        if (!buf || buf.id !== env.id || buf.parts !== env.parts) return;
        if (Date.now() - buf.startedAt > TRANSFER_MAX_MS) {
            ArcadeDiag.log('backup', `transfer from ${fromDeviceId} exceeded ${TRANSFER_MAX_MS / 1000}s — dropped`);
            dropTransfer(inbound, fromDeviceId, buf);
            return;
        }
        buf.chunks.set(env.seq, env.body);
        if (buf.timer) clearTimeout(buf.timer);
        buf.timer = setTimeout(() => dropTransfer(inbound, fromDeviceId, buf), REASSEMBLY_TIMEOUT_MS);
        if (buf.chunks.size < buf.parts) return;
        dropTransfer(inbound, fromDeviceId, buf);

        let json = '';
        for (let i = 0; i < buf.parts; i++) json += buf.chunks.get(i) || '';
        if (json.length !== buf.chars) {
            ArcadeDiag.log('backup', `transfer from ${fromDeviceId} reassembled to ${json.length} chars, offer said ${buf.chars} — dropped`);
            return;
        }
        // The full import gate BEFORE anything touches disk: parse, bundle
        // shape, per-key allowlist, checksum — and the offer's promised
        // checksum must be the bundle's own (no bait-and-switch between
        // offer and delivery).
        let parsed;
        try { parsed = JSON.parse(json); }
        catch (e) {
            ArcadeDiag.log('backup', `transfer from ${fromDeviceId} is not valid JSON — dropped`);
            return;
        }
        // Delta mode: the payload is normally a delta document — but a
        // sender that couldn't (or chose not to) build one ships the full
        // bundle over the same accepted transfer with no extra signaling;
        // the format field disambiguates, and a full bundle falls through
        // to the unchanged full-transfer gate below.
        if (buf.base && parsed && parsed.format === BACKUP_DELTA_FORMAT) {
            await handleDeltaPayload(fromDeviceId, buf, parsed, json.length);
            return;
        }
        const v = await validateSaveBundle(parsed);
        if (!v.ok || parsed.checksum !== buf.checksum) {
            ArcadeDiag.log('backup', `transfer from ${fromDeviceId} failed bundle validation (${v.ok ? 'checksum-switch' : v.reason}) — dropped`);
            return;
        }
        buf.exportedAt = typeof parsed.exportedAt === 'string' ? parsed.exportedAt.slice(0, 40) : '';
        await storeGeneration(fromDeviceId, buf, json);
    }

    async function handleInboundAnswer(fromDeviceId, env) {
        const transfer = outbound.get(fromDeviceId);
        if (!transfer || transfer.id !== env.id) {
            // An accept for an offer we no longer hold: it expired while the
            // peer's consent prompt sat open. Their flag is now true — offer
            // again (dedupe-gated, so a hostile accept spray costs at most
            // one bundle build a minute).
            if (env.op === 'accept' || env.op === 'accept-delta') maybeOffer(fromDeviceId).catch(() => {});
            return;
        }
        if (env.op === 'accept') {
            await deliverChunks(fromDeviceId, transfer);
            return;
        }
        if (env.op === 'accept-delta') {
            await deliverDelta(fromDeviceId, transfer, env.base);
            return;
        }
        if (env.op === 'decline') {
            dropTransfer(outbound, fromDeviceId, transfer);
            declined.add(fromDeviceId); // stop re-offering (and re-building) every reconnect this session
            // 'declined' is a human saying no to the consent prompt right
            // now — worth a toast. 'off' auto-declines on reconnect churn
            // are not.
            if (env.reason === 'declined') {
                showToast('"' + peerName(fromDeviceId) + '" declined backups from this device.');
            }
            return;
        }
        // op === 'ack'
        if (env.checksum !== transfer.checksum) return;
        dropTransfer(outbound, fromDeviceId, transfer);
        await ensureDb();
        acked.set(fromDeviceId, transfer.checksum);
        // Persist the delta base info alongside the acked checksum: the
        // NEXT offer diffs against exactly the bundle the peer just stored.
        // A transfer that never captured base info (sections missing)
        // persists checksum-only — full transfers until the next ack.
        const row = { checksum: transfer.checksum, at: Date.now() };
        if (transfer.baseInfo && transfer.baseInfo.checksum === transfer.checksum) {
            Object.assign(row, transfer.baseInfo);
        }
        ackedInfo.set(fromDeviceId, row);
        try { await idbPut(db, 'a|' + fromDeviceId, row); } catch (e) {}
        ArcadeDiag.log('backup', `bundle backed up to ${peerName(fromDeviceId)} (${transfer.chars} chars)`);
    }

    async function handleInbound(fromDeviceId, env) {
        try {
            if (peerSuspect(fromDeviceId)) return;
            const result = validateBackupEnvelope(env);
            if (!result.ok) {
                ArcadeDiag.log('backup', `rejected inbound envelope from ${fromDeviceId}: ${result.reason}`);
                return;
            }
            if (result.op === 'offer') handleInboundOffer(fromDeviceId, env);
            else if (result.op === 'chunk') await handleInboundChunk(fromDeviceId, env);
            else if (result.op === 'delta-info') handleDeltaInfo(fromDeviceId, env);
            else await handleInboundAnswer(fromDeviceId, env);
        } catch (e) {
            ArcadeDiag.log('backup', `inbound handling error from ${fromDeviceId}: ${(e && e.message) || e}`);
        }
    }

    // ---- restore ----
    async function listGenerations(deviceId) {
        await ensureDb();
        const list = genIndex.get(deviceId) || [];
        // Newest first for display; meta only (the bundle string stays in IDB).
        return list.slice().reverse().map((g) => ({ ...g }));
    }

    async function restoreLatest(deviceId) {
        await ensureDb();
        const list = genIndex.get(deviceId) || [];
        if (!list.length) {
            showToast('No backups from "' + peerName(deviceId) + '" on this device yet.');
            return false;
        }
        const newest = list[list.length - 1];
        let rec;
        try { rec = await idbGet(db, newest.key); } catch (e) { rec = null; }
        const json = rec ? await openAtRest(deviceId, rec) : null;
        if (typeof json !== 'string') {
            // openAtRest already diag-logged the specific reason (no pair
            // secret vs key changed) — the toast stays user-sized.
            showToast('Could not read the stored backup.', { error: true });
            return false;
        }
        const when = new Date(newest.receivedAt).toLocaleString();
        return host.importBundleJson(json,
            'Restore "' + peerName(deviceId) + '"’s backup received ' + when + '?');
    }

    function attachP2P(p2pRef) {
        p2p = p2pRef;
        p2p.onBackupEnvelope((fromDeviceId, env) => {
            handleInbound(fromDeviceId, env).catch((e) => ArcadeDiag.log('backup', `inbound crashed: ${(e && e.message) || e}`));
        });
        p2p.onPeerIdentity(({ deviceId }) => {
            maybeOffer(deviceId).catch((e) => ArcadeDiag.log('backup', `offer failed for ${deviceId}: ${(e && e.message) || e}`));
        });
    }

    function kick(deviceId) {
        declined.delete(deviceId); // an explicit UI touch overrides a remembered session decline
        maybeOffer(deviceId, true).catch((e) => ArcadeDiag.log('backup', `kick failed for ${deviceId}: ${(e && e.message) || e}`));
    }

    return {
        attachP2P,
        kick,
        listGenerations,
        restoreLatest,
        // Test hook: the per-peer acked checksum — read-only, acceptance
        // suites poll it (generation meta is public via listGenerations).
        _acked(deviceId) { return acked.get(deviceId) || null; }
    };
}
