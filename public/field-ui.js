'use strict';
// The Field tools panel: a TFTP or HTTP server for pushing an image to a
// device, and Wake-on-LAN.
//
// This is the one place the app listens for inbound connections, so the
// dialog is built to make that impossible to miss: the bind address is a
// deliberate choice from this machine's actual addresses, TFTP starts
// read-only, every server carries a stop time, and while anything is
// running the toolbar button says so. The engine owns the sockets.

(function () {
    const { open, row, input, select } = window.Modals;

    let dialog = null;
    let logLines = [];
    let logEl = null;
    // Syslog is kept at module scope so messages accumulate whether or not
    // the panel is open - the sink runs in the engine either way, and a
    // change window is exactly when the dialog is closed.
    const syslogLines = [];
    let syslogRender = null;
    const SYSLOG_KEEP = 5000;

    const fmtSyslog = (e) => `${new Date(e.at).toLocaleTimeString()}  ` +
        `${(e.severityName || '-').padEnd(6)} ${String(e.from).padEnd(15)}  ${e.text}`;

    // --- toolbar state --------------------------------------------------
    // A listening service must be visible from the main window, not only
    // from inside the dialog that started it.
    async function refreshButton() {
        const btn = document.getElementById('field-btn');
        if (!btn) return;
        let running = [];
        try {
            running = (await rsterm.invoke('rs:field.list')).servers || [];
        } catch (_) { /* engine restarting */ }
        btn.classList.toggle('serving', running.length > 0);
        btn.textContent = running.length
            ? `Field tools: ${running.map((s) => s.kind.toUpperCase()).join(' + ')}`
            : 'Field tools';
        return running;
    }

    // Painting is coalesced onto an animation frame: a chatty estate at
    // debug level arrives faster than a human reads, and re-rendering up to
    // 5,000 lines per datagram (filter, slice, map, join, then a
    // scrollHeight read that forces layout) is enough to peg the renderer
    // with no attacker involved. The highlighter has been throttled for the
    // same reason since it was written.
    let syslogPaint = 0;
    function scheduleSyslogRender() {
        if (!syslogRender || syslogPaint) return;
        syslogPaint = requestAnimationFrame(() => {
            syslogPaint = 0;
            if (syslogRender) syslogRender();
        });
    }

    rsterm.on('rs:evt.field', (m) => {
        if (m.t === 'field-syslog' && m.entry) {
            syslogLines.push(m.entry);
            // A ring rather than shift(): shift() on a full 5,000-element
            // array is O(n) per message, and this runs per datagram.
            if (syslogLines.length > SYSLOG_KEEP) {
                syslogLines.splice(0, syslogLines.length - SYSLOG_KEEP);
            }
            scheduleSyslogRender();
            return;
        }
        if (m.t === 'field-log') {
            logLines.push(`${new Date(m.at).toLocaleTimeString()}  ${m.text}` +
                (m.detail ? `  (${m.detail})` : ''));
            logLines = logLines.slice(-200);
            if (logEl) { logEl.textContent = logLines.join('\n'); logEl.scrollTop = logEl.scrollHeight; }
        }
        if (m.t === 'field-state' && m.state === 'stopped') {
            logLines.push(`${new Date().toLocaleTimeString()}  stopped - ${m.reason}`);
            if (logEl) logEl.textContent = logLines.join('\n');
            refreshButton();
            if (dialog) dialog.render();
        }
    });

    // --- the panel --------------------------------------------------------
    // What the dialog opens with. Remembered because re-typing a path
    // every time you push an image is the kind of friction that stops a
    // tool being used - but remembering is ALL it does: nothing here starts
    // a server, and the saved bind address is checked against the machine's
    // real addresses before it is offered (a laptop that moved networks
    // must not silently bind to an address that no longer exists).
    async function remember(patch) {
        try {
            await rsterm.invoke('rs:settings.update', { field: patch });
        } catch (_) { /* a preference; never worth interrupting the user for */ }
    }

    async function openPanel() {
        const [state, settings] = await Promise.all([
            rsterm.invoke('rs:field.list'),
            rsterm.invoke('rs:settings.get'),
        ]);
        const saved = settings.field || {};
        const body = document.createElement('div');
        body.style.minWidth = '560px';

        const intro = document.createElement('p');
        intro.style.cssText = 'margin:0 0 10px;color:var(--se-txt-dim);font-size:12px;';
        intro.textContent = 'Serves one folder to devices that pull from you - an image onto a ' +
            'switch, a config off it. Nothing listens until you press start, everything stops ' +
            'on its own, and the toolbar says so while it runs.';
        body.appendChild(intro);

        // Address: the machine's real addresses, plus an explicit all.
        const addrs = (state.interfaces || []).filter((i) => !i.internal);
        const loopback = (state.interfaces || []).filter((i) => i.internal);
        const bindOpts = addrs.map((i) => ({ value: i.address, label: `${i.address} (${i.name})` }))
            .concat(loopback.map((i) => ({ value: i.address, label: `${i.address} (this machine only)` })))
            .concat([{ value: '0.0.0.0', label: 'All addresses - anything that can route here' }]);
        const stillHere = saved.bind && bindOpts.some((o) => o.value === saved.bind);
        const fBind = select(bindOpts.length ? bindOpts : [{ value: '0.0.0.0', label: 'All addresses' }],
            stillHere ? saved.bind : (addrs.length ? addrs[0].address : '0.0.0.0'));

        const fRoot = input(saved.root || '', 'pick a folder to serve');
        fRoot.style.flex = '1';
        const browse = document.createElement('button');
        browse.textContent = 'Browse...';
        browse.addEventListener('click', async () => {
            const dir = await rsterm.invoke('rs:sftp.pickFolder');
            if (dir) { fRoot.value = dir; remember({ root: dir }); }
        });
        const rootRow = document.createElement('div');
        rootRow.className = 'field-row';
        const rootLabel = document.createElement('label');
        rootLabel.textContent = 'Folder';
        rootRow.append(rootLabel, fRoot, browse);

        const fTftpPort = input(saved.tftpPort || 69, '69', 'number');
        const fHttpPort = input(saved.httpPort || 8080, '8080', 'number');
        const fStop = input(saved.stopAfterMinutes || 60, '60', 'number');
        const fWrites = document.createElement('input');
        fWrites.type = 'checkbox';
        const writesLabel = document.createElement('label');
        writesLabel.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:12px;' +
            'color:var(--se-txt-dim);';
        const writesText = document.createElement('span');
        writesText.textContent = 'Let devices upload INTO this folder (TFTP has no password - ' +
            'anything that can reach the port can write)';
        writesLabel.append(fWrites, writesText);

        const fListing = document.createElement('input');
        fListing.type = 'checkbox';
        fListing.checked = true;
        const listingLabel = document.createElement('label');
        listingLabel.style.cssText = writesLabel.style.cssText;
        const listingText = document.createElement('span');
        listingText.textContent = 'HTTP: allow browsing the folder contents';
        listingLabel.append(fListing, listingText);

        // 514 needs admin on Windows, same as TFTP's 69, and the error
        // says so - but a lot of gear can be pointed at a high port.
        const fSyslogPort = input(saved.syslogPort || 514, '514', 'number');

        body.append(rootRow, row('Serve on', fBind),
            row('TFTP port', fTftpPort), row('HTTP port', fHttpPort),
            row('Syslog port', fSyslogPort),
            row('Stop after (min)', fStop), writesLabel, listingLabel);

        // Running servers.
        const runningBox = document.createElement('div');
        runningBox.style.cssText = 'margin-top:12px;';
        body.appendChild(runningBox);

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;';
        const startBtn = (kind, label) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.addEventListener('click', async () => {
                // A syslog sink serves no folder; only the file servers
                // need one picked first.
                if (kind !== 'syslog' && !fRoot.value.trim()) { fRoot.focus(); return; }
                const port = kind === 'tftp' ? fTftpPort.value
                    : kind === 'syslog' ? fSyslogPort.value : fHttpPort.value;
                try {
                    await rsterm.invoke('rs:field.start', {
                        id: kind, kind,
                        root: kind === 'syslog' ? null : fRoot.value.trim(),
                        bind: fBind.value,
                        port: Number(port),
                        allowWrites: kind === 'tftp' && fWrites.checked,
                        listing: kind === 'http' && fListing.checked,
                        stopAfterMinutes: Number(fStop.value) || 60,
                    });
                    logLines.push(`${new Date().toLocaleTimeString()}  ${kind.toUpperCase()} started ` +
                        `on ${fBind.value}:${port}`);
                    remember({
                        // Starting a syslog sink with the folder blank must
                        // not blank the REMEMBERED folder.
                        root: fRoot.value.trim() || (saved.root || null), bind: fBind.value,
                        tftpPort: Number(fTftpPort.value) || 69,
                        httpPort: Number(fHttpPort.value) || 8080,
                        syslogPort: Number(fSyslogPort.value) || 514,
                        stopAfterMinutes: Number(fStop.value) || 60,
                    });
                    await render();
                } catch (err) {
                    const hint = /EACCES|EPERM/i.test(err.message)
                        ? ' - ports below 1024 need admin rights; try 6969 or 8080'
                        : /EADDRINUSE/i.test(err.message) ? ' - something else is already on that port' : '';
                    window.Forms.showBanner('error', `Field tools: ${err.message}${hint}`);
                }
            });
            return b;
        };
        actions.append(startBtn('tftp', 'Start TFTP'), startBtn('http', 'Start HTTP'),
            startBtn('syslog', 'Start syslog'));
        body.appendChild(actions);

        // Wake-on-LAN: not a server, so it sits apart.
        const wolWrap = document.createElement('div');
        wolWrap.style.cssText = 'margin-top:14px;border-top:1px solid var(--se-border);padding-top:10px;';
        const fMac = input('', '00:11:22:33:44:55');
        fMac.style.flex = '1';
        const wakeBtn = document.createElement('button');
        wakeBtn.textContent = 'Wake';
        wakeBtn.addEventListener('click', async () => {
            try {
                const r = await rsterm.invoke('rs:field.wake', { mac: fMac.value.trim() });
                logLines.push(`${new Date().toLocaleTimeString()}  magic packet sent to ${r.mac}`);
                await render();
            } catch (err) {
                window.Forms.showBanner('error', `Wake-on-LAN: ${err.message}`);
            }
        });
        const wolRow = document.createElement('div');
        wolRow.className = 'field-row';
        const wolLabel = document.createElement('label');
        wolLabel.textContent = 'Wake on LAN';
        wolRow.append(wolLabel, fMac, wakeBtn);
        const wolHint = document.createElement('p');
        wolHint.style.cssText = 'margin:2px 0 0;color:var(--se-txt-dim);font-size:11px;';
        wolHint.textContent = 'Broadcast on this network only - a magic packet does not route.';
        wolWrap.append(wolRow, wolHint);
        body.appendChild(wolWrap);

        // --- syslog view ---------------------------------------------
        // Its own pane rather than mixing into the activity log: this is
        // the thing you WATCH during a change window, and it wants a
        // severity filter and a way off the machine.
        const sysWrap = document.createElement('div');
        sysWrap.style.cssText = 'margin-top:14px;border-top:1px solid var(--se-border);padding-top:10px;';
        const sysHead = document.createElement('div');
        sysHead.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
        const sysTitle = document.createElement('span');
        sysTitle.style.cssText = 'font-size:12px;color:var(--se-txt-dim);flex:1;';
        sysTitle.textContent = 'Syslog';
        const fSeverity = select([
            { value: '7', label: 'everything' },
            { value: '6', label: 'info and worse' },
            { value: '4', label: 'warnings and worse' },
            { value: '3', label: 'errors and worse' },
        ], '7');
        const btnClear = document.createElement('button');
        btnClear.textContent = 'Clear';
        const btnSave = document.createElement('button');
        btnSave.textContent = 'Save...';
        sysHead.append(sysTitle, fSeverity, btnClear, btnSave);

        const sysEl = document.createElement('pre');
        sysEl.style.cssText = 'margin-top:6px;height:150px;overflow:auto;font-family:var(--mt-mono);' +
            'font-size:11px;background:var(--se-input);border:1px solid var(--se-border);' +
            'border-radius:4px;padding:6px 8px;';
        sysWrap.append(sysHead, sysEl);
        body.appendChild(sysWrap);

        const renderSyslog = () => {
            const floor = Number(fSeverity.value);
            const shown = syslogLines.filter((e) =>
                e.severity === null || e.severity <= floor);
            sysEl.textContent = shown.slice(-500).map(fmtSyslog).join('\n');
            sysEl.scrollTop = sysEl.scrollHeight;
            sysTitle.textContent = syslogLines.length
                ? `Syslog - ${syslogLines.length} message${syslogLines.length === 1 ? '' : 's'}` +
                  (shown.length !== syslogLines.length ? `, ${shown.length} shown` : '')
                : 'Syslog - nothing received yet';
        };
        syslogRender = renderSyslog;
        fSeverity.addEventListener('change', renderSyslog);
        btnClear.addEventListener('click', () => { syslogLines.length = 0; renderSyslog(); });
        btnSave.addEventListener('click', async () => {
            const floor = Number(fSeverity.value);
            const text = syslogLines
                .filter((e) => e.severity === null || e.severity <= floor)
                .map(fmtSyslog).join('\r\n');
            if (!text) return;
            // Reuses the terminal's save-text path: one place decides where
            // app-written files may land.
            await rsterm.invoke('rs:term.saveText', {
                name: `syslog-${new Date().toISOString().slice(0, 10)}.log`, text });
        });

        logEl = document.createElement('pre');
        logEl.style.cssText = 'margin-top:12px;height:120px;overflow:auto;font-family:var(--mt-mono);' +
            'font-size:11px;background:var(--se-input);border:1px solid var(--se-border);' +
            'border-radius:4px;padding:6px 8px;';
        logEl.textContent = logLines.join('\n');
        body.appendChild(logEl);

        async function render() {
            const now = await rsterm.invoke('rs:field.list');
            runningBox.replaceChildren();
            const running = now.servers || [];
            if (!running.length) {
                const p = document.createElement('p');
                p.style.cssText = 'margin:0;color:var(--se-txt-dim);font-size:12px;';
                p.textContent = 'Nothing is listening.';
                runningBox.appendChild(p);
            }
            for (const s of running) {
                const line = document.createElement('div');
                line.className = 'field-row';
                const what = document.createElement('span');
                what.style.flex = '1';
                const mins = Math.max(0, Math.round((s.stopsAt - Date.now()) / 60000));
                what.textContent = `${s.kind.toUpperCase()} on ${s.bind}:${s.port} - ${s.root}` +
                    (s.kind === 'tftp' ? (s.allowWrites ? ' - uploads allowed' : ' - read-only') : '') +
                    ` - stops in ${mins} min`;
                // The loop between the server and the session in the next
                // pane: with the address and port already known, the
                // device-side command is a clipboard away instead of a
                // thing to get wrong by hand.
                if (s.kind === 'tftp' || s.kind === 'http') {
                    const copy = document.createElement('button');
                    copy.textContent = 'Copy fetch command';
                    copy.title = 'Put the device-side command on the clipboard';
                    copy.addEventListener('click', () => fetchMenu(copy, s));
                    line.appendChild(copy);
                }
                const stop = document.createElement('button');
                stop.textContent = 'Stop';
                stop.addEventListener('click', async () => {
                    await rsterm.invoke('rs:field.stop', { id: s.id });
                    logLines.push(`${new Date().toLocaleTimeString()}  ${s.kind.toUpperCase()} stopped`);
                    await render();
                });
                line.append(what, stop);
                runningBox.appendChild(line);
            }
            logEl.textContent = logLines.join('\n');
            logEl.scrollTop = logEl.scrollHeight;
            // A sink already running when the panel opens has history the
            // panel never saw; pull it once rather than starting blank.
            const sink = running.find((s) => s.kind === 'syslog');
            if (sink && !syslogLines.length) {
                try {
                    const got = await rsterm.invoke('rs:field.syslog', { id: sink.id });
                    if (got && got.lines) syslogLines.push(...got.lines);
                } catch (_) { /* the sink stopped between list and ask */ }
            }
            renderSyslog();
            await refreshButton();
        }
        dialog = { render };
        await render();

        // syslogRender closes over THIS dialog's elements. Leaving it set
        // kept the app re-rendering a detached <pre> for every datagram for
        // the rest of the process's life, holding the closed dialog's DOM
        // alive with it.
        //
        // It has to hang off BOTH exits. Modals.open calls onCancel for
        // Escape and for a backdrop click, but an action button only calls
        // its own onClick - so hanging cleanup on onCancel alone means the
        // Close button, the way almost everyone shuts this dialog, skips
        // it. (The pre-existing `dialog = null` had the same hole.)
        const teardown = () => {
            dialog = null;
            syslogRender = null;
            if (syslogPaint) { cancelAnimationFrame(syslogPaint); syslogPaint = 0; }
        };
        open('Field tools', body, [
            { label: 'Close', primary: true, onClick: teardown },
        ], { onCancel: teardown });
    }

    // What a device would type to pull a file from this server. The
    // address is the one the server is BOUND to - if it is listening on
    // 0.0.0.0 the device needs a real address, so the first non-internal
    // interface stands in and the menu says which.
    function fetchCommands(server, addr, file) {
        const f = file || 'FILE';
        if (server.kind === 'tftp') {
            return [
                { label: 'Cisco IOS - copy to flash', text: `copy tftp://${addr}/${f} flash:` },
                { label: 'Cisco IOS - copy running-config out',
                    text: `copy running-config tftp://${addr}/${f}` },
                { label: 'Linux - tftp get', text: `tftp -g -r ${f} ${addr}` },
                { label: 'ROMMON - tftpdnld', text:
                    `TFTP_SERVER=${addr}\nTFTP_FILE=${f}\ntftpdnld` },
            ];
        }
        return [
            { label: 'curl', text: `curl -O http://${addr}:${server.port}/${f}` },
            { label: 'wget', text: `wget http://${addr}:${server.port}/${f}` },
            { label: 'Cisco IOS - copy to flash',
                text: `copy http://${addr}:${server.port}/${f} flash:` },
            { label: 'PowerShell',
                text: `Invoke-WebRequest http://${addr}:${server.port}/${f} -OutFile ${f}` },
        ];
    }

    async function fetchMenu(anchor, server) {
        const state = await rsterm.invoke('rs:field.list');
        let addr = server.bind;
        let note = null;
        if (addr === '0.0.0.0') {
            const real = (state.interfaces || []).find((i) => !i.internal);
            addr = real ? real.address : '0.0.0.0';
            note = real ? `using ${real.address} (${real.name})` : null;
        }
        const file = await window.Modals.promptText('Copy fetch command',
            'File name on the server (leave blank for a placeholder)', '');
        if (file === null) return;
        const items = fetchCommands(server, addr, file.trim()).map((c) => ({
            label: c.label,
            onClick: async () => {
                try {
                    await navigator.clipboard.writeText(c.text);
                    logLines.push(`${new Date().toLocaleTimeString()}  copied: ${c.text.split('\n')[0]}`);
                    if (logEl) logEl.textContent = logLines.join('\n');
                } catch (err) {
                    window.Forms.showBanner('error', `Clipboard: ${err.message}`);
                }
            },
        }));
        if (note) items.unshift({ label: note, disabled: true }, null);
        const r = anchor.getBoundingClientRect();
        window.Modals.menu(r.left, r.bottom + 2, items);
    }

    const btn = document.getElementById('field-btn');
    if (btn) btn.addEventListener('click', openPanel);
    refreshButton();

    window.FieldUI = { openPanel, refreshButton };
})();
