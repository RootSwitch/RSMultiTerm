'use strict';
// Bootstrap: quick-connect wiring, engine event fan-in, keybindings, smoke
// harness. Layout lives in tabs.js/grid.js; broadcast in multi-exec.js.

(function () {
    // --- data-plane port intake ------------------------------------------
    // Ports arrive from the preload relay before or after the pane exists;
    // stash until both sides are present.
    const waitingPorts = new Map();

    window.addEventListener('message', (e) => {
        const d = e.data;
        if (!d || d.type !== 'rs:session-port' || !e.ports || !e.ports.length) return;
        const port = e.ports[0];
        if (window.TermPanes.panes.has(d.sessionId)) {
            window.TermPanes.attachPort(d.sessionId, port);
        } else {
            waitingPorts.set(d.sessionId, port);
        }
    });

    function adoptWaitingPort(sessionId) {
        const port = waitingPorts.get(sessionId);
        if (port) {
            waitingPorts.delete(sessionId);
            window.TermPanes.attachPort(sessionId, port);
        }
    }
    // A session that died before its pane ever existed leaves its port
    // parked here forever unless someone closes it.
    function dropWaitingPort(sessionId) {
        const port = waitingPorts.get(sessionId);
        if (port) {
            waitingPorts.delete(sessionId);
            port.close();
        }
    }
    window.App = { adoptWaitingPort };

    // Error text can carry device-derived bytes (SSH banners echo into
    // messages); nothing written into a terminal as OUR chrome may contain
    // escape or C1 bytes, or a hostile endpoint writes outside its stream.
    function plain(s) {
        return String(s == null ? '' : s).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ');
    }
    window.App = window.App || {};
    window.App.plainText = plain;

    // --- engine events ----------------------------------------------------
    rsterm.on('rs:evt.connect-failed', (m) => {
        const pane = window.TermPanes.panes.get(m.sessionId);
        if (pane) {
            // setState writes the reason into the pane now; no second line.
            window.TermPanes.setState(pane, m.isAuthFailure ? 'auth-blocked' : 'error', m.message);
        } else dropWaitingPort(m.sessionId);
    });

    // Pane state from MAIN, not the engine. A session refused before it
    // ever reaches the engine - credential out of scope, tripped profile -
    // has no per-session port to speak through, so this broadcast is the
    // only way the pane learns its fate. And it can fire while openNodes is
    // still returning, BEFORE the pane exists: those are held and applied
    // the moment the pane is created, or the refusal is invisible and the
    // pane sits on an orange dot forever - which is exactly how the first
    // credential-scope refusal looked in real use.
    const earlyStatus = new Map();   // sessionId -> {state, detail}
    rsterm.on('rs:evt.session-status', (m) => {
        if (!m || !m.sessionId || !m.state) return;
        const pane = window.TermPanes.panes.get(m.sessionId);
        if (!pane) {
            earlyStatus.set(m.sessionId, { state: m.state, detail: m.detail });
            return;
        }
        if (pane.state !== m.state) {
            window.TermPanes.setState(pane, m.state, m.detail);
        }
    });
    window.App.takeEarlyStatus = (sessionId) => {
        const held = earlyStatus.get(sessionId);
        earlyStatus.delete(sessionId);
        return held || null;
    };
    rsterm.on('rs:evt.session-closed', (m) => {
        const pane = window.TermPanes.panes.get(m.sessionId);
        if (pane && pane.state !== 'error' && pane.state !== 'auth-blocked') {
            window.TermPanes.setState(pane, 'closed', m.reason);
        }
        if (!pane) dropWaitingPort(m.sessionId);
    });
    rsterm.on('rs:evt.engine-restarted', () => {
        for (const pane of window.TermPanes.panes.values()) {
            window.TermPanes.setState(pane, 'error', 'engine restarted');
            pane.term.write('\r\n\x1b[31m[engine restarted - session lost]\x1b[0m\r\n');
        }
    });

    // --- connect ----------------------------------------------------------
    // intoActiveTab=false: new tab. true: add a pane to the current tab
    // (that is the entire "split view" feature).
    async function connect(opts, intoActiveTab) {
        const transport = opts.transport || 'ssh';
        // SSH carries the username in the auth request itself, so a blank one
        // cannot be resolved later by the device - ask up front.
        if (transport === 'ssh' && !opts.username) {
            const creds = await window.Forms.askCredentials(opts.host);
            if (!creds) return null;
            opts = { ...opts, username: creds.username, password: creds.password };
        }
        const title = opts.title ||
            (transport === 'ssh' ? `${opts.username}@${opts.host}` : `${opts.host}:${opts.port}`);
        const res = await rsterm.invoke('rs:session.connect', {
            transport, host: opts.host, port: opts.port,
            username: opts.username, password: opts.password,
            rawTcp: opts.rawTcp, serial: opts.serial,
            cols: 80, rows: 24,
        });
        window.TermPanes.create(res.sessionId, title, null, transport);
        adoptWaitingPort(res.sessionId);
        const tab = (intoActiveTab && window.Tabs.active()) ? window.Tabs.active()
            : window.Tabs.newTab(title);
        window.Tabs.addSession(tab.id, res.sessionId);
        return res.sessionId;
    }

    function readQuickConnect() {
        const transport = document.getElementById('qc-transport').value;
        if (transport === 'serial') {
            const device = document.getElementById('qc-com').value;
            return {
                transport,
                host: device,   // used for the pane title only
                title: device ? `${device} @ ${document.getElementById('qc-baud').value}` : '',
                serial: { device, baud: Number(document.getElementById('qc-baud').value) || 9600 },
            };
        }
        return {
            host: document.getElementById('qc-host').value.trim(),
            port: Number(document.getElementById('qc-port').value) || undefined,
            username: document.getElementById('qc-user').value.trim(),
            password: document.getElementById('qc-pass').value,
            transport,
        };
    }

    // Serial has no host or credentials, and picking a COM port from a list
    // beats typing one: the transport swaps the fields rather than leaving
    // host/port sitting there meaning nothing.
    // THE baud list - the session editor builds from this too. It used to
    // keep its own six-entry copy without 2400/4800, and Modals.select
    // falls back to the first option when the stored value is absent:
    // editing a 2400-baud session silently rewrote it to 1200 on save.
    const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
    window.App.BAUDS = BAUDS;
    async function syncTransportFields() {
        const serial = document.getElementById('qc-transport').value === 'serial';
        document.getElementById('qc-net').hidden = serial;
        document.getElementById('qc-serial').hidden = !serial;
        if (!serial) return;

        const baud = document.getElementById('qc-baud');
        if (!baud.options.length) {
            for (const b of BAUDS) {
                const o = document.createElement('option');
                o.value = String(b);
                o.textContent = String(b);
                baud.appendChild(o);
            }
            baud.value = '9600';   // console default on essentially all gear
        }
        await refreshComPorts();
    }

    async function refreshComPorts() {
        const sel = document.getElementById('qc-com');
        const previous = sel.value;
        const ports = await rsterm.invoke('rs:serial.listPorts');
        sel.replaceChildren();
        if (!ports.length) {
            const o = document.createElement('option');
            o.value = '';
            o.textContent = 'no serial ports found';
            sel.appendChild(o);
            sel.disabled = true;
            return;
        }
        sel.disabled = false;
        for (const p of ports) {
            const o = document.createElement('option');
            o.value = p.path;
            o.textContent = p.friendlyName && p.friendlyName !== p.path
                ? `${p.path} - ${p.friendlyName}` : p.path;
            sel.appendChild(o);
        }
        if (previous && ports.some((p) => p.path === previous)) sel.value = previous;
    }

    document.getElementById('qc-transport').addEventListener('change', syncTransportFields);
    // A USB console cable plugged in after the app started should appear
    // without a restart, so the list is re-read when it is opened.
    document.getElementById('qc-com').addEventListener('mousedown', refreshComPorts);
    syncTransportFields();

    // Whether font zoom wants Ctrl+Shift instead of bare Ctrl.
    let zoomModifier = 'ctrl';
    const readZoomModifier = (s) => { zoomModifier = (s && s.zoomModifier) || 'ctrl'; };
    rsterm.invoke('rs:settings.get').then(readZoomModifier);
    rsterm.on('rs:evt.settings-changed', readZoomModifier);
    const zoomNeedsShift = () => zoomModifier === 'ctrl+shift';
    window.App.zoomNeedsShift = zoomNeedsShift;

    const quickConnectReady = (o) =>
        o.transport === 'serial' ? !!(o.serial && o.serial.device) : !!o.host;

    // connect() rejects when main does (engine restarting, malformed
    // input); without a catch that was an unhandled rejection and NO
    // banner - the button just did nothing.
    const connectOrSay = (o, split) => connect(o, split)
        .catch((err) => window.Forms.showBanner('error', `Connect: ${err.message}`));
    document.getElementById('qc-go').addEventListener('click', () => {
        const o = readQuickConnect();
        if (quickConnectReady(o)) connectOrSay(o, false);
    });
    document.getElementById('qc-split').addEventListener('click', () => {
        const o = readQuickConnect();
        if (quickConnectReady(o)) connectOrSay(o, true);
    });
    document.getElementById('broadcast-btn').addEventListener('click', () => {
        window.MultiExec.toggleBroadcast();
    });
    document.getElementById('broadcast-groups-btn').addEventListener('click', (e) => {
        window.MultiExec.groupsMenu(e.currentTarget.getBoundingClientRect());
    });
    document.getElementById('highlights-btn').addEventListener('click', () => {
        window.HighlightRulesUI.openEditor();
    });
    document.getElementById('snippets-btn').addEventListener('click', () => {
        window.Snippets.openManager();
    });
    document.getElementById('tunnels-btn').addEventListener('click', () => {
        window.Tunnels.openManager();
    });
    document.getElementById('diff-btn').addEventListener('click', () => {
        window.DiffUI.comparePanes();
    });
    document.getElementById('merge-btn').addEventListener('click', () => {
        if (window.Tabs.tabs.length < 2) {
            window.Forms.showBanner('warn', 'Only one tab is open - nothing to merge.');
            return;
        }
        window.Tabs.mergeAll();
    });
    document.getElementById('settings-btn').addEventListener('click', () => {
        window.SettingsUI.openSettings();
    });

    // Rule sets load before any pane exists so first output is highlighted.
    window.Highlight.loadSets();
    // Offers the previous layout back, and starts snapshotting this one.
    window.Workspace.init();

    // A session that connected while its destination disappeared - the
    // pane closed mid-reconnect, the tab closed mid-open - is hung up, not
    // parked: a live authenticated connection nobody can see or close is
    // worse than redialing.
    function disposeOrphan(sessionId) {
        rsterm.invoke('rs:session.disconnect', { sessionId }).catch(() => { /* engine gone */ });
        window.TermPanes.destroy(sessionId);
    }
    window.App.disposeOrphan = disposeOrphan;

    // --- reconnect --------------------------------------------------------
    // Dial the same target again into the same grid slot. Saved sessions
    // re-resolve from the tree, so an edited host or profile is picked up.
    async function reconnectPane(oldSessionId) {
        const pane = window.TermPanes.panes.get(oldSessionId);
        if (!pane) return;
        pane.term.write('\x1b[2m[reconnecting...]\x1b[0m\r\n');
        let res;
        try {
            res = await rsterm.invoke('rs:session.reconnect', { sessionId: oldSessionId });
        } catch (err) {
            pane.term.write(`\x1b[31m[reconnect failed: ${plain(err.message)}]\x1b[0m\r\n`);
            return;
        }
        // A pane restored from a snapshot has no password to redial with -
        // ask rather than spend an auth attempt on a blank one.
        if (res.needsCredentials) {
            const creds = await window.Forms.askCredentials(res.host, res.username);
            if (!creds) {
                pane.term.write('\x1b[2m[reconnect cancelled]\x1b[0m\r\n');
                return;
            }
            try {
                res = await rsterm.invoke('rs:session.connect', {
                    ...res.args, username: creds.username, password: creds.password,
                });
            } catch (err) {
                pane.term.write(`\x1b[31m[reconnect failed: ${plain(err.message)}]\x1b[0m\r\n`);
                return;
            }
        }
        window.TermPanes.create(res.sessionId, res.title || pane.title, res.highlightSet, res.transport);
        const freshPane = window.TermPanes.panes.get(res.sessionId);
        if (freshPane) freshPane.nodeId = pane.nodeId;
        adoptWaitingPort(res.sessionId);
        // The dial and the credential prompt above both await; the pane
        // being reconnected can be closed during either. If it is gone,
        // the fresh session has no slot to take over - hang it up.
        if (!window.Tabs.replaceSession(oldSessionId, res.sessionId)) {
            disposeOrphan(res.sessionId);
            return;
        }
        window.TermPanes.destroy(oldSessionId);
        const fresh = window.TermPanes.panes.get(res.sessionId);
        if (fresh) fresh.term.focus();
    }
    window.App.reconnectPane = reconnectPane;

    // Dial an SSH host by name/IP - the hints mode and the palette's
    // "SSH to ..." row both land here. Prompts for credentials like any
    // quick connect with no username.
    window.App.quickSsh = (host) => connect({ host, transport: 'ssh' }, false)
        .catch((err) => window.Forms.showBanner('error', `Connect: ${err.message}`));

    // Second session to the same device, added beside the original.
    async function duplicatePane(sessionId) {
        const pane = window.TermPanes.panes.get(sessionId);
        const tab = window.Tabs.tabOf(sessionId);
        if (!pane || !tab) return;
        let res;
        try {
            res = await rsterm.invoke('rs:session.duplicate', { sessionId });
        } catch (err) {
            window.Forms.showBanner('error', `Duplicate: ${err.message}`);
            return;
        }
        window.TermPanes.create(res.sessionId, res.title || pane.title, res.highlightSet, res.transport);
        const dupPane = window.TermPanes.panes.get(res.sessionId);
        if (dupPane) dupPane.nodeId = pane.nodeId;
        adoptWaitingPort(res.sessionId);
        // The tab was captured before the await; a duplicate whose tab was
        // closed while dialing has nowhere to go, and "beside the
        // original" cannot mean "invisible".
        if (!window.Tabs.addSession(tab.id, res.sessionId)) {
            disposeOrphan(res.sessionId);
        }
    }
    window.App.duplicatePane = duplicatePane;

    // --- keybindings (settings-driven later; fixed defaults for now) ------
    window.addEventListener('keydown', (e) => {
        // Terminal-facing shortcuts must not fire while a dialog is open or
        // the user is typing in a form field: Ctrl+Shift+V from inside the
        // session editor must not send the clipboard to a live device.
        const t = e.target;
        const inField = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable ||
            (t.tagName === 'TEXTAREA' && !t.classList.contains('xterm-helper-textarea')));
        const inModal = !!document.querySelector('.modal-backdrop');

        if (e.ctrlKey && e.shiftKey && e.code === 'KeyF') {
            // Find works from anywhere except a modal - including from the
            // search field itself (reselects) and the terminal.
            if (inModal) return;
            e.preventDefault();
            window.SearchUI.open();
            return;
        }
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyP') {
            if (inModal) return;
            e.preventDefault();
            window.Palette.open();
            return;
        }
        if (inField || inModal) return;

        // Font zoom, keyboard edition. Ctrl+Minus is also what xterm sends
        // as C-_ - emacs undo - so the modifier is a setting: 'ctrl'
        // (default, the muscle memory) or 'ctrl+shift' (frees the
        // keystroke for the remote).
        const zshift = zoomNeedsShift();
        if (e.ctrlKey && e.shiftKey === zshift && !e.altKey &&
            (e.code === 'Equal' || e.code === 'NumpadAdd')) {
            e.preventDefault();
            window.TermPanes.zoom(1);
            return;
        }
        if (e.ctrlKey && e.shiftKey === zshift && !e.altKey &&
            (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
            e.preventDefault();
            window.TermPanes.zoom(-1);
            return;
        }
        if (e.ctrlKey && e.shiftKey === zshift && !e.altKey &&
            (e.code === 'Digit0' || e.code === 'Numpad0')) {
            e.preventDefault();
            window.TermPanes.zoom(0);
            return;
        }

        if (e.ctrlKey && e.shiftKey && e.code === 'Space') {
            e.preventDefault();
            window.Hints.open();
            return;
        }
        // Prompt-to-prompt navigation, when the shell marks its prompts
        // (OSC 133). Ctrl+Alt to stay clear of shell history keys.
        if (e.ctrlKey && e.altKey && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
            const tab = window.Tabs.active();
            const pane = tab && window.TermPanes.panes.get(tab.focusedSessionId);
            if (!pane) return;
            const lines = window.TermPanes.promptLines(pane.sessionId);
            if (!lines.length) return;
            e.preventDefault();
            const at = pane.term.buffer.active.viewportY;
            const target = e.code === 'ArrowUp'
                ? [...lines].reverse().find((l) => l < at)
                : lines.find((l) => l > at);
            if (target !== undefined) pane.term.scrollToLine(target);
            else if (e.code === 'ArrowDown') pane.term.scrollToBottom();
            return;
        }

        if (e.ctrlKey && e.shiftKey && e.code === 'KeyB') {
            e.preventDefault();
            window.MultiExec.toggleBroadcast();
        } else if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
            e.preventDefault();
            window.MultiExec.pasteAll();
        } else if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
            // The advertised copy half of "Ctrl+Shift+C/V": copy the focused
            // pane's selection. Harmless in mode 1, where selecting already
            // copied it.
            const tab = window.Tabs.active();
            const pane = tab && window.TermPanes.panes.get(tab.focusedSessionId);
            const sel = pane && pane.term.getSelection();
            if (sel) {
                e.preventDefault();
                navigator.clipboard.writeText(sel).catch(() => { /* focus lost */ });
            }
        } else if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') {
            e.preventDefault();
            window.DiffUI.comparePanes();
        } else if (e.code === 'KeyR' && !e.ctrlKey && !e.altKey && !e.metaKey) {
            // Bare R reconnects, but ONLY in a pane whose session is already
            // dead - anywhere else it is just the letter R and must reach the
            // terminal or the text field the user is typing in. xterm's own
            // focus target IS a textarea (.xterm-helper-textarea), and a dead
            // pane usually still holds focus there - that is exactly where
            // the "press R" hint is pointing, so it must not bail out.
            const tag = (e.target.tagName || '').toLowerCase();
            const inTerminal = e.target.classList &&
                e.target.classList.contains('xterm-helper-textarea');
            if (!inTerminal &&
                (tag === 'input' || tag === 'textarea' || e.target.isContentEditable)) return;
            const tab = window.Tabs.active();
            const sid = tab && tab.focusedSessionId;
            if (sid && window.TermPanes.isDead(sid)) {
                e.preventDefault();
                e.stopPropagation();
                reconnectPane(sid);
            }
        }
    }, true);

    // --- theme picker -----------------------------------------------------
    // themes.js applies the palette on change; this second listener re-derives
    // the terminal palette from the new --se-* values. Registered after
    // wirePicker so it runs once the variables are already on :root.
    const themePicker = document.getElementById('theme-picker');
    window.Themes.wirePicker(themePicker);
    themePicker.addEventListener('change', () => window.TermPanes.refreshTheme());

    // --- session tree -----------------------------------------------------
    window.SessionTree.wireToolbar();
    window.SessionTree.refresh();
    window.SftpPanel.wire();

    // --- sidebar resizing -------------------------------------------------
    // A fixed-width sidebar is the thing that made the old right-hand file
    // panel unusable on a small window; being able to drag this one is the
    // other half of that fix. Width is remembered.
    (function wireResizer() {
        const sidebar = document.getElementById('sidebar');
        const resizer = document.getElementById('sidebar-resizer');
        const MIN = 160;
        const MAX = 640;

        rsterm.invoke('rs:settings.get').then((s) => {
            const w = s && s.sidebarWidth;
            if (w) sidebar.style.width = `${Math.min(MAX, Math.max(MIN, w))}px`;
        });

        let dragging = false;
        resizer.addEventListener('mousedown', (e) => {
            dragging = true;
            resizer.classList.add('dragging');
            // The terminals must not eat the drag once the pointer crosses
            // into them.
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const w = Math.min(MAX, Math.max(MIN, e.clientX - sidebar.getBoundingClientRect().left));
            sidebar.style.width = `${w}px`;
        });
        window.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            resizer.classList.remove('dragging');
            document.body.style.userSelect = '';
            const w = parseInt(sidebar.style.width, 10);
            if (w) rsterm.invoke('rs:settings.update', { sidebarWidth: w });
            // Panes must re-measure: the grid just changed width.
            window.Grid.refit();
        });
    })();

    // --- smoke harness ----------------------------------------------------
    rsterm.invoke('rs:app.bootconfig').then(async (cfg) => {
        if (!cfg || !cfg.smoke) return;

        // Smoke runs answer the human dialogs by driving the real UI - fill
        // the password field, click the primary button - so the dialog flow
        // itself is part of what the run proves.
        const clickTopModal = (fillPassword) => setTimeout(() => {
            const backdrops = document.querySelectorAll('.modal-backdrop');
            const top = backdrops[backdrops.length - 1];
            if (!top) return;
            if (fillPassword) {
                const input = top.querySelector('input[type="password"]');
                if (input) input.value = cfg.password || 'nettest';
            }
            const primary = top.querySelector('.modal-actions .primary');
            if (primary) primary.click();
        }, 400);
        rsterm.on('rs:evt.needs-password', () => clickTopModal(true));
        rsterm.on('rs:evt.hostkey-prompt', () => clickTopModal(false));

        if (cfg.tree) {
            // Saved-session path: open the whole seeded folder in one grid,
            // exercising profile prompt, canary fan-out, and the jump host.
            const nodes = await rsterm.invoke('rs:tree.get');
            const ids = Object.values(nodes)
                .filter((n) => n.type === 'session')
                .map((n) => n.id);
            await window.SessionTree.openSessions(ids, true);
            setTimeout(() => {
                const tab = window.Tabs.active();
                if (!tab) return;
                for (const sid of tab.sessionIds) {
                    const p = window.TermPanes.panes.get(sid);
                    if (p && p.port) p.port.postMessage({ t: 'stdin', data: cfg.cmd + '\r' });
                }
                if (cfg.sftp) {
                    const ssh = tab.sessionIds
                        .map((sid) => window.TermPanes.panes.get(sid))
                        .find((p) => p && p.transport === 'ssh');
                    if (ssh) window.SftpPanel.openFor(ssh.sessionId, ssh.title);
                }
            }, 3500);
            return;
        }

        if (cfg.grid) {
            // cfg.grid: "ssh:2222,telnet:2323,..." - all into one tab, then
            // broadcast the command to every pane.
            const specs = cfg.grid.split(',').map((s) => {
                const [transport, port] = s.split(':');
                return {
                    transport, host: '127.0.0.1', port: Number(port),
                    username: 'nettest', password: 'nettest',
                };
            });
            await connect(specs[0], false);
            for (const spec of specs.slice(1)) await connect(spec, true);
            window.MultiExec.toggleBroadcast();
            setTimeout(() => {
                const tab = window.Tabs.active();
                const first = tab && tab.sessionIds[0];
                if (!first) return;
                const targets = window.MultiExec.routeInput(first);
                for (const sid of targets) {
                    const p = window.TermPanes.panes.get(sid);
                    if (p && p.port) p.port.postMessage({ t: 'stdin', data: cfg.cmd + '\r' });
                }
            }, 2000);
            return;
        }

        // No target: the probe is driving the UI itself, so do not dial
        // anything and do not put a dialog in its way.
        if (!cfg.host) return;

        connect({
            transport: cfg.transport, host: cfg.host, port: cfg.port,
            username: cfg.username, password: cfg.password,
        }, false).then(() => {
            setTimeout(() => {
                const panes = [...window.TermPanes.panes.values()];
                console.log('RSMT_DIAG ' + JSON.stringify({
                    panes: panes.length,
                    withPort: panes.filter((p) => !!p.port).length,
                    states: panes.map((p) => p.state),
                    cmd: cfg.cmd,
                }));
                for (const pane of panes) {
                    if (pane.port) pane.port.postMessage({ t: 'stdin', data: cfg.cmd + '\r' });
                }
            }, 1500);
        }, (err) => console.log('RSMT_DIAG connect rejected: ' + err.message));
    });
})();
