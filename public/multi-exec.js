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
    let groups = [];
    const applyPasteSettings = (s) => {
        confirmSingleMultiline = ((s || {}).confirmations || {}).pasteMultiline !== false;
        groups = Array.isArray((s || {}).broadcastGroups) ? s.broadcastGroups : [];
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
        // Only panes that can actually RECEIVE. Dead is obvious; the subtle
        // one is connecting/authenticating, where the transport's write()
        // silently discards every byte because the shell channel does not
        // exist yet. Counting those panes produced the classic "pushed the
        // config to 5 of 6 switches" failure: the toolbar said 6 of 6, the
        // sixth was still dialing, and nothing anywhere reported the drop.
        return tab.sessionIds.filter((sid) =>
            !s.excluded.has(sid) && window.TermPanes.isReady(sid));
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
        // All panes, whether or not broadcast is ARMED - this action IS a
        // one-shot broadcast, arming is for keystrokes. It used to fall
        // back to just the focused pane when unarmed, which made the menu
        // item a lie. Exclusions still apply: a pane opted out of broadcast
        // is opted out of this too, and only connected panes count.
        const targets = participants(tab);
        if (!targets.length) return setStatus('no connected panes to paste to');

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

    // The one broadcast confirm allowed on screen at a time. Two of these
    // STACK pixel-for-pixel - open() has no idea they are twins - so a
    // second Send while one was up looked like nothing happened, invited a
    // third, and left the user closing identical dialogs one by one
    // wondering where they kept coming from. Cosmetically odd; practically
    // dangerous: every hidden copy was one more armed delivery of the FULL
    // payload to every device in the broadcast. Re-asking is cheap. A
    // queued second send never is.
    let confirmShowing = null;

    function confirmPaste(text, lineCount, targetCount, onYes) {
        if (confirmShowing) {
            // The request is dropped, not queued: a confirm that fires a
            // send the user answered minutes ago is worse than asking again.
            const cancel = confirmShowing.querySelector('.modal-actions button');
            if (cancel) cancel.focus();
            setStatus('answer the send confirmation that is already open');
            return;
        }
        // Built on Modals.open, which this dialog used to bypass - so it
        // missed the Escape stack, the Tab trap, and the focus handback
        // every other dialog gets. Worse, Send was pre-focused: the Enter a
        // user was about to press to run the last pasted line instantly
        // confirmed a multi-device send. Cancel gets the keyboard now -
        // confirming a broadcast is a click or a Tab, never a reflex.
        const body = document.createElement('div');
        const pre = document.createElement('pre');
        pre.style.cssText = 'font-family:var(--mt-mono);font-size:12px;max-height:40vh;overflow:auto;' +
            'background:var(--se-input);border:1px solid var(--se-border);border-radius:4px;padding:8px;';
        pre.textContent = text;
        body.appendChild(pre);

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

        const done = () => { confirmShowing = null; };
        const dialog = window.Modals.open(
            `Send ${lineCount} line${lineCount === 1 ? '' : 's'} to ` +
            `${targetCount} session${targetCount === 1 ? '' : 's'}?`,
            body, [
                { label: 'Cancel', onClick: done },
                {
                    label: 'Send', primary: true,
                    onClick: () => {
                        done();
                        if (dontAsk && dontAsk.checked) {
                            rsterm.invoke('rs:settings.update',
                                { confirmations: { pasteMultiline: false } });
                        }
                        onYes();
                    },
                },
            ], { onCancel: done });
        confirmShowing = dialog.el;
        const cancel = [...dialog.el.querySelectorAll('.modal-actions button')]
            .find((b) => b.textContent === 'Cancel');
        if (cancel) cancel.focus();
    }

    // --- saved broadcast groups -------------------------------------------
    // A named line-up: which SAVED sessions participate when armed. The
    // per-tab exclusion state is exactly what gets persisted - by tree node
    // id, since a sessionId dies with the session. Arming a group in a tab
    // includes its members and excludes everything else, then arms; the
    // count banner is the receipt.

    function saveGroupDialog() {
        const tab = window.Tabs.active();
        if (!tab) return;
        const s = forTab(tab.id);
        const members = [];
        let anonymous = 0;
        for (const sid of tab.sessionIds) {
            if (s.excluded.has(sid)) continue;
            const pane = window.TermPanes.panes.get(sid);
            if (pane && pane.nodeId) members.push(pane.nodeId);
            else anonymous++;
        }
        if (!members.length) {
            window.Forms.showBanner('warn', 'Nothing here to save: a group remembers ' +
                'SAVED sessions, and no included pane in this tab is one.');
            return;
        }
        window.Modals.promptText('Save Broadcast Group',
            `Group name (${members.length} saved session${members.length === 1 ? '' : 's'})`, '')
            .then((name) => {
                if (!name || !name.trim()) return;
                const next = groups.filter((g) => g.name !== name.trim());
                next.push({ name: name.trim(), nodeIds: [...new Set(members)] });
                rsterm.invoke('rs:settings.update', { broadcastGroups: next });
                window.Forms.showBanner('warn',
                    `Saved '${name.trim()}' with ${members.length} member${members.length === 1 ? '' : 's'}.` +
                    (anonymous ? ` ${anonymous} quick-connect pane${anonymous === 1 ? '' : 's'} ` +
                        'could not join - only saved sessions have an identity to remember.' : ''));
            });
    }

    function armGroup(group) {
        const tab = window.Tabs.active();
        if (!tab) return;
        const s = forTab(tab.id);
        const want = new Set(group.nodeIds);
        let included = 0;
        const present = new Set();
        for (const sid of tab.sessionIds) {
            const pane = window.TermPanes.panes.get(sid);
            const member = !!(pane && pane.nodeId && want.has(pane.nodeId));
            if (member) { included++; present.add(pane.nodeId); s.excluded.delete(sid); }
            else s.excluded.add(sid);
        }
        s.enabled = included > 0;
        refreshChrome();
        const absent = group.nodeIds.filter((id) => !present.has(id)).length;
        if (!included) {
            window.Forms.showBanner('warn',
                `'${group.name}': none of its ${group.nodeIds.length} members are open ` +
                'in this tab, so broadcast stays off.');
        } else {
            window.Forms.showBanner('warn',
                `Broadcast armed for '${group.name}': ${included} of ${tab.sessionIds.length} ` +
                `panes here${absent ? ` (${absent} member${absent === 1 ? '' : 's'} not open in this tab)` : ''}.`);
        }
    }

    function groupsMenu(anchor) {
        const items = [];
        for (const g of groups) {
            items.push({
                label: `Arm '${g.name}' (${g.nodeIds.length})`,
                onClick: () => armGroup(g),
            });
        }
        if (groups.length) items.push(null);
        items.push({ label: 'Save Current Line-up as Group...', onClick: saveGroupDialog });
        if (groups.length) {
            items.push({
                label: 'Delete a Group...',
                onClick: () => {
                    window.Modals.menu(anchor.left, anchor.bottom + 2, groups.map((g) => ({
                        label: `Delete '${g.name}'`,
                        onClick: () => rsterm.invoke('rs:settings.update',
                            { broadcastGroups: groups.filter((x) => x.name !== g.name) }),
                    })));
                },
            });
        }
        window.Modals.menu(anchor.left, anchor.bottom + 2, items);
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

    // A tab that gains sessions while broadcast is ARMED changes what the
    // next keystroke reaches, and membership is opt-out - so the newcomers
    // are participants the instant they land. For one added pane that is
    // the designed behavior and worth a warning; for a bulk merge it is how
    // production boxes deliberately kept in a separate tab suddenly join a
    // broadcast, so the merge DISARMS and says so. Re-arming is one click,
    // done by someone who has seen the new count.
    function noteTabGrew(tabId, added, opts) {
        const s = forTab(tabId);
        if (!s.enabled || added <= 0) return;
        if (opts && opts.bulk) {
            s.enabled = false;
            refreshChrome();
            window.Forms.showBanner('warn',
                `Broadcast turned OFF: ${added} session${added === 1 ? '' : 's'} joined this ` +
                'tab in a merge. Re-arm it once you have seen the new line-up.',
                [], { key: 'broadcast-grew' });
            return;
        }
        const active = window.Tabs.active();
        const count = active && active.id === tabId
            ? ` (now ${participants(active).length} panes)` : '';
        refreshChrome();
        window.Forms.showBanner('warn',
            `Broadcast is armed here: the added session receives every keystroke${count}.`,
            [], { key: 'broadcast-grew' });
    }

    window.MultiExec = {
        routeInput, toggleBroadcast, toggleParticipant, pasteAll, refreshChrome, noteTabGrew,
        groupsMenu, armGroup,
        confirmBroadcastPaste: confirmPaste,
        wantsMultilineConfirm: () => confirmSingleMultiline,
    };
})();
