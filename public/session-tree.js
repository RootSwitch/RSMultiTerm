'use strict';
// The saved-session sidebar: folder tree, multi-select, open-in-grid. The
// flat node map is rendered depth-first by parentId + order; expand state is
// renderer-local (not persisted per node, deliberately - a shared tree must
// not sync one person's collapsed folders to everyone).

(function () {
    let nodes = {};
    let healthByNode = {};           // nodeId -> {lastOk, lastFail, streak}
    // Sessions open right now. Two collections because a node can hold
    // several sessions at once (a MultiTerm tab, a duplicated pane) and the
    // marker must survive one of them closing.
    const liveBySession = new Map(); // sessionId -> nodeId
    const liveNodes = new Set();     // nodeIds with at least one open session
    const expanded = new Set();      // folder ids
    const expandedSessions = new Set();
    const effectiveCache = new Map();   // sessionId -> resolved settings
    const selected = new Set();      // node ids
    let lastClicked = null;          // anchor for shift ranges

    // How old a reading is, in words - the tooltip's job is to stop a
    // stale dot from being read as live.
    function describeAge(days) {
        if (days < 1 / 24) return 'Checked in the last hour';
        if (days < 1) return `Checked ${Math.round(days * 24)} hour${Math.round(days * 24) === 1 ? '' : 's'} ago`;
        if (days < 14) return `Checked ${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'} ago`;
        return 'Checked more than two weeks ago';
    }

    // The audit dots are a MEMORY - a reading from the last sweep, faded by
    // age. This one is a STATE: the app's own connection, open at this
    // instant, gone the moment it drops. Nothing is probed for it; it is
    // just what the window already knows about itself.
    const DEAD = new Set(['closed', 'error', 'auth-blocked']);
    rsterm.on('rs:evt.session-status', (m) => {
        if (!m || !m.sessionId) return;
        if (m.state === 'connected' && m.nodeId) liveBySession.set(m.sessionId, m.nodeId);
        else if (DEAD.has(m.state)) { if (!liveBySession.delete(m.sessionId)) return; }
        else return;
        liveNodes.clear();
        for (const id of liveBySession.values()) liveNodes.add(id);
        render();
    });

    async function refresh() {
        nodes = await rsterm.invoke('rs:tree.get');
        // A rename reaches open panes: header, tab strip and status line
        // used to keep the old name until reconnect - confusing when the
        // rename existed to FIX a wrong label.
        let renamed = false;
        for (const pane of window.TermPanes.panes.values()) {
            const n = pane.nodeId && nodes[pane.nodeId];
            if (n && n.name && n.name !== pane.title) {
                pane.title = n.name;
                renamed = true;
            }
        }
        if (renamed) {
            if (window.Grid) window.Grid.render(true);
            if (window.Tabs) window.Tabs.updateStatus();
        }
        healthByNode = await rsterm.invoke('rs:health.get');
        for (const id of [...selected]) if (!nodes[id]) selected.delete(id);
        // Settings may have changed underneath an open row - an edit, a bulk
        // stamp, or a team sync - so resolved values are re-read, not kept.
        effectiveCache.clear();
        for (const id of expandedSessions) {
            if (!nodes[id]) { expandedSessions.delete(id); continue; }
            rsterm.invoke('rs:tree.effective', { id }).then((eff) => {
                effectiveCache.set(id, eff);
                render();
            });
        }
        render();
    }

    function childrenOf(parentId) {
        return Object.values(nodes)
            .filter((n) => (n.parentId || null) === parentId)
            .sort((a, b) => (a.type === b.type ? (a.order || 0) - (b.order || 0)
                : a.type === 'folder' ? -1 : 1));
    }

    // Visible rows in render order, for shift-range selection.
    function visibleRows() {
        const rows = [];
        const walk = (parentId, depth) => {
            for (const n of childrenOf(parentId)) {
                rows.push({ node: n, depth });
                if (n.type === 'folder' && expanded.has(n.id)) walk(n.id, depth + 1);
            }
        };
        walk(null, 0);
        return rows;
    }

    function render() {
        const box = document.getElementById('tree');
        box.replaceChildren();
        const rows = visibleRows();

        if (!rows.length) {
            const hint = document.createElement('div');
            hint.className = 'tree-hint';
            hint.textContent = 'No saved sessions yet. Use + Session / + Folder above, ' +
                'or connect ad hoc from the connect bar.';
            box.appendChild(hint);
            return;
        }

        for (const { node, depth } of rows) {
            const el = document.createElement('div');
            el.className = 'tree-row' + (selected.has(node.id) ? ' selected' : '');
            el.style.paddingLeft = `${8 + depth * 14}px`;
            el.dataset.id = node.id;

            if (node.type === 'folder') {
                const arrow = document.createElement('span');
                arrow.className = 'tree-arrow';
                arrow.textContent = expanded.has(node.id) ? '▾' : '▸';
                arrow.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (expanded.has(node.id)) expanded.delete(node.id);
                    else expanded.add(node.id);
                    render();
                });
                el.appendChild(arrow);
            } else {
                // Sessions get a real expander too: the details it opens are
                // the fields you would otherwise open the editor to read.
                const arrow = document.createElement('span');
                arrow.className = 'tree-arrow';
                arrow.textContent = expandedSessions.has(node.id) ? '▾' : '▸';
                arrow.title = 'Show this session\'s settings';
                arrow.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleSessionDetails(node.id);
                });
                el.appendChild(arrow);
            }

            // Folder or session, said with an icon rather than left to be
            // inferred from whether a host address happens to be present.
            const icon = document.createElement('span');
            icon.className = `tree-icon ${node.type === 'folder' ? 'folder' : 'session'}`;
            el.appendChild(icon);

            const name = document.createElement('span');
            name.className = 'tree-name';
            name.textContent = node.name;
            el.appendChild(name);

            if (node.type === 'session' && node.host) {
                const host = document.createElement('span');
                host.className = 'tree-host';
                host.textContent = node.host;
                el.appendChild(host);
            }

            // Open right now, or - failing that - the last PROBLEM found.
            // The green "answered a while ago" dot is gone on purpose:
            // beside a freshly imported list it read as "I have a session
            // open to that box", which is the one thing a reachability
            // memory must never suggest. Green now means exactly one thing
            // - connected at this moment - and a clean audit shows as no
            // dot at all (the reading still lives in the expanded row).
            const h = healthByNode[node.id];
            const open = node.type === 'session' && liveNodes.has(node.id);
            const down = h && (h.streak || 0) > 0;
            if (open) {
                const dot = document.createElement('span');
                dot.className = 'tree-health live';
                dot.title = 'Connected now - this session is open in this window. ' +
                    'It clears the moment the connection drops.';
                el.appendChild(dot);
            } else if (node.type === 'session' && down) {
                const dot = document.createElement('span');
                // Amber for refused: something answered at that address but
                // not on this port, which is a different problem from a
                // device that has gone away entirely.
                const kind = h.lastState === 'refused' ? 'warn' : 'bad';
                dot.className = `tree-health ${kind}`;
                // These dots are a SNAPSHOT, not a monitor: nothing probes
                // in the background, so a two-week-old red circle at full
                // strength reads as "this device is down right now" when it
                // means "it was down a fortnight ago". Fade with age -
                // fresh is solid, and by the 14-day staleness mark it is a
                // ghost - and say so on hover.
                const measured = Math.max(Date.parse(h.lastOk) || 0, Date.parse(h.lastFail) || 0);
                const ageDays = measured ? (Date.now() - measured) / 86400000 : 99;
                dot.style.opacity = String(Math.max(0.22, Math.min(1, 1 - (ageDays / 14) * 0.78)));
                dot.title = (h.lastState === 'refused'
                    ? `Connection refused on this port ${new Date(h.lastFail).toLocaleString()}` +
                      ' - the address is in use, but not by this service'
                    : `No answer since ${new Date(h.lastFail).toLocaleString()}`) +
                    (h.lastOk ? ` - last answered ${new Date(h.lastOk).toLocaleString()}`
                              : ' - has never answered') +
                    `

${describeAge(ageDays)}. Nothing is probed in the background: ` +
                    'this is from the last Audit, or from a session you opened.';
                el.appendChild(dot);
            }

            el.addEventListener('click', (e) => handleSelect(node, e));
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                treeMenu(e, node);
            });
            el.addEventListener('dblclick', () => {
                if (node.type === 'folder') {
                    if (expanded.has(node.id)) expanded.delete(node.id);
                    else expanded.add(node.id);
                    render();
                } else {
                    openSessions([node.id], 'tabs');
                }
            });
            box.appendChild(el);

            if (node.type === 'session' && expandedSessions.has(node.id)) {
                box.appendChild(detailsFor(node, depth));
            }
        }
    }

    // --- inline session details -------------------------------------------
    // A read-only summary of what this session will actually do, including
    // values it inherits and where they come from. The editor is for changing
    // things; this is for the far more common "what is this set to".
    function toggleSessionDetails(id) {
        if (expandedSessions.has(id)) expandedSessions.delete(id);
        else {
            expandedSessions.add(id);
            if (!effectiveCache.has(id)) {
                rsterm.invoke('rs:tree.effective', { id }).then((eff) => {
                    effectiveCache.set(id, eff);
                    render();
                });
            }
        }
        render();
    }

    function detailsFor(node, depth) {
        const box = document.createElement('div');
        box.className = 'tree-details';
        box.style.paddingLeft = `${8 + depth * 14 + 18}px`;

        const eff = effectiveCache.get(node.id);
        if (!eff) {
            const loading = document.createElement('div');
            loading.className = 'tree-detail-row';
            loading.textContent = 'reading settings...';
            box.appendChild(loading);
            return box;
        }

        const add = (label, value, from) => {
            if (value === null || value === undefined || value === '') return;
            const row = document.createElement('div');
            row.className = 'tree-detail-row';
            const k = document.createElement('span');
            k.className = 'tree-detail-key';
            k.textContent = label;
            const v = document.createElement('span');
            v.className = 'tree-detail-value';
            v.textContent = value;
            // Long notes and profile names still get cut off in a narrow
            // sidebar, so the full text is one hover away.
            v.title = `${label}: ${value}${from ? ` (inherited from ${from})` : ''}`;
            row.append(k, v);
            if (from) {
                // Inherited values say so, so a surprising setting leads
                // straight to the folder that supplied it.
                const src = document.createElement('span');
                src.className = 'tree-detail-from';
                src.textContent = `from ${from}`;
                row.appendChild(src);
            }
            box.appendChild(row);
        };

        const val = (f) => (eff[f] ? eff[f].value : null);
        const src = (f) => (eff[f] ? eff[f].from : null);
        const transport = val('transport') || 'ssh';

        if (transport === 'serial') {
            const s = node.serial || {};
            add('Port', s.device || 'not set');
            add('Baud', s.baud || 9600);
        } else {
            add('Host', node.host);
            add('Port', val('port') || (transport === 'telnet' ? 23 : 22), src('port'));
        }
        add('Transport', transport, src('transport'));
        add('Credentials', val('credentialProfile') || 'none', src('credentialProfile'));

        const jump = val('jumpHost');
        if (jump) add('Jump host', (nodes[jump] || {}).name || 'missing session', src('jumpHost'));

        const logging = val('logging');
        if (logging && typeof logging === 'object') {
            add('Logging', logging.enabled === false ? 'off' : 'on', src('logging'));
        }
        add('Highlights', val('highlightSet'), src('highlightSet'));
        if ((node.tags || []).length) add('Tags', node.tags.join(', '));
        add('Notes', node.notes);

        const health = healthByNode[node.id];
        if (health) {
            add('Last probe', health.streak
                ? `${health.lastState || 'no answer'} (${new Date(health.lastFail).toLocaleString()})`
                : `answered ${new Date(health.lastOk).toLocaleString()}`);
        }
        return box;
    }

    function handleSelect(node, e) {
        if (e.shiftKey && lastClicked) {
            const rows = visibleRows().map((r) => r.node.id);
            const a = rows.indexOf(lastClicked);
            const b = rows.indexOf(node.id);
            if (a !== -1 && b !== -1) {
                if (!e.ctrlKey) selected.clear();
                for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(rows[i]);
            }
        } else if (e.ctrlKey) {
            if (selected.has(node.id)) selected.delete(node.id);
            else selected.add(node.id);
            lastClicked = node.id;
        } else {
            selected.clear();
            selected.add(node.id);
            lastClicked = node.id;
        }
        render();
    }

    // Selection helpers: expand selected folders into their sessions.
    function selectedSessions() {
        const out = [];
        const addFrom = (id) => {
            const n = nodes[id];
            if (!n) return;
            if (n.type === 'session') out.push(n.id);
            else for (const c of childrenOf(n.id)) addFrom(c.id);
        };
        for (const id of selected) addFrom(id);
        return [...new Set(out)];
    }

    // mode: 'tabs'    - one tab each (double-click, or Open)
    //       'grid'    - all of them together in a NEW tab
    //       'current' - add them to the tab already on screen, which is what
    //                   makes a second session to a box you are already on
    //                   possible without saving it twice
    async function openSessions(nodeIds, mode) {
        if (mode === true) mode = 'grid';        // older callers
        else if (mode === false || !mode) mode = 'tabs';

        const results = await rsterm.invoke('rs:session.openNodes', { nodeIds });
        let tab = mode === 'current' ? window.Tabs.active() : null;
        for (const r of results) {
            if (r.error) {
                window.Forms.showBanner('error', `${nodes[r.nodeId] ? nodes[r.nodeId].name : r.nodeId}: ${r.error}`);
                continue;
            }
            window.TermPanes.create(r.sessionId, r.title, r.highlightSet, r.transport);
            const opened = window.TermPanes.panes.get(r.sessionId);
            if (opened) opened.nodeId = r.nodeId;
            window.App.adoptWaitingPort(r.sessionId);
            if (mode === 'tabs') {
                window.Tabs.addSession(window.Tabs.newTab(r.title).id, r.sessionId);
            } else {
                if (!tab) tab = window.Tabs.newTab(r.title);
                // The user asked for these sessions, so a tab that closed
                // during the dial gets replaced rather than the session
                // being thrown away - unlike a reconnect, where the closed
                // pane WAS the request.
                if (!window.Tabs.addSession(tab.id, r.sessionId)) {
                    tab = window.Tabs.newTab(r.title);
                    window.Tabs.addSession(tab.id, r.sessionId);
                }
            }
        }
    }

    // --- toolbar ----------------------------------------------------------
    function selectionParent() {
        // New nodes land beside/inside the selection: a selected folder is
        // the parent; a selected session shares its parent.
        if (selected.size !== 1) return null;
        const n = nodes[[...selected][0]];
        if (!n) return null;
        return n.type === 'folder' ? n.id : (n.parentId || null);
    }

    // Shared by the toolbar buttons and the right-click menu: same
    // selection rules, same dialogs, one implementation.
    function editSelection() {
        const ids = [...selected];
        if (!ids.length) return;
        if (ids.length === 1) {
            const n = nodes[ids[0]];
            if (n.type === 'folder') window.Forms.editFolder(n);
            else window.Forms.editSession(n);
        } else {
            const sessionIds = ids.filter((id) => nodes[id] && nodes[id].type === 'session');
            if (sessionIds.length) window.BulkEdit.openDialog(sessionIds, nodes);
        }
    }

    function deleteSelection() {
        const ids = [...selected];
        if (!ids.length) return;
        const names = ids.map((id) => (nodes[id] || {}).name).filter(Boolean);
        const body = document.createElement('p');
        body.textContent = `Delete ${names.join(', ')}` +
            (ids.some((id) => nodes[id] && nodes[id].type === 'folder')
                ? ' and everything inside?' : '?');
        window.Modals.open('Delete', body, [
            { label: 'Cancel' },
            {
                label: 'Delete', primary: true,
                onClick: () => { rsterm.invoke('rs:tree.delete', { ids }); },
            },
        ]);
    }

    // Assign a credential profile to every selected session in one move -
    // the fix-up for sessions imported without one, without opening each
    // editor in turn.
    async function assignProfile() {
        const ids = selectedSessions();
        if (!ids.length) return;
        const profiles = await rsterm.invoke('rs:profiles.list');
        if (!profiles.length) {
            window.Forms.showBanner('warn', 'No credential profiles yet - set one up first.',
                [{ label: 'Manage profiles', onClick: () => window.Forms.manageProfiles() }]);
            return;
        }
        const body = document.createElement('div');
        const info = document.createElement('p');
        info.style.marginBottom = '10px';
        info.textContent = `Set the credential profile on ${ids.length} ` +
            `session${ids.length === 1 ? '' : 's'}.`;
        const pick = window.Modals.select(
            profiles.map((pr) => ({ value: pr.name, label: pr.username ? `${pr.name} (${pr.username})` : pr.name })),
            profiles[0].name);
        // Same affordance as the session editor's Credentials dropdown.
        window.Forms.offerNewProfile(pick);
        body.append(info, window.Modals.row('Profile', pick));
        window.Modals.open('Set credential profile', body, [
            { label: 'Cancel' },
            {
                label: 'Apply', primary: true,
                onClick: () => {
                    rsterm.invoke('rs:tree.bulkEdit', { ids, patch: { credentialProfile: pick.value } });
                },
            },
        ]);
    }

    // Right-click on a row: the toolbar's controls, where the mouse already
    // is. A right-click on something outside the current selection selects
    // it first - menu actions must apply to what is under the cursor, never
    // to a stale selection somewhere off screen.
    function treeMenu(e, node) {
        if (!selected.has(node.id)) {
            selected.clear();
            selected.add(node.id);
            render();
        }
        const sessionCount = selectedSessions().length;
        const multi = selected.size > 1;
        const isFolder = node.type === 'folder';
        const items = [
            {
                label: `Start MultiTerm${sessionCount > 1 ? ` (${sessionCount})` : ''}`,
                disabled: !sessionCount,
                onClick: () => openSessions(selectedSessions(), 'grid'),
            },
            {
                label: 'Add to MultiTerm',
                disabled: !sessionCount || !window.Tabs.active(),
                onClick: () => openSessions(selectedSessions(), 'current'),
            },
            null,
            { label: multi ? 'Bulk edit...' : 'Edit...', onClick: editSelection },
            { label: 'Set credential profile...', disabled: !sessionCount, onClick: assignProfile },
        ];
        if (!isFolder && !multi) {
            items.push(null, {
                label: 'Duplicate session...',
                onClick: async () => {
                    // A copy beside the original, sharing everything but the
                    // name - the MobaXterm workflow for building out a new
                    // device from a known-good template. Created first, then
                    // opened for editing, so what you see is already saved.
                    const copy = { ...node };
                    delete copy.id;
                    delete copy.order;
                    delete copy.modifiedAt;
                    copy.name = `${node.name} (copy)`;
                    const made = await rsterm.invoke('rs:tree.upsert', copy);
                    await refresh();
                    window.Forms.editSession(made);
                },
            });
        }
        if (isFolder && !multi) {
            items.push(null,
                { label: 'New session here', onClick: () => window.Forms.editSession(null, node.id) },
                { label: 'New folder here', onClick: () => window.Forms.editFolder(null, node.id) },
                { label: 'Audit this folder', onClick: auditDevices });
        }
        items.push(null, { label: multi ? `Delete ${selected.size} items...` : 'Delete...', onClick: deleteSelection });
        window.Modals.menu(e.clientX, e.clientY, items);
    }

    // Right-click on the EMPTY part of the list: the actions that are
    // about the tree as a whole rather than any node in it.
    function blankMenu(e) {
        window.Modals.menu(e.clientX, e.clientY, [
            { label: 'New session...', onClick: () => window.Forms.editSession(null, selectionParent()) },
            { label: 'New folder...', onClick: () => window.Forms.editFolder(null, selectionParent()) },
            null,
            { label: 'Import MobaXTerm sessions...', onClick: () => window.TeamUI.mobaWizard() },
            { label: 'Import OpenSSH config...', onClick: () => window.TeamUI.sshImportWizard('sshconfig') },
            { label: 'Import PuTTY sessions...', onClick: () => window.TeamUI.sshImportWizard('putty') },
            { label: 'Import spreadsheet (CSV)...', onClick: () => window.CsvUI.importCsv(selectedFolder(), null) },
            {
                label: 'Import exported session file...',
                onClick: async () => {
                    const plan = await rsterm.invoke('rs:team.importPick');
                    if (plan) window.TeamUI.mergeDialog(plan, 'rs:team.applyImport', 'Import sessions');
                },
            },
            null,
            { label: 'Export to CSV...', onClick: () => window.CsvUI.exportCsv(selectedFolder()) },
            {
                label: 'Export sessions to a file...',
                onClick: async () => {
                    const r = await rsterm.invoke('rs:team.export');
                    if (r) window.Forms.showBanner('warn',
                        `Exported ${r.count} entries (no usernames, no secrets).`);
                },
            },
            null,
            {
                label: 'Collapse all folders',
                onClick: () => { expanded.clear(); render(); },
            },
        ]);
    }

    function wireToolbar() {
        document.getElementById('tree').addEventListener('contextmenu', (e) => {
            // Rows have their own menu and their handler runs first; this
            // one is for the blank space beneath them.
            if (e.target.closest && e.target.closest('.tree-row, .tree-details')) return;
            e.preventDefault();
            blankMenu(e);
        });
        document.getElementById('tree-new-session').addEventListener('click',
            () => window.Forms.editSession(null, selectionParent()));
        document.getElementById('tree-new-folder').addEventListener('click',
            () => window.Forms.editFolder(null, selectionParent()));
        document.getElementById('tree-profiles').addEventListener('click',
            () => window.Forms.manageProfiles());

        // Every way sessions move in or out of this machine, in one menu
        // next to the tree they act on: imports, exports, and the sync
        // file once one is configured.
        document.getElementById('tree-import').addEventListener('click', async (e) => {
            // Read the rect BEFORE the await: currentTarget is null by the
            // time an async handler resumes.
            const btn = e.currentTarget.getBoundingClientRect();
            const settings = await rsterm.invoke('rs:settings.get');
            const syncFile = (settings.teamSync || {}).filePath || null;
            // Sync entries appear only when a sync file is configured, so
            // the single-machine case never sees them.
            const syncItems = syncFile ? [
                null,
                {
                    label: 'Publish sessions to the sync file',
                    onClick: () => window.TeamUI.syncPublish(),
                },
                {
                    label: 'Check the sync file now',
                    onClick: () => window.TeamUI.syncCheck(),
                },
            ] : [];
            window.Modals.menu(btn.left, btn.bottom + 2, [
                {
                    label: 'MobaXTerm sessions (.mxtsessions)...',
                    onClick: () => window.TeamUI.mobaWizard(),
                },
                {
                    label: 'OpenSSH config (~/.ssh/config)...',
                    onClick: () => window.TeamUI.sshImportWizard('sshconfig'),
                },
                {
                    label: 'PuTTY saved sessions...',
                    onClick: () => window.TeamUI.sshImportWizard('putty'),
                },
                {
                    label: 'Spreadsheet (CSV)...',
                    onClick: () => window.CsvUI.importCsv(selectedFolder(), null),
                },
                {
                    label: 'Exported session file (.json)...',
                    onClick: async () => {
                        const plan = await rsterm.invoke('rs:team.importPick');
                        if (plan) window.TeamUI.mergeDialog(plan, 'rs:team.applyImport', 'Import sessions');
                    },
                },
                null,
                {
                    label: 'Export selection to CSV...',
                    onClick: () => window.CsvUI.exportCsv(selectedFolder()),
                },
                {
                    label: 'Export sessions to a file...',
                    onClick: async () => {
                        const r = await rsterm.invoke('rs:team.export');
                        if (r) window.Forms.showBanner('warn',
                            `Exported ${r.count} entries (no usernames, no secrets).`);
                    },
                },
                ...syncItems,
            ]);
        });

        // The logging visibility line under the toolbars. Rendered from
        // main's answer rather than assembled here, so it can never claim a
        // folder the engine is not actually using.
        const logStatus = document.getElementById('log-status');
        async function refreshLogStatus() {
            try {
                const info = await rsterm.invoke('rs:logs.info');
                logStatus.textContent = `Logging sessions to ${info.dir}`;
                logStatus.title = `Sessions are logged to ${info.dir} unless a session or ` +
                    'folder turns logging off (Edit > Logging). Click to open the folder; ' +
                    'change it in Settings.';
            } catch (_) {
                logStatus.hidden = true;
            }
        }
        logStatus.addEventListener('click', () => rsterm.invoke('rs:logs.reveal'));
        rsterm.on('rs:evt.settings-changed', refreshLogStatus);
        refreshLogStatus();

        document.getElementById('tree-open-grid').addEventListener('click', () => {
            const ids = selectedSessions();
            if (ids.length) openSessions(ids, 'grid');
        });

        document.getElementById('tree-add-grid').addEventListener('click', () => {
            const ids = selectedSessions();
            if (!ids.length) return;
            // Adding the session you are already on is a legitimate move, not
            // a mistake: htop in one pane, commands in the other.
            openSessions(ids, window.Tabs.active() ? 'current' : 'grid');
        });

        document.getElementById('tree-edit').addEventListener('click', editSelection);
        document.getElementById('tree-delete').addEventListener('click', deleteSelection);

        document.getElementById('sidebar-toggle').addEventListener('click', () => {
            document.getElementById('sidebar').classList.toggle('collapsed');
        });

        document.getElementById('tree-audit').addEventListener('click', auditDevices);
    }

    // --- device audit -----------------------------------------------------
    // Probes the selected folder (or everything) and offers the devices that
    // have stopped answering. It never deletes: it hands you a selection.
    async function auditDevices() {
        const folderId = selectedFolder();
        const scope = folderId && nodes[folderId] ? nodes[folderId].name : 'all sessions';
        let started;
        try {
            started = await rsterm.invoke('rs:health.audit', { folderId });
        } catch (err) {
            window.Forms.showBanner('error', `Audit: ${err.message}`);
            return;
        }
        if (!started.started) {
            window.Forms.showBanner('warn', 'Nothing to audit - no SSH or telnet devices in scope.');
            return;
        }
        auditProgress = { done: 0, total: started.started, scope };
        showAuditProgress();
    }

    // One keyed banner for the whole sweep: the count updates in place and
    // the finished message replaces it, rather than stacking a second
    // banner over a "probing..." one that never went away.
    let auditProgress = null;
    function showAuditProgress() {
        if (!auditProgress) return;
        const { done, total, scope } = auditProgress;
        window.Forms.showBanner('warn',
            `Probing ${scope}: ${done} of ${total} device${total === 1 ? '' : 's'} checked. ` +
            'A gentle sweep - 8 at a time, with a retry before anything is flagged.',
            [{ label: 'Stop', onClick: () => rsterm.invoke('rs:health.stop') }],
            { key: 'audit' });
    }
    rsterm.on('rs:evt.health-result', () => {
        if (!auditProgress) return;
        auditProgress.done = Math.min(auditProgress.total, auditProgress.done + 1);
        showAuditProgress();
    });

    rsterm.on('rs:evt.health-done', async () => {
        auditProgress = null;
        await refresh();
        const stale = await rsterm.invoke('rs:health.stale', { days: 14 });
        const present = stale.filter((id) => nodes[id]);
        if (!present.length) {
            // Replaces the progress banner, and clears itself: a finished
            // job whose banner never goes away reads as a stuck job.
            window.Forms.showBanner('warn', 'Audit finished - everything answered.',
                [], { key: 'audit' });
            return;
        }
        window.Forms.showBanner('warn',
            `Audit finished - ${present.length} device${present.length === 1 ? '' : 's'} ` +
            'did not answer and have not answered recently.',
            [{
                label: 'Select them',
                onClick: () => {
                    selected.clear();
                    for (const id of present) {
                        selected.add(id);
                        // Reveal the selection: expand every ancestor folder.
                        let p = nodes[id] && nodes[id].parentId;
                        while (p) { expanded.add(p); p = (nodes[p] || {}).parentId; }
                    }
                    render();
                },
            }]);
    });

    // The folder a bulk operation should target: a selected folder, the
    // parent of a selected session, or the whole tree.
    function selectedFolder() {
        if (selected.size !== 1) return null;
        const n = nodes[[...selected][0]];
        if (!n) return null;
        return n.type === 'folder' ? n.id : (n.parentId || null);
    }

    rsterm.on('rs:evt.tree-changed', refresh);
    rsterm.on('rs:evt.profiles-changed', refresh);

    window.SessionTree = {
        refresh, wireToolbar, openSessions, selectedFolder,
        selectedSessions: () => selectedSessions(),
        allNodes: () => nodes,
    };
})();
