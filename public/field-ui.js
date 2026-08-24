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

    rsterm.on('rs:evt.field', (m) => {
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

        body.append(rootRow, row('Serve on', fBind),
            row('TFTP port', fTftpPort), row('HTTP port', fHttpPort),
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
                if (!fRoot.value.trim()) { fRoot.focus(); return; }
                try {
                    await rsterm.invoke('rs:field.start', {
                        id: kind, kind,
                        root: fRoot.value.trim(),
                        bind: fBind.value,
                        port: Number(kind === 'tftp' ? fTftpPort.value : fHttpPort.value),
                        allowWrites: kind === 'tftp' && fWrites.checked,
                        listing: kind === 'http' && fListing.checked,
                        stopAfterMinutes: Number(fStop.value) || 60,
                    });
                    logLines.push(`${new Date().toLocaleTimeString()}  ${kind.toUpperCase()} started ` +
                        `on ${fBind.value}:${kind === 'tftp' ? fTftpPort.value : fHttpPort.value}`);
                    remember({
                        root: fRoot.value.trim(), bind: fBind.value,
                        tftpPort: Number(fTftpPort.value) || 69,
                        httpPort: Number(fHttpPort.value) || 8080,
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
        actions.append(startBtn('tftp', 'Start TFTP'), startBtn('http', 'Start HTTP'));
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
            await refreshButton();
        }
        dialog = { render };
        await render();

        open('Field tools', body, [
            { label: 'Close', primary: true },
        ], { onCancel: () => { dialog = null; } });
    }

    const btn = document.getElementById('field-btn');
    if (btn) btn.addEventListener('click', openPanel);
    refreshButton();

    window.FieldUI = { openPanel, refreshButton };
})();
