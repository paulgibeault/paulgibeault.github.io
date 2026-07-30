// ==========================================================================
// GAME DATA DIALOG (arcade-backup-ui.js)
//
// Controller for the one Game Data menu item: the read-only data viewer, the
// restore list (automatic local backup / file import / trusted-peer backups
// stored on this device), the single export form (scope + optional
// passphrase), and the automatic-backup section.
//
// Deliberately thin: every write path belongs to its engine. This module
// never wires #btn-load / #file-load (arcade-save.js), #btn-restore-local-
// backup / #btn-choose-backup-folder (arcade-local-backup.js) — those keep
// the exact ids they had as menu items and their owners self-wire at module
// init. What this module owns is the dialog chrome, the dynamic read-only
// renders, the export form, and the per-peer restore rows.
//
// All dynamic rendering goes through textContent/createElement — values and
// peer names are user-controlled, same discipline as the connections dialog.
// ==========================================================================

export function initBackupDialog(host) {
    const dialog = document.getElementById('backup-dialog');
    const dialogPanel = dialog && dialog.querySelector('.connections-dialog__panel');
    const closeBtn = document.getElementById('backup-dialog-close');
    const statusEl = document.getElementById('backup-dialog-status');
    const localWhenEl = document.getElementById('backup-local-when');
    const viewer = document.getElementById('backup-view-data');
    const viewerBody = document.getElementById('backup-view-data-body');
    const peersEl = document.getElementById('backup-restore-peers');
    const form = document.getElementById('backup-export-form');
    const scopeSel = document.getElementById('backup-export-scope');
    const passEl = document.getElementById('backup-export-passphrase');
    const runBtn = document.getElementById('backup-export-run');

    let viewerBuilt = false;

    function fmtBytes(n) {
        if (!(n > 0)) return '0 B';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function catalogName(appId) {
        const games = (host.getCatalog && host.getCatalog()) || [];
        for (const g of games) if (g && g.id === appId) return g.name || appId;
        return appId;
    }

    // ---- status line + local-backup row meta ----
    async function refreshStatus() {
        let gens = [];
        try { gens = await host.localBackup.listGenerations(); } catch (e) {}
        if (gens.length) {
            const when = new Date(gens[0].receivedAt).toLocaleString();
            statusEl.textContent = 'Last automatic backup: ' + when + ' · ' + gens.length + ' kept';
            localWhenEl.textContent = when;
        } else {
            statusEl.textContent = 'No automatic backup yet — one is taken within a day of playing.';
            localWhenEl.textContent = 'none yet';
        }
    }

    // ---- per-peer restore rows ----
    async function refreshPeers() {
        let senders = [];
        try { senders = await host.backup.listStoredSenders(); } catch (e) {}
        peersEl.textContent = '';
        for (const s of senders) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'backup-dialog__row';
            btn.title = 'Restore ' + s.name + '’s latest backup stored on this device';
            const icon = document.createElement('span');
            icon.className = 'backup-dialog__row-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = '💾';
            const label = document.createElement('span');
            label.className = 'backup-dialog__row-label';
            label.textContent = s.name + '’s backup ';
            const meta = document.createElement('span');
            meta.className = 'backup-dialog__row-meta';
            meta.textContent = 'received ' + new Date(s.receivedAt).toLocaleString()
                + (s.count > 1 ? ' · ' + s.count + ' kept' : '');
            label.appendChild(meta);
            btn.appendChild(icon);
            btn.appendChild(label);
            btn.addEventListener('click', () => {
                host.backup.restoreLatest(s.deviceId)
                    .then((ok) => { if (ok) refresh(); })
                    .catch(() => {});
            });
            peersEl.appendChild(btn);
        }
    }

    // ---- export scope options ----
    async function refreshScope() {
        let ids = [];
        try { ids = await host.save.listExportableAppIds(); } catch (e) {}
        // Rebuild everything after the fixed "Everything" option.
        while (scopeSel.options.length > 1) scopeSel.remove(1);
        for (const id of ids) {
            const opt = document.createElement('option');
            opt.value = id;
            const name = catalogName(id);
            opt.textContent = name === id ? id : name + ' (' + id + ')';
            scopeSel.appendChild(opt);
        }
    }

    // ---- data viewer (lazy) ----
    function keyDetails(entry, appPrefix) {
        const d = document.createElement('details');
        d.className = 'backup-dialog__key';
        const sum = document.createElement('summary');
        const shortKey = appPrefix && entry.key.indexOf(appPrefix) === 0
            ? entry.key.slice(appPrefix.length) : entry.key;
        sum.textContent = shortKey + ' · ' + fmtBytes(entry.bytes);
        d.appendChild(sum);
        const pre = document.createElement('pre');
        pre.className = 'backup-dialog__value';
        let text = entry.value;
        try { text = JSON.stringify(JSON.parse(entry.value), null, 2); } catch (e) { /* not JSON — show raw */ }
        pre.textContent = text;
        d.appendChild(pre);
        return d;
    }

    function appDetails(title, group, appPrefix) {
        const d = document.createElement('details');
        d.className = 'backup-dialog__app';
        const sum = document.createElement('summary');
        let bytes = 0;
        for (const k of group.keys) bytes += k.bytes;
        const bits = [];
        if (group.keys.length) bits.push(group.keys.length + (group.keys.length === 1 ? ' key' : ' keys'));
        if (group.stores && group.stores.length) bits.push(group.stores.length + (group.stores.length === 1 ? ' store' : ' stores'));
        if (group.files && group.files.length) bits.push(group.files.length + (group.files.length === 1 ? ' file' : ' files'));
        sum.textContent = title + ' — ' + (bits.length ? bits.join(', ') : 'empty') + (bytes ? ' · ' + fmtBytes(bytes) : '');
        d.appendChild(sum);
        for (const entry of group.keys) d.appendChild(keyDetails(entry, appPrefix));
        for (const st of (group.stores || [])) {
            const row = document.createElement('div');
            row.className = 'backup-dialog__meta-row';
            row.textContent = '🗄 store "' + st.name + '" · ' + st.count + (st.count === 1 ? ' record' : ' records');
            d.appendChild(row);
        }
        for (const f of (group.files || [])) {
            const row = document.createElement('div');
            row.className = 'backup-dialog__meta-row';
            row.textContent = '📄 ' + f.name + ' · ' + fmtBytes(f.bytes);
            d.appendChild(row);
        }
        return d;
    }

    async function buildViewer() {
        viewerBody.textContent = 'Reading stored data…';
        let view;
        try { view = await host.save.buildDataView(); }
        catch (e) { viewerBody.textContent = 'Could not read stored data.'; return; }
        viewerBody.textContent = '';
        if (!view.apps.length && !view.launcher.keys.length) {
            viewerBody.textContent = 'Nothing stored yet — play a game first.';
            return;
        }
        for (const app of view.apps) {
            viewerBody.appendChild(appDetails(
                catalogName(app.appId), app, 'arcade.v1.' + app.appId + '.'));
        }
        if (view.launcher.keys.length) {
            viewerBody.appendChild(appDetails(
                'Launcher / shared', view.launcher, 'arcade.v1.'));
        }
    }

    viewer.addEventListener('toggle', () => {
        if (viewer.open && !viewerBuilt) {
            viewerBuilt = true;
            buildViewer();
        }
    });

    // ---- export form ----
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (runBtn.disabled) return;
        runBtn.disabled = true;
        Promise.resolve(host.save.performExport({
            appId: scopeSel.value || undefined,
            passphrase: passEl.value
        })).catch(() => {}).then(() => {
            passEl.value = '';
            runBtn.disabled = false;
        });
    });

    // ---- open/close ----
    function refresh() {
        // Reset the viewer so a reopen (or a completed restore) shows fresh
        // data instead of a stale tree.
        viewerBuilt = false;
        viewer.open = false;
        viewerBody.textContent = '';
        refreshStatus();
        refreshPeers();
        refreshScope();
    }

    function open() {
        if (host.closeLauncherMenu) host.closeLauncherMenu();
        dialog.hidden = false;
        refresh();
        setTimeout(() => {
            const focusable = dialog.querySelectorAll('button, input, select, summary');
            if (focusable.length) focusable[0].focus();
        }, 50);
    }
    function close() {
        dialog.hidden = true;
        passEl.value = ''; // never leave a typed passphrase in the DOM
    }

    closeBtn.addEventListener('click', close);
    dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !dialog.hidden) close();
    });
    if (dialogPanel) {
        dialogPanel.addEventListener('keydown', (e) => {
            if (e.key !== 'Tab') return;
            const focusable = Array.from(dialogPanel.querySelectorAll('button, input, select, summary'))
                .filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0);
            if (!focusable.length) return;
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        });
    }

    return { open, close, refresh };
}
