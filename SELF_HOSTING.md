# Self-hosting the multiplayer infrastructure

The arcade's multiplayer transport is serverless by design: pairing happens
over a QR code or link, game traffic flows peer-to-peer over WebRTC, and no
infrastructure of ours ever carries it. Two kinds of third-party helper are
still involved by default, and both are replaceable with servers you run:

| Role | Default | Override |
|---|---|---|
| **Rendezvous broker** — the dead-drop that auto-reconnect re-signals through when a paired connection dies completely | Three free public MQTT-over-WSS brokers (mosquitto / emqx / hivemq), used simultaneously | `arcade.v1._meta.rdvBrokers` |
| **ICE servers** — STUN reflects your public address so peers can find a direct path; TURN relays traffic when no direct path exists (symmetric NAT on both ends) | Public STUN only, **no TURN** | `arcade.v1._meta.iceServers` |

Both overrides live in the **Multiplayer dialog → ⚙️ Advanced** panel — no
devtools needed. The fields come prepopulated with the built-in defaults, so
the default path is always visible and any entry can be removed or replaced
directly. A field left equal to the defaults (or blanked) stores no override
at all — the device keeps tracking the built-ins as they evolve.

Why bother:

- **Sovereignty.** Auto-reconnect should not depend on someone else's broker
  staying up (a public-broker outage once stranded two perfectly-paired
  devices for an evening).
- **Locked-down networks.** Some networks block the public brokers' WSS
  ports; a broker on your own domain and port gets through.
- **Symmetric NAT.** Without TURN, two devices that are each behind symmetric
  NAT (common on cellular) cannot connect off-LAN at all. This is the only
  scenario that *requires* running a server — everything else is optional
  hardening.

## Self-hosting the rendezvous broker (mosquitto over WSS)

### What the broker can and cannot see

The broker is untrusted by construction. Everything published through it is
end-to-end AEAD-sealed with per-pair ratcheting keys, on unlinkable
daily-rotating HMAC topics; the worst a malicious broker can do is delay or
drop, which degrades to the one-tap manual re-pair. What any broker (public
or yours) does learn: the connecting devices' IP addresses, that *some* pair
is rendezvousing, and when. Wire-level details in
[p2p/PROTOCOL.md](p2p/PROTOCOL.md) §7.6.

So a self-hosted broker doesn't need hardening against content inspection —
there is no content to inspect. It needs exactly one thing: a WebSocket
listener behind TLS (`wss://`), because the arcade is served over HTTPS and
browsers refuse mixed-content `ws://`.

### mosquitto.conf

```conf
# /etc/mosquitto/conf.d/arcade.conf
listener 8081
protocol websockets
certfile /etc/letsencrypt/live/broker.example.com/fullchain.pem
keyfile  /etc/letsencrypt/live/broker.example.com/privkey.pem

# The dead-drop is anonymous by design — devices don't have accounts.
allow_anonymous true
```

That's the whole job. Topics are tiny (`qrp2p/r/v1/<32 hex chars>`), QoS 0,
payloads are a few hundred bytes, and traffic only flows while a pair is
actively repairing a dead connection — a Raspberry Pi is overkill.

Then in **Multiplayer → Advanced → Rendezvous brokers**, add your URL on its
own line (the built-in brokers are already listed — keep or delete them per
the overlap rule below):

```
wss://broker.example.com:8081/mqtt
```

### The overlap rule (mixed fleets)

Topics are broker-agnostic — the same HMAC-derived topic works on any MQTT
broker — so two devices find each other **as long as at least one broker
appears in both of their lists**. The launcher publishes to and subscribes on
*every* broker in its list simultaneously.

Consequence: if you *delete the prepopulated defaults* and keep only your
private broker, only devices configured with that same broker can rendezvous
with you. If you *add* your broker below the defaults, you gain resilience
without losing reachability to unconfigured devices. Choose per device,
deliberately.

## Self-hosting TURN (coturn)

### coturn config

```conf
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
realm=turn.example.com
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem

# Static credentials — fine for a personal server; see the warning below
# before using this on a device whose saves get exported or shared.
lt-cred-mech
user=arcade:choose-a-long-random-password

# TURN relays real game traffic — cap it.
total-quota=12
max-bps=1000000
```

Then in **Multiplayer → Advanced → ICE servers**, add your TURN lines below
the prepopulated STUN defaults — one server per line, with TURN lines
carrying `username password` after the URL. Keep the `stun:` lines so direct
connections are still preferred — TURN is the fallback, not the first choice:

```
stun:stun.l.google.com:19302
stun:stun1.l.google.com:19302
stun:stun2.l.google.com:19302
stun:stun.services.mozilla.com
turn:turn.example.com:3478 arcade choose-a-long-random-password
turns:turn.example.com:5349 arcade choose-a-long-random-password
```

(The panel stores this canonically as an `RTCIceServer[]` JSON array under
`arcade.v1._meta.iceServers` — relevant only if you set the key by hand.)

This replaces the built-in STUN list entirely (it doesn't merge), and it
applies to every connection the transport makes — first pairing, in-band
repair, and rendezvous auto-reconnect alike. The "Same Wi-Fi only" mode in
the New-connection ceremony still forces zero ICE servers regardless.

### ⚠️ Credential exposure warning

`arcade.v1._meta.iceServers` is ordinary launcher storage, and **every
`arcade.v1.*` key rides along in save-file exports and automatic backups** —
there is no exclusion mechanism for this key. A static TURN credential
stored here leaves the device inside every exported save file.

If you export or share saves, don't put a long-lived admin secret here. Use
coturn's `use-auth-secret` mode with short-lived REST-style credentials, or
a dedicated low-quota account you can rotate without caring. Treat whatever
you paste into this field as "will eventually end up in a JSON file on
someone's disk."

### Verifying TURN is actually used

1. Connect two devices that share no LAN (e.g. one on cellular).
2. On a Chromium browser, open `chrome://webrtc-internals`, find the active
   connection, and look at the selected candidate pair: a relayed connection
   shows local candidate type **`relay`**. (Firefox: `about:webrtc`.)
3. If the pair shows `srflx`/`host` instead, STUN found a direct path and
   TURN correctly stayed idle — that's the preferred outcome, not a failure.
   To force-test the relay, temporarily configure *only* the `turn:` entry
   (no `stun:` lines) on both devices.

## Pointers

- [p2p/PROTOCOL.md](p2p/PROTOCOL.md) §7 — rendezvous protocol, §7.6 carriers
  and the broker override; §8–9 threat model and privacy.
- [ARCADE_PLATFORM.md](ARCADE_PLATFORM.md) — the launcher-side auto-reconnect
  wiring and what the public brokers do/don't learn.
