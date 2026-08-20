'use strict';
// Multi-exec: broadcast keystrokes from the focused pane to every
// participating pane in the active tab. The state must be unmissable - the
// failure mode is typing `reload` into six core switches - so participating
// panes get a warn-colored outline and the toolbar shows a live count.
//
// Paste while broadcasting ALWAYS confirms with the exact payload; a
// multi-line paste to N sessions is never silent.

(function () {
    // Per-tab broadcast state: tabId -> {enabled, excluded:Set<sessionId>}.
    // Membership is opt-out (new panes join automatically) because the
    // common case is "open six switches, talk to all six".
    const state = new Map();

    // Whether a multiline paste into a SINGLE pane confirms first (the
    // MobaXterm dialog). Broadcast confirmation is not covered by this -
    // that one is never optional.
    let confirmSingleMultiline = true;
    const applyPasteSettings = (s) => {
        confirmSingleMultiline = ((s || {}).confirmations || {}).pasteMultiline !== false;
    };
    rsterm.invoke('rs:settings.get').then(applyPasteSettings);
    rsterm.on('rs:evt.settings-changed', applyPasteSettings);

    function forTab(tabId) {
        let s = state.get(tabId);
        if (!s) { s = { enabled: false, excluded: new Set() }; state.set(tabId, s); }
        return s;
    }

    function participants(tab) {
        const s = forTab(tab.id);
        // Dead panes are not participants: input fanned out to a
        // disconnected session is silently dropped at best, and counting it
        // in "Broadcast: N of M" overstates what a keystroke will do.
        return tab.sessionIds.filter((sid) =>
            !s.excluded.has(sid) && !window.TermPanes.isDead(sid));
    }

    // The stdin router term-pane.js calls for every keystroke. Returns the
    // list of sessionIds the input should reach.
    function routeInput(fromSessionId) {
        const tab = window.Tabs.tabOf(fromSessionId);
        if (!tab) return [fromSessionId];
        const s = forTab(tab.id);
        if (!s.enabled || s.excluded.has(fromSessionId)) return [fromSessionId];
        // Typing in a DEAD pane must never fan out: the user is poking at a
        // corpse (or pressing R to reconnect it), not talking to the tab -
        // with broadcast on, that R would otherwise reach every live switch.
        if (window.TermPanes.isDead(fromSessionId)) return [fromSessionId];
        return participants(tab);
    }

    function toggleBroadcast() {
        const tab = window.Tabs.active();
        if (!tab) return;
        const s = forTab(tab.id);
        s.enabled = !s.enabled;
        refreshChrome();
    }

    function toggleParticipant(sessionId) {
        const tab = window.Tabs.tabOf(sessionId);
        if (!tab) return;
        const s = forTab(tab.id);
        if (s.excluded.has(sessionId)) s.excluded.delete(sessionId);
        else s.excluded.add(sessionId);
        refreshChrome();
    }

    // Broadcast paste, the flagship hotkey. Reads the clipboard, shows the
    // exact payload with line and target counts, sends only on confirm.
    async function pasteAll() {
        const tab = window.Tabs.active();
        if (!tab) return;
        const s = forTab(tab.id);
        const targets = s.enabled ? participants(tab)
            : (tab.focusedSessionId ? [tab.focusedSessionId] : []);
        if (!targets.length) return;

        let text;
        try {
            text = await navigator.clipboard.readText();
        } catch (_) {
            setStatus('clipboard read blocked');
            return;
        }
        if (!text) return;

        const lines = text.split(/\r\n|\r|\n/);
        const multiline = lines.length > 1;

        // Single-line paste to a single pane needs no ceremony; multiline
        // to a single pane confirms unless that dialog was turned off.
        if (targets.length === 1 && (!multiline || !confirmSingleMultiline)) {
            send(targets, text);
            return;
        }

        confirmPaste(text, lines.length, targets.length, () => send(targets, text));
    }

    // Takes the raw pasted text; the wire payload is built per pane,
    // since each remote decides its own bracketed-paste mode.
    // window.Paste owns the rules (newlines, wrapping, injection guard).
    function send(targets, text) {
        for (const sid of targets) {
            const pane = window.TermPanes.panes.get(sid);
            if (pane && pane.port) {
                pane.port.postMessage({ t: 'stdin', data: window.Paste.forTerm(pane.term, text) });
            }
        }
    }

    function confirmPaste(text, lineCount, targetCount, onYes) {
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        const modal = document.createElement('div');
        modal.className = 'modal';

        const h = document.createElement('h2');
        h.textContent = `Send ${lineCount} line${lineCount === 1 ? '' : 's'} to ` +
            `${targetCount} session${targetCount === 1 ? '' : 's'}?`;

        const body = document.createElement('div');
        body.className = 'modal-body';
        const pre = document.createElement('pre');
        pre.style.cssText = 'font-family:var(--mt-mono);font-size:12px;max-height:40vh;overflow:auto;' +
            'background:var(--se-input);border:1px solid var(--se-border);border-radius:4px;padding:8px;';
        pre.textContent = text;
        body.appendChild(pre);

        const actions = document.createElement('div');
        actions.className = 'modal-actions';
        const cancel = document.createElement('button');
        cancel.textContent = 'Cancel';
        const ok = document.createElement('button');
        ok.className = 'primary';
        ok.textContent = 'Send';
        actions.append(cancel, ok);

        // For one session the dialog is a habit-guard, not the broadcast
        // safety interlock, so it can be dismissed for good right here
        // (Settings > Multiline paste brings it back).
        let dontAsk = null;
        if (targetCount === 1) {
            const lbl = document.createElement('label');
            lbl.style.cssText = 'display:flex;gap:6px;align-items:center;' +
                'font-size:12px;color:var(--se-txt-dim);margin-top:8px;';
            dontAsk = document.createElement('input');
            dontAsk.type = 'checkbox';
            const span = document.createElement('span');
            span.textContent = 'Do not ask again when pasting to a single session';
            lbl.append(dontAsk, span);
            body.appendChild(lbl);
        }

        modal.append(h, body, actions);
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);

        const closeModal = () => backdrop.remove();
        cancel.addEventListener('click', closeModal);
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
        ok.addEventListener('click', () => {
            if (dontAsk && dontAsk.checked) {
                rsterm.invoke('rs:settings.update', { confirmations: { pasteMultiline: false } });
            }
            closeModal();
            onYes();
        });
        ok.focus();
    }

    // Visual truth: outlines, toggle glyphs, toolbar count.
    function refreshChrome() {
        // Housekeeping: broadcast state for tabs that no longer exist.
        for (const tabId of [...state.keys()]) {
            if (!window.Tabs.tabs.some((t) => t.id === tabId)) state.delete(tabId);
        }
        const tab = window.Tabs.active();
        const btn = document.getElementById('broadcast-btn');
        if (!tab) { if (btn) btn.textContent = 'Broadcast: off'; return; }
        const s = forTab(tab.id);
        const parts = new Set(s.enabled ? participants(tab) : []);

        for (const sid of tab.sessionIds) {
            const pane = window.TermPanes.panes.get(sid);
            if (!pane || !pane.el) continue;
            pane.el.classList.toggle('broadcast', parts.has(sid));
            const bc = pane.el.querySelector('.bc-toggle');
            if (bc) {
                bc.style.color = s.excluded.has(sid) ? 'var(--se-txt-dim)' : 'var(--se-warn)';
                bc.title = s.excluded.has(sid) ? 'Excluded from broadcast - click to include'
                    : 'In broadcast - click to exclude';
            }
        }
        if (btn) {
            btn.textContent = s.enabled
                ? `Broadcast: ${parts.size} of ${tab.sessionIds.length}`
                : 'Broadcast: off';
            btn.classList.toggle('primary', s.enabled);
        }
    }

    window.MultiExec = {
        routeInput, toggleBroadcast, toggleParticipant, pasteAll, refreshChrome,
        confirmBroadcastPaste: confirmPaste,
        wantsMultilineConfirm: () => confirmSingleMultiline,
    };
})();
