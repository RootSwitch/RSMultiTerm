'use strict';
// Tabs own layout: a tab is an ordered list of sessionIds plus a grid shape.
// "Split" is nothing special - it is just a second session in the same tab,
// which is the whole point: the multi-exec grid IS the split view.

(function () {
    const tabs = [];          // {id, title, sessionIds: [], focusedSessionId}
    let activeId = null;
    let nextId = 1;
    const listeners = [];

    function onChange(fn) { listeners.push(fn); }
    function fire() {
        renderStrip();
        for (const fn of listeners) fn();
    }

    function byId(id) { return tabs.find((t) => t.id === id); }
    function active() { return byId(activeId); }

    function newTab(title) {
        const tab = { id: nextId++, title: title || 'Session', sessionIds: [], focusedSessionId: null };
        tabs.push(tab);
        activeId = tab.id;
        fire();
        return tab;
    }

    // Returns whether the session actually landed in a tab. Callers pass a
    // tab captured BEFORE an await (a dial, a credential prompt), and the
    // user may close it during that await; a silent no-op here turned the
    // freshly opened session into a live, authenticated connection with no
    // pane, no close button, and no way out short of quitting the app.
    function addSession(tabId, sessionId) {
        const tab = byId(tabId);
        if (!tab) return false;
        tab.sessionIds.push(sessionId);
        tab.focusedSessionId = sessionId;
        fire();
        return true;
    }

    // Find whichever tab holds the session; a session lives in exactly one.
    function tabOf(sessionId) {
        return tabs.find((t) => t.sessionIds.includes(sessionId));
    }

    function removeSession(sessionId) {
        const tab = tabOf(sessionId);
        if (!tab) return;
        tab.sessionIds = tab.sessionIds.filter((s) => s !== sessionId);
        if (tab.focusedSessionId === sessionId) {
            tab.focusedSessionId = tab.sessionIds[0] || null;
        }
        if (!tab.sessionIds.length) {
            const i = tabs.indexOf(tab);
            tabs.splice(i, 1);
            if (activeId === tab.id) activeId = (tabs[i] || tabs[i - 1] || {}).id || null;
        }
        fire();
    }

    function activate(tabId) {
        if (activeId === tabId) return;
        activeId = tabId;
        fire();
    }

    // Swap a session for its replacement in place, so a reconnected pane
    // keeps its position in the grid instead of jumping to the end.
    // Same contract as addSession: false means the old session is in no
    // tab any more, so the replacement has nowhere to appear.
    function replaceSession(oldId, newId) {
        const tab = tabOf(oldId);
        if (!tab) return false;
        const at = tab.sessionIds.indexOf(oldId);
        tab.sessionIds[at] = newId;
        if (tab.focusedSessionId === oldId) tab.focusedSessionId = newId;
        fire();
        return true;
    }

    function setFocused(sessionId) {
        const tab = tabOf(sessionId);
        if (!tab) return;
        tab.focusedSessionId = sessionId;
        if (tab.id !== activeId) activeId = tab.id;
        fire();
    }

    function retitle(tab) {
        // A name the user typed wins outright - no "+N" bookkeeping on top
        // of a deliberate label.
        if (tab.customTitle) { tab.title = tab.customTitle; return; }
        const first = window.TermPanes.panes.get(tab.sessionIds[0]);
        if (!first) return;
        // Both directions: growing to "+N" AND shrinking back - closing
        // panes down to one used to leave "host +3" on the tab forever.
        tab.title = tab.sessionIds.length > 1
            ? `${first.title} +${tab.sessionIds.length - 1}` : first.title;
    }

    // A tab reports the worst state among its sessions: one dead pane in a
    // six-pane grid is the thing you need to see from the tab strip, and it
    // would be lost in an average.
    const RANK = { dead: 3, busy: 2, ok: 1 };
    function tabStatus(tab) {
        let worst = 'ok';
        for (const sid of tab.sessionIds) {
            const pane = window.TermPanes.panes.get(sid);
            if (!pane) continue;
            const state = pane.state;
            const kind = (state === 'closed' || state === 'error' || state === 'auth-blocked')
                ? 'dead'
                : (state === 'connected' ? 'ok' : 'busy');
            if (RANK[kind] > RANK[worst]) worst = kind;
        }
        return worst;
    }

    // Repaint just the labels. Deliberately not a full fire(): the grid
    // listens to that and would re-parent every pane on each status change.
    function updateStatus() {
        for (const tab of tabs) {
            if (!tab.el) continue;
            const label = tab.el.querySelector('.tab-label');
            if (label) label.className = `tab-label ${tabStatus(tab)}`;
        }
    }

    // Close every session in a tab, disconnecting each one.
    function closeTab(tab) {
        for (const sid of [...tab.sessionIds]) {
            rsterm.invoke('rs:session.disconnect', { sessionId: sid });
            window.TermPanes.destroy(sid);
            removeSession(sid);
        }
    }

    function closeOthers(keep) {
        for (const tab of [...tabs]) {
            if (tab.id !== keep.id) closeTab(tab);
        }
    }

    function closeToTheRight(from) {
        const at = tabs.indexOf(from);
        if (at === -1) return;
        for (const tab of tabs.slice(at + 1)) closeTab(tab);
    }

    // Closing several tabs at once is the one that gets clicked by accident,
    // so anything beyond the current tab confirms first and says how many.
    function confirmThenClose(count, what, run) {
        if (count <= 0) return;
        const body = document.createElement('p');
        body.textContent = `Close ${count} tab${count === 1 ? '' : 's'} (${what})? ` +
            'Their sessions will be disconnected.';
        window.Modals.open('Close tabs', body, [
            { label: 'Cancel' },
            { label: `Close ${count}`, primary: true, onClick: run },
        ]);
    }

    // Collapse every open tab into one multi-pane tab, in strip order. The
    // sessions are not touched - only which tab holds them - so nothing
    // reconnects and no scrollback is lost.
    function mergeAll() {
        if (tabs.length < 2) return;
        const target = tabs[0];
        for (const tab of tabs.slice(1)) {
            for (const sid of tab.sessionIds) target.sessionIds.push(sid);
            tab.sessionIds = [];
        }
        tabs.length = 1;
        activeId = target.id;
        fire();
    }

    async function renameTab(tab) {
        const name = await window.Modals.promptText('Rename tab', 'Tab name', tab.customTitle || tab.title);
        if (name === null) return;   // cancelled or cleared
        tab.customTitle = name;
        fire();
    }

    // The MobaXterm habit: color-code tabs by what they touch (prod red,
    // lab green). A stripe along the top rather than a full background, so
    // the status colors on the label stay readable.
    const TAB_COLORS = ['#e05561', '#e5883b', '#e6c351', '#5eb95e', '#4aa3e0', '#a473d6', '#4ec9b0'];
    function pickColor(tab) {
        const body = document.createElement('div');
        body.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;padding:6px 2px;';
        let dlg = null;
        const swatch = (color) => {
            const b = document.createElement('button');
            b.title = color || 'No color';
            b.style.cssText = 'width:30px;height:30px;border-radius:50%;padding:0;' +
                `border:2px solid ${(tab.color || null) === color ? 'var(--se-txt)' : 'var(--se-border)'};` +
                (color ? `background:${color};` : 'background:var(--se-input);');
            if (!color) b.textContent = String.fromCharCode(215);
            b.addEventListener('click', () => {
                tab.color = color || null;
                fire();
                if (dlg) dlg.close();
            });
            return b;
        };
        body.appendChild(swatch(null));
        for (const c of TAB_COLORS) body.appendChild(swatch(c));
        dlg = window.Modals.open('Tab color', body, [{ label: 'Cancel' }]);
    }

    function tabMenu(e, tab) {
        const others = tabs.length - 1;
        const right = Math.max(0, tabs.length - 1 - tabs.indexOf(tab));
        // A tab can hold several panes, so this names the one it will act
        // on rather than leaving "save the session" ambiguous in a grid.
        const focused = tab.focusedSessionId && window.TermPanes.panes.get(tab.focusedSessionId);
        const saveItem = focused && focused.savable ? [{
            label: `Save '${focused.title}' as a session...`,
            onClick: () => window.Forms.saveSessionDialog(focused.sessionId),
        }] : [];
        window.Modals.menu(e.clientX, e.clientY, [
            ...saveItem,
            { label: 'Rename tab...', onClick: () => renameTab(tab) },
            ...(tab.customTitle
                ? [{ label: 'Use automatic name', onClick: () => { tab.customTitle = null; fire(); } }]
                : []),
            { label: 'Tab color...', onClick: () => pickColor(tab) },
            {
                label: 'Save terminal output...',
                disabled: !tab.focusedSessionId,
                onClick: () => window.TermPanes.saveOutput(tab.focusedSessionId),
            },
            null,
            { label: 'Font size +  (Ctrl+wheel)', onClick: () => window.TermPanes.zoom(1) },
            { label: 'Font size -', onClick: () => window.TermPanes.zoom(-1) },
            {
                // Greyed out when the font is already the Settings size, so
                // the menu answers "am I zoomed?" as well as offering the
                // way back.
                label: 'Reset font size  (Ctrl+0)',
                disabled: !window.TermPanes.isZoomed(),
                onClick: () => window.TermPanes.zoom(0),
            },
            null,
            { label: 'Close', onClick: () => closeTab(tab) },
            {
                label: 'Close all but this tab',
                disabled: others === 0,
                onClick: () => confirmThenClose(others, 'all but this one', () => closeOthers(tab)),
            },
            {
                label: 'Close tabs to the right',
                disabled: right === 0,
                onClick: () => confirmThenClose(right, 'to the right', () => closeToTheRight(tab)),
            },
            null,
            {
                label: 'Merge all tabs into one',
                disabled: tabs.length < 2,
                onClick: mergeAll,
            },
        ]);
    }

    function renderStrip() {
        const strip = document.getElementById('tabstrip');
        strip.hidden = tabs.length === 0;
        strip.replaceChildren();
        for (const tab of tabs) {
            retitle(tab);
            const el = document.createElement('div');
            el.className = 'tab' + (tab.id === activeId ? ' active' : '');
            // Hex only. The value round-trips through workspace.json, and
            // anything else here would be injected into a style property.
            if (/^#[0-9a-fA-F]{3,8}$/.test(tab.color || '')) {
                el.style.boxShadow = `inset 0 3px 0 ${tab.color}`;
            }
            const label = document.createElement('span');
            label.className = `tab-label ${tabStatus(tab)}`;
            label.textContent = tab.title;
            const close = document.createElement('button');
            close.className = 'close';
            close.textContent = '×';
            close.title = 'Close tab';
            close.addEventListener('click', (e) => {
                e.stopPropagation();
                closeTab(tab);
            });
            el.append(label, close);
            el.addEventListener('click', () => activate(tab.id));
            // Middle-click closes, the muscle memory every tabbed app honors.
            el.addEventListener('auxclick', (e) => {
                if (e.button === 1) close.click();
            });
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                activate(tab.id);
                tabMenu(e, tab);
            });
            tab.el = el;
            strip.appendChild(el);
        }
    }

    window.Tabs = {
        onChange, newTab, addSession, removeSession, activate, setFocused,
        replaceSession, closeTab, tabOf, active, tabs, updateStatus, mergeAll,
    };
})();
