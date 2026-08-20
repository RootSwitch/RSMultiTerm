'use strict';
// Command palette (Ctrl+Shift+P): fuzzy-find a saved session and open it,
// or run an app command, without leaving the keyboard. In a session manager
// the palette is really a launcher - sessions rank first, and typing
// something host-shaped offers to SSH straight to it.

(function () {
    let overlay = null;
    let field = null;
    let list = null;
    let items = [];        // current filtered [{title, detail, run, runAlt}]
    let selected = 0;

    // Static commands; sessions are appended fresh on every open.
    const COMMANDS = [
        { title: 'Toggle broadcast', run: () => window.MultiExec.toggleBroadcast() },
        { title: 'Paste to all panes', run: () => window.MultiExec.pasteAll() },
        { title: 'Find in scrollback', run: () => window.SearchUI.open() },
        { title: 'Hints: copy from screen', run: () => window.Hints.open() },
        { title: 'Compare panes (diff)', run: () => window.DiffUI.comparePanes() },
        { title: 'Merge all tabs into one', run: () => window.Tabs.mergeAll() },
        {
            title: 'Reconnect all disconnected panes',
            detail: 'dials each dead pane in turn, paced by the auth guard',
            run: () => window.Workspace.reconnectAll(),
        },
        {
            title: 'Copy last command output',
            run: () => {
                const tab = window.Tabs.active();
                const out = tab && window.TermPanes.lastCommandOutput(tab.focusedSessionId);
                if (out) navigator.clipboard.writeText(out).catch(() => { /* focus lost */ });
                setStatus(out ? 'copied last command output' : 'no marked command output (needs shell integration)');
            },
        },
        {
            title: 'Duplicate this pane',
            run: () => {
                const tab = window.Tabs.active();
                if (tab && tab.focusedSessionId) window.App.duplicatePane(tab.focusedSessionId);
            },
        },
        // Both go through the same helpers the tree menu uses, so the
        // merge-before-publish path behaves identically wherever it is
        // started from.
        {
            title: 'Install SSH key on this device (ssh-copy-id)',
            run: () => {
                const tab = window.Tabs.active();
                if (tab && tab.focusedSessionId) window.Forms.installKeyDialog(tab.focusedSessionId);
            },
        },
        {
            title: 'Save this connection as a session',
            run: () => {
                const tab = window.Tabs.active();
                const sid = tab && tab.focusedSessionId;
                if (!sid) return;
                const pane = window.TermPanes.panes.get(sid);
                if (!pane || !pane.savable) {
                    window.Forms.showBanner('warn', 'This session is already saved.');
                    return;
                }
                window.Forms.saveSessionDialog(sid);
            },
        },
        { title: 'Sync: check the sessions file for changes',
            run: () => window.TeamUI.syncCheck() },
        { title: 'Sync: publish sessions', run: () => window.TeamUI.syncPublish() },
        {
            title: 'Import MobaXTerm sessions (.mxtsessions)',
            detail: 'browse to a file exported from MobaXTerm, portable or installed',
            run: () => window.TeamUI.mobaWizard(),
        },
        {
            title: 'Import sessions from a spreadsheet (CSV)',
            run: () => window.CsvUI.importCsv(window.SessionTree.selectedFolder(), null),
        },
        { title: 'Edit highlight rules', run: () => window.HighlightRulesUI.openEditor() },
        { title: 'Manage snippets', run: () => window.Snippets.openManager() },
        { title: 'Tunnels / port forwards', run: () => window.Tunnels.openManager() },
        {
            title: 'Install shell integration on this host',
            detail: 'turns on prompt navigation and copy-last-output for a Linux session',
            run: () => window.ShellIntegration.openDialog(),
        },
        { title: 'Settings', run: () => window.SettingsUI.openSettings() },
    ];

    // Subsequence fuzzy score: all query chars must appear in order; earlier
    // and consecutive hits rank higher; a hit at a word start ranks higher
    // still. Simple, predictable, fast enough for a few hundred sessions.
    function score(query, text) {
        const q = query.toLowerCase();
        const t = text.toLowerCase();
        let qi = 0, s = 0, streak = 0;
        for (let ti = 0; ti < t.length && qi < q.length; ti++) {
            if (t[ti] === q[qi]) {
                qi++;
                streak++;
                s += 1 + streak + (ti === 0 || /[\s\/.-]/.test(t[ti - 1]) ? 3 : 0);
            } else {
                streak = 0;
            }
        }
        return qi === q.length ? s - t.length * 0.01 : -1;
    }

    function folderPath(nodes, node) {
        const parts = [];
        const seen = new Set();
        let p = node.parentId;
        while (p && nodes[p] && !seen.has(p)) {
            seen.add(p);
            parts.unshift(nodes[p].name);
            p = nodes[p].parentId;
        }
        return parts.join(' / ');
    }

    function collect(query) {
        const nodes = window.SessionTree.allNodes();
        const sessions = Object.values(nodes)
            .filter((n) => n.type === 'session')
            .map((n) => ({
                title: n.name,
                detail: [folderPath(nodes, n), n.host].filter(Boolean).join('  ·  '),
                run: () => window.SessionTree.openSessions([n.id], 'tabs'),
                runAlt: () => window.SessionTree.openSessions([n.id], 'current'),
                haystack: `${n.name} ${n.host || ''} ${folderPath(nodes, n)}`,
            }));
        const commands = COMMANDS.map((c) => ({ ...c, detail: c.detail || 'command', haystack: c.title }));
        const snips = (window.Snippets ? window.Snippets.all() : []).map((s) => ({
            title: s.name,
            detail: 'snippet' + (s.notes ? `  ·  ${s.notes}` : ''),
            run: () => window.Snippets.run(s),
            haystack: `snippet ${s.name} ${s.command}`,
        }));

        let all;
        if (!query) {
            all = sessions.slice(0, 8).concat(snips.slice(0, 3)).concat(commands);
        } else {
            all = sessions.concat(snips).concat(commands)
                .map((it) => ({ it, s: score(query, it.haystack) }))
                .filter((x) => x.s >= 0)
                .sort((a, b) => b.s - a.s)
                .map((x) => x.it);
        }
        // Anything host-shaped gets a direct-dial row at the end.
        if (query && /^[\w.:@[\]-]+$/.test(query) && /[.:]/.test(query)) {
            all.push({
                title: `SSH to ${query}`,
                detail: 'quick connect',
                run: () => window.App.quickSsh(query),
            });
        }
        return all.slice(0, 14);
    }

    function render() {
        list.replaceChildren();
        items.forEach((it, i) => {
            const li = document.createElement('div');
            li.className = 'palette-item' + (i === selected ? ' selected' : '');
            const t = document.createElement('span');
            t.className = 'palette-title';
            t.textContent = it.title;
            const d = document.createElement('span');
            d.className = 'palette-detail';
            d.textContent = it.detail || '';
            li.append(t, d);
            li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i, e.shiftKey); });
            list.appendChild(li);
        });
    }

    function refilter() {
        items = collect(field.value.trim());
        selected = 0;
        render();
    }

    function pick(i, alt) {
        const it = items[i];
        if (!it) return;
        close();
        const fn = alt && it.runAlt ? it.runAlt : it.run;
        fn();
    }

    function build() {
        overlay = document.createElement('div');
        overlay.id = 'palette';
        overlay.hidden = true;
        const box = document.createElement('div');
        box.className = 'palette-box';
        field = document.createElement('input');
        field.placeholder = 'Session, host, or command...  (Enter opens, Shift+Enter adds to this tab)';
        list = document.createElement('div');
        list.className = 'palette-list';
        box.append(field, list);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        field.addEventListener('input', refilter);
        field.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, items.length - 1); render(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(selected - 1, 0); render(); }
            else if (e.key === 'Enter') { e.preventDefault(); pick(selected, e.shiftKey); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        });
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    }

    function open() {
        if (!overlay) build();
        overlay.hidden = false;
        field.value = '';
        refilter();
        field.focus();
    }

    function close() {
        if (!overlay || overlay.hidden) return;
        overlay.hidden = true;
        const tab = window.Tabs.active();
        const pane = tab && window.TermPanes.panes.get(tab.focusedSessionId);
        if (pane) pane.term.focus();
    }

    function setStatus(text) {
        const el = document.getElementById('status-text');
        if (el) el.textContent = text;
    }

    window.Palette = { open, close, isOpen: () => !!overlay && !overlay.hidden };
})();
