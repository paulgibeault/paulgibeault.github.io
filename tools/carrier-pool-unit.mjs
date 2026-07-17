/* carrier-pool-unit.mjs — hermetic Node unit tests for the shared-carrier
 * layer in p2p/rendezvous-carriers.js:
 *
 *   CarrierPool   — ref-counted topic leases over ONE underlying carrier per
 *                   device (3 broker sockets per device instead of 3 per
 *                   pair). The lease interface must be indistinguishable
 *                   from a private carrier: the rendezvous episode layer and
 *                   the acceptance harness's injected test carrier are both
 *                   consumers that must not change.
 *   redialDelay   — jittered backoff ladder (thundering-herd spread).
 *   makeDialBrake — page-wide sliding-window dial-rate brake.
 *
 * No browser, no network. Discovered by tools/run-units.mjs.
 */
import { CarrierPool, redialDelay, makeDialBrake } from '../p2p/rendezvous-carriers.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// A minimal underlying carrier that records everything the pool does to it.
function makeFakeCarrier(log = []) {
    const subs = new Map(); // topic → Set<cb>
    return {
        log, subs,
        connected: false, closedCount: 0, ensureAliveCount: 0,
        onSessionUp: null,
        async connect() { this.connected = true; log.push('connect'); },
        async publish(topic, payload) { log.push(`pub ${topic}=${payload}`); },
        subscribe(topic, cb) {
            if (!subs.has(topic)) subs.set(topic, new Set());
            subs.get(topic).add(cb);
            log.push(`sub ${topic}`);
            return () => {
                const s = subs.get(topic);
                if (s && s.delete(cb)) log.push(`unsub ${topic}`);
            };
        },
        ensureAlive() { this.ensureAliveCount++; },
        close() { this.closedCount++; log.push('close'); },
        deliver(topic, payload) {
            const s = subs.get(topic);
            if (s) [...s].forEach((cb) => cb(payload));
        },
        liveTopics() {
            let n = 0;
            for (const s of subs.values()) if (s.size) n++;
            return n;
        }
    };
}

function backoffTests() {
    console.log('\nredialDelay — jittered ladder');
    const LADDER = [1000, 2000, 5000, 15000, 30000];
    let inBounds = true, monotoneFloor = true;
    for (let a = 0; a < 8; a++) {
        const base = LADDER[Math.min(a, LADDER.length - 1)];
        if (redialDelay(a, 0) !== base) monotoneFloor = false;
        if (redialDelay(a, 1) !== Math.round(base * 1.4)) inBounds = false;
        const mid = redialDelay(a, 0.5);
        if (mid < base || mid > base * 1.4) inBounds = false;
    }
    ok(monotoneFloor, 'zero jitter reproduces the original [1s,2s,5s,15s,30s] ladder (incl. clamp past the end)');
    ok(inBounds, 'jitter stays within [base, 1.4×base] at every attempt');
    ok(redialDelay(99, 0) === 30000, 'attempts past the ladder clamp to the 30s slot');
    ok(redialDelay(0, -5) === 1000 && redialDelay(0, 7) === 1400, 'out-of-range rand is clamped, not amplified');
}

function brakeTests() {
    console.log('\nmakeDialBrake — page-wide dial-rate window');
    const brake = makeDialBrake({ windowMs: 1000, max: 3 });
    ok(!brake.shouldDefer(0), 'fresh brake never defers');
    brake.note(0); brake.note(10); brake.note(20);
    ok(brake.shouldDefer(30), 'defers once the window holds max attempts');
    ok(!brake.shouldDefer(1500), 'attempts age out of the window — dialing resumes');
    brake.note(1500);
    ok(!brake.shouldDefer(1600), 'expired stamps were evicted, not just ignored (window refills from 1)');
    // The production sizing must clear the normal worst case: three broker
    // legs all down, each cycling early backoff — ~6 dials/leg/min ⇒ 18 < 20.
    const prod = makeDialBrake();
    for (let i = 0; i < 18; i++) prod.note(i * 3000);
    ok(!prod.shouldDefer(59000), 'default sizing does not brake a full 3-leg outage cycling backoff (18 dials/min)');
}

async function poolBasicsTests() {
    console.log('\nCarrierPool — laziness, sharing, delegation');
    let built = 0;
    let fake = null;
    const pool = new CarrierPool(() => { built++; fake = makeFakeCarrier(); return fake; }, { lingerMs: 0 });
    ok(built === 0, 'construction does not build the underlying carrier (factory is lazy)');
    const a = pool.acquire();
    const b = pool.acquire();
    ok(built === 0, 'acquire alone does not build it either — first connect/subscribe does');
    await a.connect();
    await b.connect();
    ok(built === 1, 'two leases share ONE underlying carrier');
    ok(fake.connected, 'lease connect() reaches the underlying connect()');

    await a.publish('t1', 'blob1');
    ok(fake.log.includes('pub t1=blob1'), 'publish delegates verbatim');
    a.ensureAlive();
    b.ensureAlive();
    ok(fake.ensureAliveCount === 2, 'ensureAlive delegates per call (nudgeAll still reaches the socket layer)');

    const got = { a: [], b: [] };
    a.subscribe('topic-A', (p) => got.a.push(p));
    b.subscribe('topic-B', (p) => got.b.push(p));
    fake.deliver('topic-A', 'x');
    fake.deliver('topic-B', 'y');
    ok(got.a.join() === 'x' && got.b.join() === 'y', 'topic routing is isolated per lease subscription');
    pool.close();
}

