/* arcade-diag.js — launcher-wide connection log (ES module, tiny, no deps)
 *
 * One session-long ring buffer that every connection-related layer writes
 * into: the launcher's resume-on-launch decision, the P2P bridge's status
 * transitions and user actions, the transport's diagnostic stream, the
 * rendezvous manager's episode lifecycle, and the MQTT carrier's socket
 * state. The Multiplayer dialog renders it read-only ("Connection log"),
 * so the automatic reconnect attempt that runs at startup can be inspected
 * and copied WITHOUT opening the New-connection ceremony (which would
 * start hosting and pollute the record with an unrelated attempt).
 *
 * Deliberately import-safe from anywhere: importing this module never
 * boots the transport or touches the network.
 */

const MAX_ENTRIES = 500;
const entries = [];    // { t: epoch ms, tag, msg }
const listeners = new Set();

function two(n) { return String(n).padStart(2, '0'); }
function stamp(t) {
    const d = new Date(t);
    return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
}

export const ArcadeDiag = {
    /** Append one line. tag names the layer ('boot', 'bridge', 'p2p', 'rdv', 'mqtt'). */
    log(tag, msg) {
        const entry = { t: Date.now(), tag: String(tag), msg: String(msg) };
        entries.push(entry);
        if (entries.length > MAX_ENTRIES) entries.shift();
        for (const fn of listeners) { try { fn(entry); } catch (e) {} }
    },

    /** Snapshot of the buffer, oldest first. */
    entries() { return entries.slice(); },

    /** Live tail: fn(entry) on every new line. Returns unsubscribe. */
    onEntry(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** One display line: "[HH:MM:SS] tag: msg". */
    format(entry) { return '[' + stamp(entry.t) + '] ' + entry.tag + ': ' + entry.msg; },

    /** Full copyable transcript with a UA header (for bug reports). */
    transcript() {
        return [
            '# Arcade connection log ' + new Date().toISOString(),
            '# UA: ' + navigator.userAgent,
            ...entries.map((e) => ArcadeDiag.format(e))
        ].join('\n');
    }
};

// Console access on any device with remote inspection.
try { window.__arcadeDiag = ArcadeDiag; } catch (e) {}

export default ArcadeDiag;
