'use strict';
// Find-in-scrollback, on the focused pane. Ctrl+Shift+F opens the bar,
// Enter steps forward, Shift+Enter back, Escape closes and hands focus back
// to the terminal. One bar, retargeted to whichever pane is focused when it
// opens - searching six panes at once answers a question nobody asks.

(function () {
    let bar = null;
    let field = null;
    let counter = null;
    let targetSid = null;

    function targetPane() {
        const pane = targetSid && window.TermPanes.panes.get(targetSid);
        if (pane) return pane;
        const tab = window.Tabs.active();
        return tab && tab.focusedSessionId
            ? window.TermPanes.panes.get(tab.focusedSessionId) : null;
    }

    const OPTS = { decorations: { matchOverviewRuler: '#e0b13d', activeMatchColorOverviewRuler: '#e05d3d' } };

    function step(back) {
        const pane = targetPane();
        if (!pane || !field.value) return;
        if (back) pane.search.findPrevious(field.value, OPTS);
        else pane.search.findNext(field.value, OPTS);
    }

    function build() {
        bar = document.createElement('div');
        bar.id = 'search-bar';
        bar.hidden = true;

        field = document.createElement('input');
        field.placeholder = 'Find in scrollback';
        field.addEventListener('input', () => {
            const pane = targetPane();
            if (!pane) return;
            if (field.value) pane.search.findNext(field.value, { ...OPTS, incremental: true });
            else pane.search.clearDecorations();
        });
        field.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        });

        counter = document.createElement('span');
        counter.className = 'search-count';

        const prev = document.createElement('button');
        prev.textContent = '▲';
        prev.title = 'Previous match (Shift+Enter)';
        prev.addEventListener('click', () => step(true));
        const next = document.createElement('button');
        next.textContent = '▼';
        next.title = 'Next match (Enter)';
        next.addEventListener('click', () => step(false));
        const x = document.createElement('button');
        x.textContent = '×';
        x.title = 'Close (Esc)';
        x.addEventListener('click', close);

        bar.append(field, counter, prev, next, x);
        document.getElementById('workspace').appendChild(bar);
    }

    function open() {
        if (!bar) build();
        const tab = window.Tabs.active();
        if (!tab || !tab.focusedSessionId) return;
        targetSid = tab.focusedSessionId;
        const pane = targetPane();
        if (!pane) return;
        // Live match counts, wired lazily once per pane.
        if (!pane._searchWired) {
            pane._searchWired = true;
            pane.search.onDidChangeResults((r) => {
                if (!bar.hidden && targetSid === pane.sessionId) {
                    counter.textContent = r.resultCount
                        ? `${r.resultIndex + 1}/${r.resultCount}` : 'no matches';
                }
            });
        }
        bar.hidden = false;
        counter.textContent = '';
        field.select();
        field.focus();
    }

    function close() {
        if (!bar || bar.hidden) return;
        bar.hidden = true;
        const pane = targetPane();
        if (pane) {
            pane.search.clearDecorations();
            pane.term.focus();
        }
        targetSid = null;
    }

    window.SearchUI = { open, close, isOpen: () => !!bar && !bar.hidden };
})();
