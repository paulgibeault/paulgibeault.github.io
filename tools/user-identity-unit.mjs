/* user-identity-unit.mjs — hermetic Node unit tests for the user-level
 * signing identity (#32): seed ⇄ key reconstruction, recovery-code codec,
 * and the device-cert / revocation sign+verify gates.
 *
 * The crux property the whole feature depends on is tested here in pure
 * form: a seed exported on "device A" reconstructs, on "device B", a key
 * that signs verifiably against the SAME userPub. Also carries the PKCS8
 * prefix CANARY — recovery codes are the 32-byte seed re-wrapped in a
 * fixed RFC 8410 DER header, and if an engine ever changes its bare-key
 * encoding this must fail loudly instead of minting unrestorable codes.
 *
 * No browser, no network — needs Node's global crypto.subtle with Ed25519
 * (Node 20+). Run: `npm run user-identity-unit`.
 */
import {
    ED25519_PKCS8_PREFIX,
    bytesToB64url,
    b64urlToBytes,
    isUserPub,
    isSigString,
    encodeRecoveryCode,
    decodeRecoveryCode,
    exportSeed,
    keyPairFromSeed,
    signDeviceCertWith,
    verifyDeviceCert,
    signRevocationWith,
    verifyRevocation
} from '../arcade-user-identity.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}

const FP = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const DEV_A = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const DEV_B = 'dev-abc123xyz';

async function codecTests() {
    console.log('\nb64url + shape predicates');
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 62, 63]);
    ok(JSON.stringify([...b64urlToBytes(bytesToB64url(bytes))]) === JSON.stringify([...bytes]),
        'b64url round-trips arbitrary bytes');
    ok(b64urlToBytes('not/base64url+') === null, 'b64urlToBytes rejects non-url alphabet');
    ok(isUserPub(bytesToB64url(new Uint8Array(32))), 'isUserPub accepts 32 encoded bytes');
    ok(!isUserPub(bytesToB64url(new Uint8Array(31))), 'isUserPub rejects 31 bytes');
    ok(!isUserPub(bytesToB64url(new Uint8Array(33))), 'isUserPub rejects 33 bytes');
    ok(!isUserPub(42), 'isUserPub rejects a non-string');
    ok(isSigString(bytesToB64url(new Uint8Array(64))), 'isSigString accepts 64 encoded bytes');
    ok(!isSigString(bytesToB64url(new Uint8Array(63))), 'isSigString rejects 63 bytes');
}

async function pkcs8CanaryTests() {
    console.log('\nPKCS8 prefix canary');
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    ok(pkcs8.length === 48, 'live pkcs8 export is 48 bytes (bare seed form)');
    ok(pkcs8.slice(0, 16).every((b, i) => b === ED25519_PKCS8_PREFIX[i]),
        'live pkcs8 prefix matches the hardcoded RFC 8410 header');
    const seed = await exportSeed(pair.privateKey);
    ok(seed && seed.length === 32, 'exportSeed yields 32 bytes');
    ok(seed.every((b, i) => b === pkcs8[16 + i]), 'seed equals pkcs8 payload bytes');
}

async function crossDeviceTests() {
    console.log('\nseed reconstruction (the recovery property)');
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const userPub = bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    const seed = await exportSeed(pair.privateKey);
    // "Device B" rebuilds the pair from the bare seed.
    const rebuilt = await keyPairFromSeed(seed);
    ok(rebuilt.userPub === userPub, 'rebuilt keypair derives the SAME userPub');
    const cert = await signDeviceCertWith(rebuilt.privateKey, DEV_B, FP, Date.now());
    ok(await verifyDeviceCert(userPub, cert),
        'a cert signed by the rebuilt key verifies against the original userPub');
}

