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

    /**
     * Full copyable transcript with a header (for bug reports).
     *
     * The header names THIS device. Every pair line in the log is keyed by the
     * REMOTE device's id, so without our own id two transcripts cannot be
     * correlated at all: reading a pair of field logs from the 2026-08-21
     * incident, there was no way to tell which of phone A's four pairs was the
     * one phone B was calling. Read, never minted — importing this module must
     * stay free of side effects, so a device that has not paired yet simply
     * reports 'unknown'.
     *
     * The trailer states the entry count. The first copy of that same incident
     * arrived truncated mid-word (a clipboard failure, not a logger one) and
     * read as a device that had hung two lines into boot — a wrong and very
     * expensive first diagnosis. A cut transcript is now obvious on sight.
     */
    transcript() {
        let me = 'unknown';
        try { me = localStorage.getItem('arcade.v1._meta.deviceId') || 'unknown'; } catch (e) {}
        return [
            '# Arcade connection log ' + new Date().toISOString(),
            '# device: ' + me,
            '# UA: ' + navigator.userAgent,
            ...entries.map((e) => ArcadeDiag.format(e)),
            '# end of log — ' + entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies')
                + (entries.length >= MAX_ENTRIES ? ' (buffer full; older lines dropped)' : '')
        ].join('\n');
    }
};

// Console access on any device with remote inspection.
try { window.__arcadeDiag = ArcadeDiag; } catch (e) {}

export default ArcadeDiag;
