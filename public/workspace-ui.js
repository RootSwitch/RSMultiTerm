'use strict';
// Workspace resurrection, renderer half: snapshot the layout as it changes,
// and offer to bring it back at startup.
//
// The restored panes are DEAD ON ARRIVAL by design - the layout, the
// titles, the scrollback, and a working R key, but no connections. An app
// that redials twelve devices because it was launched would be a
// canary-stampede at best and an AD-lockout at worst; "Reconnect all" is
// one deliberate click away for when that is what you want.

(function () {
    let restoring = false;

    // Snapshot without scrollback: cheap enough to run on every layout
    // change, so a crash still leaves an accurate shape behind.
    function collect(withScrollback) {
        const tabs = window.Tabs.tabs.map((tab) => ({
            title: tab.title,
            customTitle: tab.customTitle || null,
            color: tab.color || null,
            focusedIndex: Math.max(0, tab.sessionIds.indexOf(tab.focusedSessionId)),
            panes: tab.sessionIds.map((sid) => {
                const pane = window.TermPanes.panes.get(sid);
                if (!pane) return null;
                return {
                    sessionId: sid,
                    restoredRecipe: pane.restoredRecipe || null,
                    title: pane.title,
                    transport: pane.transport,
                    highlightSet: pane.highlightSet || null,
                    scrollback: withScrollback ? snapshotBuffer(pane) : null,
                };
            }).filter(Boolean),
        })).filter((t) => t.panes.length);

        const active = window.Tabs.active();
        return {
            tabs,
            activeTab: active ? window.Tabs.tabs.indexOf(active) : 0,
        };
    }

    function snapshotBuffer(pane) {
        if (!pane.serialize) return null;
        try {
            // Bounded: a pane that has seen a 50MB flood must not turn into
            // a 50MB snapshot. The last 2000 lines is more scrollback than
            // anyone reads after a restart.
            return pane.serialize.serialize({ scrollback: 2000 });
        } catch (_) {
            return null;   // serialization is a nicety, never a blocker
        }
    }

    let saveTimer = null;
    function scheduleSave() {
        if (restoring) return;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            const { tabs, activeTab } = collect(false);
            rsterm.invoke('rs:workspace.save', { tabs, activeTab }).catch(() => { /* best effort */ });
        }, 800);
    }

    // Main asks for the real thing (with scrollback) on the way out, and
    // waits for it - briefly - before letting the window go.
    rsterm.on('rs:evt.snapshot-request', () => {
        const { tabs, activeTab } = collect(true);
        rsterm.invoke('rs:workspace.save', { tabs, activeTab, final: true })
            .catch(() => { /* the window is closing anyway */ });
    });

    // --- restore ----------------------------------------------------------
    async function restore(snapshot) {
        restoring = true;
        try {
            for (const t of snapshot.tabs) {
                let tab = null;
                for (const p of t.panes) {
                    let res;
                    try {
                        res = await rsterm.invoke('rs:session.restore', {
                            recipe: p.recipe, title: p.title,
                        });
                    } catch (_) {
                        continue;   // a recipe main no longer understands
                    }
                    window.TermPanes.create(res.sessionId, p.title, p.highlightSet, p.transport);
                    const pane = window.TermPanes.panes.get(res.sessionId);
                    // Remember how this pane was described, so snapshotting a
                    // still-unconnected pane does not lose it: main's recipe
                    // map is keyed by the NEW sessionId, but a pane that is
                    // later reconnected gets a different id again.
                    pane.restoredRecipe = p.recipe;
                    if (p.scrollback) {
                        pane.term.write(p.scrollback);
                        pane.term.write('\r\n');
                    }
                    window.TermPanes.setState(pane, 'closed', 'restored - press R to reconnect');
                    if (!tab) {
                        tab = window.Tabs.newTab(t.title || p.title);
                        if (t.customTitle) tab.customTitle = String(t.customTitle);
                        if (t.color) tab.color = String(t.color);
                    }
                    window.Tabs.addSession(tab.id, res.sessionId);
                }
                if (tab && t.panes[t.focusedIndex]) {
                    const sid = tab.sessionIds[t.focusedIndex];
                    if (sid) window.Tabs.setFocused(sid);
                }
            }
            const target = window.Tabs.tabs[snapshot.activeTab];
            if (target) window.Tabs.activate(target.id);
        } finally {
            restoring = false;
        }
        scheduleSave();
    }

    async function reconnectAll() {
        const dead = [];
        for (const tab of window.Tabs.tabs) {
            for (const sid of tab.sessionIds) {
                if (window.TermPanes.isDead(sid)) dead.push(sid);
            }
        }
        if (!dead.length) {
            window.Forms.showBanner('warn', 'Nothing to reconnect.');
            return;
        }
        // Sequential, not a fan-out: the canary guard already paces
        // same-profile connects, and a burst of thirty dials is the exact
        // shape of traffic that gets a workstation noticed.
        for (const sid of dead) {
            await window.App.reconnectPane(sid);
        }
    }

    function offer(snapshot) {
        const panes = snapshot.tabs.reduce((n, t) => n + t.panes.length, 0);
        const when = snapshot.savedAt ? new Date(snapshot.savedAt) : null;
        const body = document.createElement('div');
        const p = document.createElement('p');
        p.textContent = `${panes} pane${panes === 1 ? '' : 's'} in ` +
            `${snapshot.tabs.length} tab${snapshot.tabs.length === 1 ? '' : 's'}` +
            (when ? `, from ${when.toLocaleString()}` : '') + '.';
        const q = document.createElement('p');
        q.style.cssText = 'margin-top:8px;color:var(--se-txt-dim);font-size:12px;';
        q.textContent = 'Restoring brings back the layout and scrollback. Nothing ' +
            'reconnects on its own - each pane offers R, or use Reconnect all.';
        body.append(p, q);

        window.Modals.open('Restore Your Last Session?', body, [
            {
                label: 'Start Fresh',
                onClick: () => rsterm.invoke('rs:workspace.save', { tabs: [], activeTab: 0 }),
            },
            { label: 'Restore', primary: true, onClick: () => restore(snapshot) },
            {
                label: 'Restore and Reconnect',
                onClick: () => restore(snapshot).then(reconnectAll),
            },
        ]);
    }

    async function init() {
        // Layout changes drive the snapshot; the tab layer already fires on
        // every add, remove, focus and merge.
        window.Tabs.onChange(scheduleSave);

        const cfg = await rsterm.invoke('rs:app.bootconfig');
        if (cfg && cfg.smoke) return;          // smoke runs drive their own layout
        const snapshot = await rsterm.invoke('rs:workspace.get');
        if (snapshot && snapshot.tabs && snapshot.tabs.length) offer(snapshot);
    }

    window.Workspace = { init, restore, reconnectAll, snapshot: () => collect(true) };
})();
