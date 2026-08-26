'use strict';
// The tunnel manager: saved port forwards, their live state, and the
// open/close controls. Three kinds, in the order people reach for them:
//
//   Local (-L)    localhost:PORT -> device:PORT through the SSH endpoint.
//                 The web GUI of a switch that only listens on a management
//                 VLAN you cannot route to.
//   SOCKS (-D)    a local SOCKS5 proxy; point a browser at it and every
//                 address it asks for is resolved and dialed from the far
//                 side. One tunnel for a whole management network.
//   Remote (-R)   the far side listens and dials back to you. Rare, and
//                 dangerous to leave running, so it says so.

(function () {
    const { open, row, input, select } = window.Modals;

    let defs = [];
    let live = new Map();   // id -> status from the engine
    let refreshTimer = null;
    let listEl = null;

    function load() {
        return rsterm.invoke('rs:tunnels.list').then((t) => { defs = t || []; });
    }
    load();

    rsterm.on('rs:evt.tunnel-state', (m) => {
        if (m.state === 'closed' || m.state === 'error') {
            live.delete(m.id);
            if (m.detail) window.Forms.showBanner(m.state === 'error' ? 'error' : 'warn',
                `Tunnel: ${m.detail}`);
        }
        renderList();
    });

    async function refreshStatus() {
        try {
            const rows = await rsterm.invoke('rs:tunnels.status');
            live = new Map((rows || []).map((r) => [r.id, r]));
        } catch (_) { /* engine restarting; the next tick retries */ }
        renderList();
    }

    const human = (n) => {
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1024 / 1024).toFixed(1)} MB`;
    };

    // The LIVE port when running: a definition asking for port 0 gets an
    // ephemeral one, and "127.0.0.1:0" tells nobody where to point a
    // browser. Falls back to the saved value (0 shown as "auto") when the
    // tunnel is not running.
    function describe(def, st) {
        const port = st && st.bindPort ? st.bindPort : (def.bindPort || 'auto');
        const bind = `${def.bindHost}:${port}`;
        if (def.kind === 'dynamic') return `SOCKS5 on ${bind}`;
        if (def.kind === 'remote') return `remote ${bind} -> ${def.destHost}:${def.destPort}`;
        return `${bind} -> ${def.destHost}:${def.destPort}`;
    }

    function endpointName(def) {
        const nodes = window.SessionTree.allNodes();
        const n = nodes[def.nodeId];
        return n ? n.name : '(missing session)';
    }

    function renderList() {
        if (!listEl) return;
        listEl.replaceChildren();
        if (!defs.length) {
            const empty = document.createElement('p');
            empty.style.color = 'var(--se-txt-dim)';
            empty.textContent = 'No tunnels yet.';
            listEl.appendChild(empty);
            return;
        }
        for (const def of defs) {
            const st = live.get(def.id);
            const line = document.createElement('div');
            line.className = 'merge-row';

            const dot = document.createElement('span');
            dot.className = 'status-dot ' + (st ? 'connected' : 'closed');
            dot.title = st ? 'open' : 'not running';

            const label = document.createElement('span');
            label.style.flex = '1';
            const name = document.createElement('div');
            name.textContent = `${def.name}  ·  ${endpointName(def)}`;
            const detail = document.createElement('div');
            detail.className = 'merge-detail';
            detail.style.margin = '0';
            detail.textContent = describe(def, st) +
                (st ? `  ·  ${st.active} active, ${st.conns} total, ↑${human(st.bytesUp)} ↓${human(st.bytesDown)}` : '');
            label.append(name, detail);

            const act = (txt, fn, title) => {
                const b = document.createElement('button');
                b.textContent = txt;
                if (title) b.title = title;
                b.addEventListener('click', fn);
                return b;
            };

            line.append(dot, label);
            if (st) {
                line.appendChild(act('Close', async () => {
                    await rsterm.invoke('rs:tunnels.close', { id: def.id });
                    live.delete(def.id);
                    renderList();
                }));
            } else {
                line.appendChild(act('Open', async () => {
                    try {
                        const r = await rsterm.invoke('rs:tunnels.open', { id: def.id });
                        if (r) live.set(def.id, r);
                        window.Forms.showBanner('warn',
                            `Tunnel "${def.name}" is open on ${r.bindHost}:${r.bindPort}.`);
                        renderList();
                    } catch (err) {
                        window.Forms.showBanner('error', `Tunnel: ${err.message}`);
                    }
                }, 'Dial the SSH endpoint (sharing its connection if a session is already up) and start listening'));
            }
            line.append(
                act('Edit', () => editDialog(def)),
                act('Delete', async () => {
                    if (live.has(def.id)) await rsterm.invoke('rs:tunnels.close', { id: def.id });
                    await rsterm.invoke('rs:tunnels.delete', { id: def.id });
                    await load();
                    renderList();
                }));
            listEl.appendChild(line);
        }
    }

    function editDialog(existing) {
        const nodes = window.SessionTree.allNodes();
        const sshSessions = Object.values(nodes)
            .filter((n) => n.type === 'session' && (n.transport || 'ssh') === 'ssh')
            .sort((a, b) => a.name.localeCompare(b.name));
        if (!sshSessions.length) {
            window.Forms.showBanner('warn', 'Save an SSH session first - a tunnel runs over one.');
            return;
        }

        const body = document.createElement('div');
        body.style.minWidth = '460px';

        const name = input(existing ? existing.name : '', 'Switch web GUI');
        const kind = select([
            { value: 'local', label: 'Local  (-L)  listen here, reach a device' },
            { value: 'dynamic', label: 'SOCKS  (-D)  proxy a whole network' },
            { value: 'remote', label: 'Remote (-R)  the far side listens' },
        ], existing ? existing.kind : 'local');
        const endpoint = select(
            sshSessions.map((n) => ({ value: n.id, label: `${n.name}  (${n.host})` })),
            existing ? existing.nodeId : sshSessions[0].id);
        const bindHost = input(existing ? existing.bindHost : '127.0.0.1', '127.0.0.1');
        const bindPort = input(existing ? existing.bindPort : '', '8443');
        const destHost = input(existing ? existing.destHost || '' : '', '10.0.0.1');
        const destPort = input(existing ? existing.destPort || '' : '', '443');
        const autoStart = document.createElement('input');
        autoStart.type = 'checkbox';
        autoStart.checked = !!(existing && existing.autoStart);
        const notes = input(existing ? existing.notes || '' : '', 'optional');

        const destRow = row('Destination host', destHost);
        const destPortRow = row('Destination port', destPort);
        const hint = document.createElement('p');
        hint.style.cssText = 'margin:6px 0 0;color:var(--se-txt-dim);font-size:11px;';

        const syncKind = () => {
            const dynamic = kind.value === 'dynamic';
            destRow.hidden = dynamic;
            destPortRow.hidden = dynamic;
            hint.textContent = dynamic
                ? 'A SOCKS5 proxy on the listen port. Point a browser (or anything that speaks SOCKS5) at it and every address it asks for is dialed from the far side.'
                : kind.value === 'remote'
                    ? 'The SSH server listens and dials back to this machine. Servers usually bind remote forwards to their own loopback unless GatewayPorts is on - and a forgotten remote forward is a way in, so close it when done.'
                    : 'Listens here and forwards to the destination through the SSH endpoint. The classic "reach the switch GUI on a management VLAN" tunnel.';
        };
        kind.addEventListener('change', syncKind);

        body.append(
            row('Name', name),
            row('Kind', kind),
            row('Through session', endpoint),
            row('Listen host', bindHost),
            row('Listen port', bindPort),
            destRow, destPortRow,
            row('Open automatically', autoStart),
            row('Notes', notes),
            hint);
        syncKind();

        open(existing ? 'Edit tunnel' : 'New tunnel', body, [
            { label: 'Cancel' },
            {
                label: 'Save', primary: true,
                onClick: async () => {
                    const def = {
                        id: existing ? existing.id : undefined,
                        name: name.value, kind: kind.value, nodeId: endpoint.value,
                        bindHost: bindHost.value, bindPort: Number(bindPort.value),
                        destHost: destHost.value, destPort: Number(destPort.value),
                        autoStart: autoStart.checked, notes: notes.value,
                    };
                    try {
                        await rsterm.invoke('rs:tunnels.upsert', def);
                    } catch (err) {
                        window.Forms.showBanner('error', `Tunnel: ${err.message}`);
                        return false;
                    }
                    await load();
                    renderList();
                },
            },
        ]);
        name.focus();
    }

    function openManager() {
        const body = document.createElement('div');
        body.style.minWidth = '560px';

        const hint = document.createElement('p');
        hint.style.cssText = 'margin-bottom:8px;color:var(--se-txt-dim);font-size:12px;';
        hint.textContent = 'A tunnel runs over a saved SSH session and shares its connection: ' +
            'if that session (or its jump host) is already up, the tunnel costs no ' +
            'second authentication. Listeners bind to 127.0.0.1 unless you say otherwise.';
        body.appendChild(hint);

        listEl = document.createElement('div');
        listEl.style.cssText = 'max-height:50vh;overflow-y:auto;';
        body.appendChild(listEl);

        load().then(refreshStatus);
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(refreshStatus, 2000);

        open('Tunnels', body, [
            {
                label: 'Close', primary: true,
                onClick: () => { clearInterval(refreshTimer); refreshTimer = null; listEl = null; },
            },
            { label: 'New Tunnel', onClick: () => { editDialog(null); return false; } },
        ], {
            onCancel: () => { clearInterval(refreshTimer); refreshTimer = null; listEl = null; },
        });
    }

    // Auto-start: when a session connects, any tunnel marked autoStart on
    // that node opens behind it - the connection is already authenticated,
    // so this is free.
    rsterm.on('rs:evt.session-status', async (m) => {
        if (m.state !== 'connected' || !m.nodeId) return;
        for (const def of defs.filter((d) => d.autoStart && d.nodeId === m.nodeId)) {
            if (live.has(def.id)) continue;
            try {
                const r = await rsterm.invoke('rs:tunnels.open', { id: def.id });
                if (r) { live.set(def.id, r); renderList(); }
            } catch (_) { /* reported in the manager; not worth a banner on connect */ }
        }
    });

    window.Tunnels = { openManager };
})();