async function refCountTests() {
    console.log('\nCarrierPool — topic ref counting');
    let fake = null;
    const pool = new CarrierPool(() => { fake = makeFakeCarrier(); return fake; }, { lingerMs: 0 });
    const a = pool.acquire();
    const b = pool.acquire();
    await a.connect(); await b.connect();
    const seen = [];
    a.subscribe('shared', (p) => seen.push('a:' + p));
    b.subscribe('shared', (p) => seen.push('b:' + p));
    ok(fake.log.filter((l) => l === 'sub shared').length === 1, 'a shared topic is subscribed ONCE on the underlying carrier');
    fake.deliver('shared', 'm');
    ok(seen.join() === 'a:m,b:m', 'one delivery fans to every leased callback');

    a.close();
    fake.deliver('shared', 'n');
    ok(seen.join() === 'a:m,b:m,b:n', "closing one lease drops only ITS callback — the other lease still hears");
    ok(fake.liveTopics() === 1, 'topic stays subscribed while any lessee remains');
    b.close();
    ok(fake.log.includes('unsub shared'), 'last lessee gone — topic unsubscribed from the underlying carrier');

    // per-callback unsub (day-topic rollover path in _refreshTopics)
    const c = pool.acquire();
    await c.connect();
    const heard = [];
    const un = c.subscribe('day1', (p) => heard.push(p));
    un();
    un(); // idempotent
    fake.deliver('day1', 'late');
    ok(heard.length === 0 && fake.liveTopics() === 0, 'the returned unsub drops the callback and releases the topic (idempotent)');

    const other = [];
    c.subscribe('day2', (p) => other.push(p));
    c.subscribe('day2', () => { throw new Error('boom'); });
    fake.deliver('day2', 'p');
    ok(other.join() === 'p', 'a throwing callback does not break sibling deliveries');
    pool.close();
}

async function sessionUpTests() {
    console.log('\nCarrierPool — onSessionUp fan-out');
    let fake = null;
    const pool = new CarrierPool(() => { fake = makeFakeCarrier(); return fake; }, { lingerMs: 0 });
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    await a.connect(); await b.connect(); await c.connect();
    const fired = [];
    a.onSessionUp = () => fired.push('a');
    b.onSessionUp = () => { fired.push('b'); throw new Error('boom'); };
    // c deliberately leaves onSessionUp unset (episode still mid-setup)
    fake.onSessionUp();
    ok(fired.sort().join() === 'a,b', 'session-up fans to every lease with a handler; unset handlers are skipped');
    ok(fired.length === 2, 'a throwing handler does not stop the fan-out');
    b.close();
    fired.length = 0;
    fake.onSessionUp();
    ok(fired.join() === 'a', 'a released lease no longer hears session-up');
    pool.close();
}

async function lifecycleTests() {
    console.log('\nCarrierPool — linger, reuse, rebuild');
    let built = 0;
    let fake = null;
    const pool = new CarrierPool(() => { built++; fake = makeFakeCarrier(); return fake; }, { lingerMs: 30 });
    const a = pool.acquire();
    await a.connect();
    a.close();
    ok(fake.closedCount === 0, 'last lease released: the underlying carrier LINGERS instead of closing');

    // Re-acquire inside the linger: warm sockets are the whole point
    // (settle → immediate re-arm is the common repair churn).
    const b = pool.acquire();
    await b.connect();
    await tick(60);
    ok(fake.closedCount === 0 && built === 1, 'a lease acquired during the linger cancels the teardown and reuses the warm carrier');

    b.close();
    await tick(60);
    ok(fake.closedCount === 1, 'linger elapsed with no lessees — underlying carrier closed');

    const first = fake;
    const c = pool.acquire();
    await c.connect();
    ok(built === 2 && fake !== first, 'a lease after teardown rebuilds via the factory (closed carriers are single-use)');
    pool.close();
    ok(fake.closedCount === 1, 'pool.close() tears down immediately, no linger');
}

async function releasedLeaseTests() {
    console.log('\nCarrierPool — released-lease contract');
    const fakes = [];
    const pool = new CarrierPool(() => { const f = makeFakeCarrier(); fakes.push(f); return f; }, { lingerMs: 1000 });
    const a = pool.acquire();
    const keep = pool.acquire();
    await a.connect(); await keep.connect();
    a.close();
    a.close(); // idempotent
    let threw = '';
    try { await a.publish('t', 'x'); } catch (e) { threw = e.message; }
    ok(threw === 'carrier lease released', 'publish on a released lease throws (the episode retry schedule owns it)');
    threw = '';
    try { await a.connect(); } catch (e) { threw = e.message; }
    ok(threw === 'carrier lease released', 'connect on a released lease throws');
    const heard = [];
    const un = a.subscribe('t', (p) => heard.push(p));
    fakes[0].deliver('t', 'x');
    ok(typeof un === 'function' && heard.length === 0, 'subscribe on a released lease is inert (no-op unsub, nothing delivered)');
    ok(!(() => { a.ensureAlive(); return false; })(), 'ensureAlive on a released lease is a no-op');

    // A fresh lease publishing before anything materialized the carrier:
    const cold = new CarrierPool(() => makeFakeCarrier()).acquire();
    threw = '';
    try { await cold.publish('t', 'x'); } catch (e) { threw = e.message; }
    ok(threw === 'carrier not connected', 'publish before connect throws the same message a raw carrier would');
    pool.close();
}

console.log('Carrier pool unit tests — leases, ref counts, linger, jittered redial');
backoffTests();
brakeTests();
await poolBasicsTests();
await refCountTests();
await sessionUpTests();
await lifecycleTests();
await releasedLeaseTests();
console.log('');
if (fail) { console.log(fail + ' check(s) FAILED.'); process.exit(1); }
console.log('All ' + pass + ' carrier pool unit checks passed.');