async function recoveryCodeTests() {
    console.log('\nrecovery code codec');
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const code = await encodeRecoveryCode(seed);
    ok(/^([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}$/.test(code),
        'code is 11 dash-joined groups of 5 Crockford chars');
    const back = await decodeRecoveryCode(code);
    ok(back && back.every((b, i) => b === seed[i]), 'code round-trips the seed');
    ok((await decodeRecoveryCode(code.toLowerCase())) !== null, 'decode accepts lowercase');
    ok((await decodeRecoveryCode(code.replace(/-/g, ' ')))?.every((b, i) => b === seed[i]) === true,
        'decode accepts spaces for dashes');
    // Confusables: only meaningful when the code contains a 0 or 1 digit,
    // so build the mangled form by substitution in the confusable direction.
    const mangled = code.replace(/0/g, 'O').replace(/1/g, 'l');
    ok((await decodeRecoveryCode(mangled))?.every((b, i) => b === seed[i]) === true,
        'decode maps O→0 and l→1 (Crockford confusables)');
    // Corruption: flip one char to a different valid alphabet char.
    const i = code.search(/[0-9A-HJKMNP-TV-Z]/);
    const flipped = code.slice(0, i) + (code[i] === 'A' ? 'B' : 'A') + code.slice(i + 1);
    ok((await decodeRecoveryCode(flipped)) === null, 'a single-char corruption fails the checksum');
    ok((await decodeRecoveryCode(code.slice(0, -6))) === null, 'a truncated code is rejected');
    ok((await decodeRecoveryCode('')) === null, 'empty string rejected');
    ok((await decodeRecoveryCode(null)) === null, 'null rejected');
    ok((await decodeRecoveryCode(code.replace(/-/g, '') + 'U')) === null,
        'U (outside the Crockford alphabet) is rejected');
}

async function certGateTests() {
    console.log('\ndevice-cert sign/verify gates');
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const userPub = bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    const other = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const otherPub = bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('raw', other.publicKey)));

    const now = Date.now();
    const cert = await signDeviceCertWith(pair.privateKey, DEV_A, FP, now);
    ok(cert.deviceId === DEV_A && cert.fingerprint === FP && cert.issuedAt === now,
        'cert carries its claim fields verbatim');
    ok(await verifyDeviceCert(userPub, cert), 'a well-formed cert verifies');
    ok(!(await verifyDeviceCert(otherPub, cert)), 'rejects verification under a different userPub');
    ok(!(await verifyDeviceCert(userPub, { ...cert, deviceId: DEV_B })), 'rejects a tampered deviceId');
    ok(!(await verifyDeviceCert(userPub, { ...cert, fingerprint: FP.replace('AB', 'AC') })),
        'rejects a tampered fingerprint');
    ok(!(await verifyDeviceCert(userPub, { ...cert, issuedAt: now + 1 })), 'rejects a tampered issuedAt');
    ok(!(await verifyDeviceCert(userPub, { ...cert, sig: bytesToB64url(new Uint8Array(64)) })),
        'rejects a zeroed signature');
    ok(!(await verifyDeviceCert(userPub, { ...cert, issuedAt: '' + now })), 'rejects a string issuedAt');
    ok(!(await verifyDeviceCert(userPub, null)), 'rejects null');
    ok(!(await verifyDeviceCert('nonsense', cert)), 'rejects a malformed userPub');

    // Domain separation: a revocation over the same deviceId must never
    // verify as a cert (and vice versa).
    const rev = await signRevocationWith(pair.privateKey, DEV_A, now);
    ok(!(await verifyDeviceCert(userPub, { deviceId: DEV_A, fingerprint: FP, issuedAt: now, sig: rev.sig })),
        'a revocation signature does not verify as a device cert');
}

async function revocationGateTests() {
    console.log('\nrevocation sign/verify gates');
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const userPub = bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    const now = Date.now();
    const rev = await signRevocationWith(pair.privateKey, DEV_A, now);
    ok(await verifyRevocation(userPub, rev), 'a well-formed revocation verifies');
    ok(!(await verifyRevocation(userPub, { ...rev, deviceId: DEV_B })), 'rejects a tampered target deviceId');
    ok(!(await verifyRevocation(userPub, { ...rev, revokedAt: now + 1 })), 'rejects a tampered revokedAt');
    // Tamper the FIRST char, guaranteed different: the last b64url char of an
    // Ed25519 sig carries 4 unused padding bits, and the final byte (the S
    // scalar's most-significant byte, < 0x10) is genuinely 0x00 about 1 run
    // in 16 — a slice(0,-2)+'AA' "tamper" then decodes to the ORIGINAL bytes
    // and verifies, which made this check a 1-in-16 CI flake.
    ok(!(await verifyRevocation(userPub, { ...rev, sig: (rev.sig[0] === 'A' ? 'B' : 'A') + rev.sig.slice(1) })),
        'rejects a tampered signature');
    const other = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const otherPub = bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('raw', other.publicKey)));
    ok(!(await verifyRevocation(otherPub, rev)), 'rejects verification under a different userPub');
}

(async () => {
    if (!globalThis.crypto || !crypto.subtle) {
        console.error('This test needs Node 20+ (global crypto.subtle).');
        process.exit(1);
    }
    await codecTests();
    await pkcs8CanaryTests();
    await crossDeviceTests();
    await recoveryCodeTests();
    await certGateTests();
    await revocationGateTests();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
