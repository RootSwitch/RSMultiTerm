'use strict';
// Grid renderer: lays the active tab's sessions out as a dynamic N-pane grid
// (the layout MobaXTerm only gives its multi-exec) and re-parents pane host
// divs between the visible grid and the offscreen pool. Host divs are never
// destroyed on layout changes, so scrollback survives any re-arrangement.

(function () {
    // Default shape: as square as possible, wider before taller.
    function shape(n) {
        if (n <= 1) return { cols: 1, rows: 1 };
        const cols = Math.ceil(Math.sqrt(n));
        return { cols, rows: Math.ceil(n / cols) };
    }

    // Fingerprint of what is actually laid out; when only focus changed,
    // update classes in place. A full render re-parents every pane host,
    // which kills a drag-selection started in an unfocused pane mid-
    // mousedown (the node moves out from under the pointer).
    let lastLayout = '';

    // force: rebuild even when the layout is unchanged. The fast path
    // below exists because render() runs on every tab and focus change; a
    // header that gains or loses a button needs the slow one.
    function render(force) {
        const grid = document.getElementById('grid');
        const pool = document.getElementById('session-pool');
        const tab = window.Tabs.active();
        const visible = new Set(tab ? tab.sessionIds : []);

        const layout = tab ? `${tab.id}:${tab.sessionIds.join(',')}` : '';
        if (!force && layout && layout === lastLayout) {
            for (const sid of tab.sessionIds) {
                const pane = window.TermPanes.panes.get(sid);
                if (pane && pane.el) {
                    pane.el.classList.toggle('focused', tab.focusedSessionId === sid);
                }
            }
            window.MultiExec.refreshChrome();
            return;
        }
        lastLayout = layout;

        // Anything not visible goes to the pool (at real size, not hidden).
        for (const [sid, pane] of window.TermPanes.panes) {
            if (!visible.has(sid) && pane.host.parentElement &&
                pane.host.parentElement !== pool) {
                pool.appendChild(pane.host);
                if (pane.el) { pane.el.remove(); pane.el = null; pane.dot = null; }
            }
        }

        grid.replaceChildren();
        if (!tab) { grid.style.gridTemplateColumns = '1fr'; return; }

        const { cols } = shape(tab.sessionIds.length);
        grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

        for (const sid of tab.sessionIds) {
            const pane = window.TermPanes.panes.get(sid);
            if (!pane) continue;
            grid.appendChild(buildCell(tab, pane));
            window.TermPanes.mount(sid, pane.el.querySelector('.pane-body'));
        }
        window.MultiExec.refreshChrome();
    }

    function buildCell(tab, pane) {
        const cell = document.createElement('div');
        cell.className = 'pane' + (tab.focusedSessionId === pane.sessionId ? ' focused' : '');

        const header = document.createElement('div');
        header.className = 'pane-header';

        const dot = document.createElement('span');
        dot.className = 'status-dot ' + pane.state;

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = pane.title;

        const spacer = document.createElement('span');
        spacer.style.flex = '1';

        // SFTP file browser, SSH sessions only - rides this session's
        // existing connection.
        let filesBtn = null;
        if (pane.transport === 'ssh') {
            filesBtn = document.createElement('button');
            filesBtn.className = 'pane-btn';
            filesBtn.title = 'Browse files on this device (SFTP over this session)';
            filesBtn.textContent = '🗀';
            filesBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Focus the pane first so the browser and the terminal agree
                // about which device is being looked at.
                window.Tabs.setFocused(pane.sessionId);
                window.SftpPanel.openFor(pane.sessionId, pane.title);
            });
        }

        // Quick connect leaves nothing behind by design; this is the one
        // click that keeps it. Only shown while the session is unsaved, so
        // it disappears once it has been - and never appears at all on a
        // pane opened from the tree.
        let saveBtn = null;
        if (pane.savable) {
            saveBtn = document.createElement('button');
            saveBtn.className = 'pane-btn';
            saveBtn.title = 'Save this connection as a session in the tree';
            saveBtn.textContent = '☆';
            saveBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.Tabs.setFocused(pane.sessionId);
                window.Forms.saveSessionDialog(pane.sessionId);
            });
        }

        // A second session to the same device, in this tab.
        const dup = document.createElement('button');
        dup.className = 'pane-btn';
        dup.title = 'Open a second session to this device in this tab';
        dup.textContent = '⧉';
        dup.addEventListener('click', (e) => {
            e.stopPropagation();
            window.App.duplicatePane(pane.sessionId);
        });

        // Broadcast membership toggle; MultiExec owns the state.
        const bc = document.createElement('button');
        bc.className = 'bc-toggle';
        bc.title = 'Include in broadcast';
        bc.textContent = '⇶';
        bc.addEventListener('click', (e) => {
            e.stopPropagation();
            window.MultiExec.toggleParticipant(pane.sessionId);
        });

        const close = document.createElement('button');
        close.className = 'close';
        close.textContent = '×';
        close.title = 'Close session';
        close.addEventListener('click', (e) => {
            e.stopPropagation();
            rsterm.invoke('rs:session.disconnect', { sessionId: pane.sessionId });
            window.TermPanes.destroy(pane.sessionId);
            window.Tabs.removeSession(pane.sessionId);
        });

        header.append(dot, name, spacer, ...(saveBtn ? [saveBtn] : []),
            ...(filesBtn ? [filesBtn] : []), dup, bc, close);

        const body = document.createElement('div');
        body.className = 'pane-body';

        cell.append(header, body);
        cell.addEventListener('mousedown', () => {
            if (window.Tabs.active() && window.Tabs.active().focusedSessionId !== pane.sessionId) {
                window.Tabs.setFocused(pane.sessionId);
            }
            pane.term.focus();
        });

        pane.el = cell;
        pane.dot = dot;
        return cell;
    }

    // Re-measure every visible pane, for when the grid's own size changed
    // rather than its contents (sidebar drag, window resize).
    function refit() {
        const tab = window.Tabs.active();
        if (!tab) return;
        for (const sid of tab.sessionIds) {
            const pane = window.TermPanes.panes.get(sid);
            if (pane) requestAnimationFrame(() => pane.fit.fit());
        }
    }

    window.Grid = { render, shape, refit };
    window.addEventListener('resize', refit);
    window.Tabs.onChange(render);
})();
