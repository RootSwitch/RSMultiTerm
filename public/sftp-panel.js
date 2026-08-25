'use strict';
// The file browser, living in the left sidebar next to the session tree.
//
// It used to be a right-hand panel, which was wrong: it took its width from
// the terminals, so on a small window the panes it was meant to complement
// became unusable. Here it opens over the session list, the terminal area
// never changes size, and switching back is one click.
//
// It binds to the FOCUSED session and follows focus, so the files you see
// always belong to the device you are looking at. Transfers ride that
// session's existing connection - no second login.

(function () {
    let bound = null;          // sessionId
    let cwd = '.';
    let transferMode = 'sftp';
    // Multi-select over the listing: names, since paths change with cwd.
    // listOrder mirrors the rendered rows for shift-range selection.
    const selection = new Set();
    let listOrder = [];
    let lastPicked = null;
    const entryByName = new Map();   // name -> listing entry
    // sessionId -> 'sftp' | 'scp' | 'none' | 'n/a', so a device is probed at
    // most once per session.
    const capability = new Map();
    let autoOpen = true;

    if (window.rsterm) {
        rsterm.invoke('rs:settings.get').then((s) => {
            if (s && s.autoOpenFileBrowser === false) autoOpen = false;
        });
        rsterm.on('rs:evt.settings-changed', (s) => {
            autoOpen = !s || s.autoOpenFileBrowser !== false;
        });
    }

    const el = (id) => document.getElementById(id);

    async function op(req, sessionId) {
        return rsterm.invoke('rs:sftp.op', { sessionId: sessionId || bound, req });
    }

    // --- sidebar tab plumbing --------------------------------------------

    function showPane(which) {
        const files = which === 'files';
        el('side-pane-sessions').hidden = files;
        el('side-pane-files').hidden = !files;
        el('side-tab-sessions').classList.toggle('active', !files);
        el('side-tab-files').classList.toggle('active', files);
        el('sidebar').classList.remove('collapsed');
        if (files) bindToFocused();
    }

    function filesVisible() {
        const pane = el('side-pane-files');
        return pane && !pane.hidden;
    }

    // --- capability probing ----------------------------------------------

    async function capabilityOf(sessionId) {
        if (capability.has(sessionId)) return capability.get(sessionId);
        const pane = window.TermPanes.panes.get(sessionId);
        if (!pane || pane.transport !== 'ssh') {
            capability.set(sessionId, 'n/a');
            return 'n/a';
        }
        let mode = 'none';
        try {
            mode = (await op({ op: 'mode' }, sessionId)).mode;
        } catch (_) {
            mode = 'none';
        }
        // 'pending' is a not-yet answer, so it must not be remembered as the
        // device's capability.
        if (mode !== 'pending') capability.set(sessionId, mode);
        return mode;
    }

    // Called when a session connects. Opens the browser for it if the device
    // supports file transfer, it is the pane being looked at, and the user
    // has not turned that off.
    async function considerAutoOpen(sessionId) {
        const tab = window.Tabs.active();
        if (!tab || tab.focusedSessionId !== sessionId) return;

        // Already showing files: this session just came up, so bind to it now
        // that a channel can safely be opened. This is the reconnect path -
        // the panel was told "connecting..." a moment ago.
        if (filesVisible()) {
            if (bound !== sessionId || !capability.has(sessionId)) await openFor(sessionId);
            return;
        }
        if (!autoOpen) return;
        const mode = await capabilityOf(sessionId);
        if (mode === 'sftp' || mode === 'scp') {
            // Focus can move while a probe is in flight.
            const still = window.Tabs.active();
            if (still && still.focusedSessionId === sessionId) showPane('files');
        }
    }

    // --- binding ----------------------------------------------------------

    // Reset the panel to "nothing to browse". Everything visible has to go:
    // leaving the old device name in the header and its path in the bar makes
    // a dead panel look like a live one, which is worse than an empty box.
    function clear(message) {
        bound = null;
        cwd = '.';
        transferMode = 'sftp';
        el('sftp-title').textContent = 'no session';
        el('sftp-path').value = '';
        el('sftp-status').textContent = '';
        setControlsEnabled(false);
        renderMessage(message || 'No session is focused. Open one, or pick a pane, to browse its files.');
    }

    // Controls that would act on a session are pointless without one, and a
    // disabled control says so better than an error after the click.
    function setControlsEnabled(on) {
        for (const id of ['sftp-up', 'sftp-refresh', 'sftp-upload', 'sftp-mkdir', 'sftp-path']) {
            const node = el(id);
            if (node) node.disabled = !on;
        }
    }

    async function bindToFocused() {
        const tab = window.Tabs.active();
        const sessionId = tab && tab.focusedSessionId;
        if (!sessionId) return clear();
        if (sessionId === bound) return;
        await openFor(sessionId);
    }

    // The session being browsed has died. SFTP rode on that connection, so
    // the listing is no longer anything you can act on.
    function noteDead(sessionId) {
        if (sessionId !== bound) return;
        const name = el('sftp-title').textContent;
        clear(`${name} disconnected - its file browser is closed too.`);
    }

    async function openFor(sessionId, _title) {
        bound = sessionId;
        showPaneQuiet();
        const pane = window.TermPanes.panes.get(sessionId);
        el('sftp-title').textContent = pane ? pane.title : 'session';
        el('sftp-status').textContent = '';
        setControlsEnabled(true);

        // A pane whose session has already died has nothing to browse.
        if (pane && window.TermPanes.isDead(sessionId)) {
            setControlsEnabled(false);
            return renderMessage(`${pane.title} is disconnected. Press R in the pane to reconnect.`);
        }
        // Still dialing: wait rather than probe. Asking a half-open client
        // for a channel corrupts its handshake, and the connect event below
        // brings us back here once it is up.
        if (pane && pane.state !== 'connected') {
            setControlsEnabled(false);
            return renderMessage(`${pane.title} is connecting...`);
        }

        const mode = await capabilityOf(sessionId);
        // Focus can move, or the session can die, while the probe is out.
        if (bound !== sessionId) return;
        if (mode === 'pending') {
            setControlsEnabled(false);
            return renderMessage(`${pane ? pane.title : 'This session'} is connecting...`);
        }
        transferMode = mode;
        if (mode === 'n/a') {
            setControlsEnabled(false);
            return renderMessage('File transfer is only available on SSH sessions.');
        }
        if (mode === 'none') {
            setControlsEnabled(false);
            return renderMessage('This device offers neither SFTP nor SCP.');
        }
        try {
            const r = await op({ op: 'realpath', path: '.' });
            // The probe was for THIS binding; focus can have moved during it.
            if (bound !== sessionId) return;
            cwd = r.path;
            if (mode === 'scp') renderScpMode();
            else await list();
        } catch (err) {
            if (bound !== sessionId) return;
            renderMessage(err.message);
        }
    }

    // Switch the sidebar to Files without re-entering bindToFocused.
    function showPaneQuiet() {
        el('side-pane-sessions').hidden = true;
        el('side-pane-files').hidden = false;
        el('side-tab-sessions').classList.remove('active');
        el('side-tab-files').classList.add('active');
        el('sidebar').classList.remove('collapsed');
    }

    // --- listing ----------------------------------------------------------

    // Monotonic listing token: two overlapping navigations (a double
    // click racing a refresh) each cleared the box and each appended,
    // leaving both directories' rows concatenated. Only the latest call
    // may paint.
    let listSeq = 0;

    async function list() {
        // SCP has no listing; Enter in the path field and Refresh both land
        // here, and 'SCP cannot list directories' used to replace the panel
        // body - taking the download button with it. In SCP mode the path
        // IS the interface, so re-render that instead.
        if (transferMode === 'scp') return renderScpMode();
        const seq = ++listSeq;
        const target = bound;
        el('sftp-path').value = cwd;
        let entries;
        try {
            entries = (await op({ op: 'list', path: cwd })).entries;
        } catch (err) {
            if (seq !== listSeq || bound !== target) return;
            return renderMessage(err.message);
        }
        // Stale answer: a newer navigation started while this one was out.
        if (seq !== listSeq || bound !== target) return;
        const box = el('sftp-list');
        box.replaceChildren();
        selection.clear();
        lastPicked = null;
        syncColumns();
        entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
        listOrder = entries.filter((it) => it.name !== '.' && it.name !== '..').map((it) => it.name);
        entryByName.clear();
        for (const it of entries) entryByName.set(it.name, it);

        // Header, so the extra columns are readable as columns rather than
        // as a row of unlabelled values.
        const head = document.createElement('div');
        head.className = 'sftp-row sftp-head';
        for (const [cls, text] of [
            ['sftp-name', 'Name'], ['sftp-size', 'Size'], ['sftp-mtime', 'Modified'],
            ['sftp-owner', 'Owner'], ['sftp-group', 'Group'], ['sftp-perms', 'Perms'],
        ]) {
            const c = document.createElement('span');
            c.className = cls;
            c.textContent = text;
            head.appendChild(c);
        }
        box.appendChild(head);

        for (const it of entries) {
            if (it.name === '.' || it.name === '..') continue;
            const row = document.createElement('div');
            row.className = 'sftp-row';

            const name = document.createElement('span');
            name.className = 'sftp-name ' + (it.isDir ? 'dir' : 'file');
            name.textContent = it.name + (it.isLink ? ' ->' : '');
            name.title = it.name;
            // Unix hides dotfiles for a reason; render them present but
            // quiet, the way MobaXterm fades them.
            if (it.name.startsWith('.')) row.classList.add('dotfile');

            const size = document.createElement('span');
            size.className = 'sftp-size';
            size.textContent = it.isDir ? '' : human(it.size);

            const mtime = document.createElement('span');
            mtime.className = 'sftp-mtime';
            mtime.textContent = when(it.mtime);
            if (it.mtime) mtime.title = new Date(it.mtime).toLocaleString();

            const owner = document.createElement('span');
            owner.className = 'sftp-owner';
            owner.textContent = it.owner || '';

            const group = document.createElement('span');
            group.className = 'sftp-group';
            group.textContent = it.group || '';

            const perms = document.createElement('span');
            perms.className = 'sftp-perms';
            perms.textContent = it.perms || '';
            // The octal is what you actually type into chmod.
            if (typeof it.mode === 'number') {
                perms.title = `${it.perms}  (${(it.mode & 0o7777).toString(8).padStart(4, '0')})`;
            }

            row.append(name, size, mtime, owner, group, perms);
            row.dataset.name = it.name;
            if (selection.has(it.name)) row.classList.add('selected');
            // Click selects; Ctrl toggles; Shift ranges over the rendered
            // order - the same rules as the session tree.
            row.addEventListener('click', (e) => {
                if (e.shiftKey && lastPicked !== null) {
                    const a = listOrder.indexOf(lastPicked);
                    const b = listOrder.indexOf(it.name);
                    if (a !== -1 && b !== -1) {
                        if (!e.ctrlKey) selection.clear();
                        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
                            selection.add(listOrder[i]);
                        }
                    }
                } else if (e.ctrlKey) {
                    if (selection.has(it.name)) selection.delete(it.name);
                    else selection.add(it.name);
                    lastPicked = it.name;
                } else {
                    selection.clear();
                    selection.add(it.name);
                    lastPicked = it.name;
                }
                paintSelection();
            });
            if (it.isDir) {
                row.addEventListener('dblclick', () => { cwd = join(cwd, it.name); list(); });
            } else {
                row.addEventListener('dblclick', () => download(it));
            }
            row.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                // A right-click outside the selection retargets it, so the
                // menu acts on what is under the cursor.
                if (!selection.has(it.name)) {
                    selection.clear();
                    selection.add(it.name);
                    lastPicked = it.name;
                    paintSelection();
                }
                rowMenu(e, it);
            });
            box.appendChild(row);
        }
    }

    function paintSelection() {
        for (const row of el('sftp-list').querySelectorAll('.sftp-row[data-name]')) {
            row.classList.toggle('selected', selection.has(row.dataset.name));
        }
    }

    // The entries the menu should act on: the selection when the clicked
    // row is part of it, else just the clicked row.
    function actionTargets(it) {
        if (selection.has(it.name) && selection.size > 1) {
            return listOrder.filter((n) => selection.has(n)).map((n) => entryByName.get(n));
        }
        return [it];
    }

    function renderMessage(msg) {
        const box = el('sftp-list');
        box.replaceChildren();
        const p = document.createElement('div');
        p.className = 'sftp-message';
        p.textContent = msg.includes('Unable to start subsystem') ? 'This device does not offer SFTP.' : msg;
        box.appendChild(p);
    }

    function renderScpMode() {
        // The listing controls cannot work without a listing; leaving them
        // clickable routed them into list(), whose error wiped this panel.
        for (const id of ['sftp-up', 'sftp-refresh', 'sftp-mkdir']) el(id).disabled = true;
        el('sftp-title').textContent += ' (SCP)';
        const box = el('sftp-list');
        box.replaceChildren();
        const note = document.createElement('div');
        note.className = 'sftp-message';
        note.textContent = 'This device offers SCP but not SFTP, so there is no file listing. ' +
            'Type a full remote path above and use Download, or Upload to send a file to it.';
        const dl = document.createElement('button');
        dl.textContent = 'Download the path above';
        dl.style.cssText = 'margin:8px 10px;';
        dl.addEventListener('click', () => {
            const remote = el('sftp-path').value.trim();
            if (remote) download({ name: remote.split('/').pop(), isDir: false }, remote);
        });
        box.append(note, dl);
    }

    // How many detail columns the panel is currently wide enough for. The
    // sidebar is draggable, so this follows the drag instead of guessing
    // once at startup: name+size always, then perms, then modified, then
    // owner/group as the width allows.
    function syncColumns() {
        const box = el('sftp-list');
        if (!box) return;
        const w = box.clientWidth;
        const level = w >= 460 ? 4 : w >= 360 ? 3 : w >= 280 ? 2 : 1;
        box.classList.remove('cols-1', 'cols-2', 'cols-3', 'cols-4');
        box.classList.add(`cols-${level}`);
    }

    function join(dir, name) {
        return dir.endsWith('/') ? dir + name : dir + '/' + name;
    }

    // A directory listing is DEVICE-CONTROLLED input. A hostile or
    // compromised server can answer with a name like
    // '..\..\..\Users\me\...\Startup\evil.exe', and a batch download
    // that pasted that onto the chosen folder would write clean outside it
    // - an arbitrary file write, worth persistence, from nothing more than
    // opening a file listing. Everything that turns a remote name into a
    // LOCAL path goes through here: take the last segment, and refuse the
    // names that are not really names.
    function localName(name) {
        const last = String(name == null ? '' : name).split(/[/\\]/).pop();
        // '.', '..' and empty are traversal or nonsense; ':' would name an
        // NTFS alternate data stream (or a drive) on Windows.
        if (!last || last === '.' || last === '..' || last.includes(':')) return null;
        // Trailing dots and spaces are stripped by Win32 when the file is
        // created, so 'evil.exe. ' and 'evil.exe' are the same file - and
        // the check above must not be dodged by 'evil.exe/..  '.
        const trimmed = last.replace(/[. ]+$/, '');
        return trimmed || null;
    }
    function human(n) {
        if (n === null || n === undefined) return '';
        if (n < 1024) return `${n} B`;
        if (n < 1048576) return `${(n / 1024).toFixed(1)} K`;
        if (n < 1073741824) return `${(n / 1048576).toFixed(1)} M`;
        return `${(n / 1073741824).toFixed(1)} G`;
    }

    // ls -l's own trick: a timestamp inside the last six months shows the
    // time of day, an older one shows the year instead. Both fit the same
    // narrow column, and "which of these changed today" stays answerable.
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function when(ms) {
        if (!ms) return '';
        const d = new Date(ms);
        if (Number.isNaN(d.getTime())) return '';
        const p2 = (n) => String(n).padStart(2, '0');
        const stamp = `${MONTHS[d.getMonth()]} ${p2(d.getDate())}`;
        const sixMonths = 182 * 24 * 3600 * 1000;
        const age = Date.now() - ms;
        return age > sixMonths || age < -sixMonths
            ? `${stamp}  ${d.getFullYear()}`
            : `${stamp} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    }

    // --- transfers --------------------------------------------------------

    async function download(it, explicitPath) {
        // Only a suggestion for the save dialog - but a traversing one
        // would prefill a path outside the folder the user thinks they
        // picked, so it is cleaned on the way in as well.
        const local = await rsterm.invoke('rs:sftp.pickDownload',
            { name: localName(it.name) || 'download' });
        if (!local) return;
        status(`downloading ${it.name}...`);
        try {
            await op({ op: 'download', path: explicitPath || join(cwd, it.name), local });
            status(`downloaded ${it.name}`);
        } catch (err) { status(`download failed: ${err.message}`); }
    }

    async function upload() {
        const local = await rsterm.invoke('rs:sftp.pickUpload');
        if (!local) return;
        await uploadPaths([local]);
    }

    function rowMenu(e, it) {
        const targets = actionTargets(it);
        const files = targets.filter((t) => !t.isDir);
        const many = targets.length > 1;
        const items = [];

        const folders = targets.filter((t) => t.isDir);
        if (files.length) {
            items.push({
                label: many ? `Download ${files.length} file${files.length === 1 ? '' : 's'}...`
                    : 'Download',
                onClick: () => (many ? downloadMany(files) : download(files[0])),
            });
        }
        if (folders.length) {
            items.push({
                label: folders.length === 1
                    ? `Download folder ${folders[0].name}...`
                    : `Download ${folders.length} folders...`,
                onClick: () => downloadTree(folders),
            });
        }
        if (!many) {
            items.push({
                label: 'Rename',
                onClick: async () => {
                    const name = await window.Modals.promptText('Rename', 'New name', it.name);
                    if (!name || name === it.name) return;
                    try {
                        await op({ op: 'rename', from: join(cwd, it.name), to: join(cwd, name) });
                        list();
                    } catch (err) { status(err.message); }
                },
            });
        }
        items.push({
            label: many ? `Copy ${targets.length} paths` : 'Copy path',
            onClick: () => {
                const text = targets.map((t) => join(cwd, t.name)).join(String.fromCharCode(10));
                navigator.clipboard.writeText(text)
                    .then(() => status(many ? `copied ${targets.length} paths` : `copied ${text}`))
                    .catch(() => status('clipboard write blocked'));
            },
        });
        items.push(null, {
            label: many ? `Delete ${targets.length} items...` : 'Delete...',
            onClick: () => confirmDelete(targets),
        });
        window.Modals.menu(e.clientX, e.clientY, items);
    }

    // Deleting is the one file operation with no undo on the far end, so it
    // shows exactly what is about to go and requires the click.
    function confirmDelete(targets) {
        const body = document.createElement('div');
        const info = document.createElement('p');
        info.textContent = `Delete ${targets.length === 1 ? 'this' : `these ${targets.length}`} ` +
            `from ${el('sftp-title').textContent}? There is no undo on the device.`;
        const listEl = document.createElement('pre');
        listEl.style.cssText = 'font-family:var(--mt-mono);font-size:12px;max-height:30vh;' +
            'overflow:auto;margin-top:8px;padding:6px 8px;background:var(--se-input);' +
            'border:1px solid var(--se-border);border-radius:4px;';
        listEl.textContent = targets.map((t) => (t.isDir ? `${t.name}/` : t.name)).join('\n');
        body.append(info, listEl);
        window.Modals.open('Delete from device', body, [
            { label: 'Cancel' },
            {
                label: `Delete ${targets.length === 1 ? '' : targets.length + ' items'}`.trim(),
                primary: true,
                onClick: async () => {
                    let failed = 0;
                    for (const t of targets) {
                        try {
                            await op({ op: t.isDir ? 'rmdir' : 'delete', path: join(cwd, t.name) });
                        } catch (err) {
                            failed++;
                            status(`delete ${t.name}: ${err.message}`);
                        }
                    }
                    if (!failed) status(`deleted ${targets.length} item${targets.length === 1 ? '' : 's'}`);
                    list();
                },
            },
        ]);
    }

    // Batch download: one destination folder for the lot, then sequential
    // transfers so the progress line stays readable.
    // A folder, or a mixed selection with folders in it. One engine call
    // does the whole tree: the renderer's job here is to pick a destination
    // and then say honestly what happened, including what was refused.
    async function downloadTree(targets) {
        if (transferMode !== 'sftp') {
            return status('this device offers only SCP, which cannot list folders');
        }
        const dir = await rsterm.invoke('rs:sftp.pickFolder');
        if (!dir) return;
        const go = await new Promise((resolve) => {
            const body = document.createElement('p');
            body.textContent = `Download ${targets.length} folder${targets.length === 1 ? '' : 's'} ` +
                `into ${dir}? Files with the same names will be replaced.`;
            window.Modals.open('Download folders', body, [
                { label: 'Cancel', onClick: () => resolve(false) },
                { label: 'Download', primary: true, onClick: () => resolve(true) },
            ], { onCancel: () => resolve(false) });
        });
        if (!go) return;
        const sep = dir.includes('\\') ? '\\' : '/';
        let ok = 0, folders = 0, links = 0, unsafe = 0, failed = 0;
        const problems = [];
        for (const t of targets) {
            const safe = localName(t.name);
            if (!safe) { unsafe++; continue; }
            status(`scanning ${t.name}...`);
            try {
                const r = await op({ op: 'downloadTree', path: join(cwd, t.name), local: dir + sep + safe });
                ok += r.files; folders += r.folders + 1;
                links += r.skippedLinks; unsafe += r.skippedUnsafe; failed += r.failureCount;
                if (r.truncated) problems.push(`${t.name} was too large to fetch in one go`);
                for (const n of r.notes) problems.push(n);
                for (const f of r.failures) problems.push(`${f.remote}: ${f.error}`);
            } catch (err) {
                problems.push(`${t.name}: ${err.message}`);
                failed++;
            }
        }
        // Every one of these matters to somebody who just pulled a config
        // tree off a device and needs to know it is all there.
        const bits = [`${ok} file${ok === 1 ? '' : 's'} in ${folders} folder${folders === 1 ? '' : 's'}`];
        if (failed) bits.push(`${failed} failed`);
        if (links) bits.push(`${links} symlink${links === 1 ? '' : 's'} skipped`);
        if (unsafe) bits.push(`${unsafe} name${unsafe === 1 ? '' : 's'} not safe to save locally`);
        status(`${bits.join(', ')} - to ${dir}`);
        if (problems.length) {
            window.Forms.showBanner(failed ? 'error' : 'warn',
                `Folder download: ${problems.slice(0, 3).join('; ')}` +
                (problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''));
        }
    }

    async function downloadMany(files) {
        const dir = await rsterm.invoke('rs:sftp.pickFolder');
        if (!dir) return;
        // One honest confirm for the batch: the OS save dialog (and its
        // overwrite prompt) is only shown for SINGLE downloads, so a batch
        // into a picked folder replaced same-named files with no word.
        const go = await new Promise((resolve) => {
            const body = document.createElement('p');
            body.textContent = `Save ${files.length} file${files.length === 1 ? '' : 's'} into ` +
                `${dir}? Files with the same names will be replaced.`;
            window.Modals.open('Download files', body, [
                { label: 'Cancel', onClick: () => resolve(false) },
                { label: 'Download', primary: true, onClick: () => resolve(true) },
            ], { onCancel: () => resolve(false) });
        });
        if (!go) return;
        let done = 0;
        const failed = [];
        for (const f of files) {
            const safe = localName(f.name);
            if (!safe) {
                status(`skipped a file whose name is not safe to save locally: ${f.name}`);
                continue;
            }
            status(`downloading ${f.name} (${done + 1}/${files.length})...`);
            try {
                const sep = dir.includes('\\') ? '\\' : '/';
                await op({ op: 'download', path: join(cwd, f.name), local: dir + sep + safe });
                done++;
            } catch (err) {
                // One refused file must not abandon the dozen behind it -
                // the tree download already behaves this way.
                failed.push(`${f.name}: ${err.message}`);
            }
        }
        status(`downloaded ${done} of ${files.length} file${files.length === 1 ? '' : 's'} to ${dir}`);
        if (failed.length) {
            window.Forms.showBanner('error', `Download: ${failed.slice(0, 3).join('; ')}` +
                (failed.length > 3 ? ` (and ${failed.length - 3} more)` : ''));
        }
    }

    function status(text) {
        el('sftp-status').textContent = text;
    }

    rsterm.on('rs:evt.sftp-progress', (m) => {
        if (m.sessionId !== bound) return;
        // A tree reports files done; a single transfer reports bytes.
        if (m.phase === 'scanning') return status('scanning the folder...');
        if (m.phase === 'downloading') {
            return status(`${m.files} of ${m.total} files - ${m.name || ''}`);
        }
        status(m.total ? `${human(m.bytes)} of ${human(m.total)}` : human(m.bytes));
    });

    // A closed session's capability answer is meaningless for its successor.
    function forget(sessionId) {
        capability.delete(sessionId);
        if (bound !== sessionId) return;
        // The pane is gone, so there is nothing to rebind to yet; the tab
        // change that follows will pick a new focus if one exists.
        clear('That session was closed.');
    }

    // Drag a file from Explorer onto the listing to upload it - the
    // iterate-on-a-build workflow: drop the bundle, run the installer.
    async function handleDrop(e) {
        e.preventDefault();
        el('side-pane-files').classList.remove('dropping');
        if (!bound) return status('no session to upload to');
        if (transferMode !== 'sftp' && transferMode !== 'scp') {
            return status('this device does not accept uploads');
        }
        const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
        if (!files.length) return;

        // Resolve real paths through the preload (sandboxed renderers get
        // File objects with no .path on purpose).
        const paths = [];
        for (const f of files) {
            const local = rsterm.pathForFile(f);
            if (local) paths.push(local);
        }
        if (!paths.length) return status('nothing droppable (folders cannot be uploaded)');
        await uploadPaths(paths);
    }

    // Upload local files by path into the current directory, sequentially so
    // the progress line stays readable. Shared by drag-and-drop and anything
    // else that already knows the paths.
    async function uploadPaths(paths) {
        // Uploading over an existing file replaces it with no undo, and
        // neither we nor MobaXterm ever said so. Checked against the last
        // listing - good enough, and no extra round trip.
        const clashes = paths
            .map((p) => p.split(/[/\\]/).pop())
            .filter((n) => entryByName.has(n) && !entryByName.get(n).isDir);
        if (clashes.length && !(await confirmOverwrite(clashes))) {
            status('upload cancelled');
            return 0;
        }
        let done = 0;
        for (const local of paths) {
            const name = local.split(/[/\\]/).pop();
            status(`uploading ${name} (${done + 1}/${paths.length})...`);
            try {
                await op({ op: 'upload', local, path: join(cwd, name) });
                done++;
            } catch (err) {
                // EISDIR is what a dropped folder looks like by the time it
                // reaches the engine.
                status(`upload ${name} failed: ${err.message}`);
                break;
            }
        }
        if (done === paths.length) {
            status(`uploaded ${done} file${done === 1 ? '' : 's'}`);
        }
        if (transferMode !== 'scp') list();
        return done;
    }

    // Resolves true to proceed. Every dismissal path (Cancel, Escape,
    // backdrop click) resolves false so an upload never hangs on an
    // unanswered promise.
    function confirmOverwrite(names) {
        return new Promise((resolve) => {
            let answered = false;
            const answer = (v) => { if (!answered) { answered = true; resolve(v); } };
            const body = document.createElement('div');
            const info = document.createElement('p');
            info.textContent = `Uploading will overwrite ${names.length === 1
                ? 'a file' : names.length + ' files'} already on the device:`;
            const listEl = document.createElement('pre');
            listEl.style.cssText = 'font-family:var(--mt-mono);font-size:12px;max-height:30vh;' +
                'overflow:auto;margin-top:8px;padding:6px 8px;background:var(--se-input);' +
                'border:1px solid var(--se-border);border-radius:4px;';
            listEl.textContent = names.join(String.fromCharCode(10));
            body.append(info, listEl);
            window.Modals.open('Overwrite on device', body, [
                { label: 'Cancel', onClick: () => answer(false) },
                {
                    label: names.length === 1 ? 'Overwrite' : `Overwrite ${names.length}`,
                    primary: true,
                    onClick: () => answer(true),
                },
            ], { onCancel: () => answer(false) });
        });
    }

    function wireDrop() {
        const pane = el('side-pane-files');
        pane.addEventListener('dragover', (e) => {
            e.preventDefault();          // required, or the drop never fires
            e.dataTransfer.dropEffect = 'copy';
            pane.classList.add('dropping');
        });
        pane.addEventListener('dragleave', (e) => {
            if (!pane.contains(e.relatedTarget)) pane.classList.remove('dropping');
        });
        pane.addEventListener('drop', handleDrop);
        // A file dropped anywhere else must not make Chromium NAVIGATE to
        // it - that would tear down the whole renderer mid-session.
        window.addEventListener('dragover', (e) => e.preventDefault());
        window.addEventListener('drop', (e) => e.preventDefault());
    }

    function wire() {
        wireDrop();
        // Follow the sidebar drag so the columns appear and disappear with
        // the width rather than only on the next listing.
        if (window.ResizeObserver) {
            new ResizeObserver(syncColumns).observe(el('sftp-list'));
        } else {
            window.addEventListener('resize', syncColumns);
        }
        el('side-tab-sessions').addEventListener('click', () => showPane('sessions'));
        el('side-tab-files').addEventListener('click', () => showPane('files'));
        el('sftp-refresh').addEventListener('click', list);
        el('sftp-up').addEventListener('click', () => {
            const i = cwd.lastIndexOf('/');
            cwd = i > 0 ? cwd.slice(0, i) : '/';
            list();
        });
        el('sftp-upload').addEventListener('click', upload);
        el('sftp-mkdir').addEventListener('click', async () => {
            const name = await window.Modals.promptText('New remote folder', 'Folder name', '');
            if (!name) return;
            try { await op({ op: 'mkdir', path: join(cwd, name) }); list(); }
            catch (err) { status(err.message); }
        });
        el('sftp-path').addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            // SCP: the typed path is a file to fetch, not a directory to
            // list - Enter does what the button under it says.
            if (transferMode === 'scp') {
                const remote = e.target.value.trim();
                if (remote) download({ name: remote.split('/').pop(), isDir: false }, remote);
                return;
            }
            cwd = e.target.value.trim() || '/';
            list();
        });

        // Follow the focused pane while the Files tab is showing - including
        // when there is no longer a pane to follow, which used to leave the
        // last device's name and path sitting in a panel bound to nothing.
        window.Tabs.onChange(() => {
            if (!filesVisible()) return;
            const tab = window.Tabs.active();
            const sid = tab && tab.focusedSessionId;
            if (!sid) {
                if (bound) clear();
                return;
            }
            if (sid !== bound) openFor(sid);
        });

        clear();
    }

    window.SftpPanel = {
        openFor, wire, showPane, considerAutoOpen, forget, noteDead, clear,
        bound: () => bound, uploadPaths, localName };
})();
