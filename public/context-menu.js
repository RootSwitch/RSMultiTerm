'use strict';
// Mouse modes - the one setting a split team fights over, so both exist:
//
//   Mode 1 "PuTTY-style":  select copies, right-click pastes.
//   Mode 2 "Windows-style": right-click opens a context menu; Ctrl+Shift+C/V.
//
// In each mode Ctrl+right-click performs the OTHER mode's action, so nobody
// is ever more than one modifier from the behavior they expect. Middle-click
// paste is its own toggle. Pasting while broadcast is on routes through the
// multi-exec confirm rules - a right-click must not be quieter than Ctrl+V.

(function () {
    let mode = 1;
    let middlePaste = true;

    function applySettings(s) {
        mode = s.mouseMode || 1;
        middlePaste = s.middleClickPaste !== false;
    }
    rsterm.invoke('rs:settings.get').then(applySettings);
    rsterm.on('rs:evt.settings-changed', applySettings);

    function paneFromEvent(e) {
        const host = e.target.closest('.rs-term-host');
        if (!host) return null;
        for (const pane of window.TermPanes.panes.values()) {
            if (pane.host === host) return pane;
        }
        return null;
    }

    // --- copy on select (mode 1) -----------------------------------------
    // Wired per terminal by term-pane calling armCopyOnSelect.
    function armCopyOnSelect(pane) {
        pane.term.onSelectionChange(() => {
            if (mode !== 1) return;
            const sel = pane.term.getSelection();
            if (sel) navigator.clipboard.writeText(sel).catch(() => { /* focus lost */ });
        });
    }

    // --- paste ------------------------------------------------------------
    // text is optional: the native-paste interceptor already has the payload
    // from the DOM event; every other caller lets this read the clipboard.
    async function pasteInto(pane, text) {
        if (text === undefined) {
            try {
                text = await navigator.clipboard.readText();
            } catch (err) {
                // Swallowing this is how a denied clipboard permission
                // turned into "the mouse modes do not work": every paste
                // path failed here, in silence, for weeks.
                const el = document.getElementById('status-text');
                if (el) el.textContent = `paste failed: ${err.message}`;
                return;
            }
        }
        if (!text) return;
        const targets = window.MultiExec.routeInput(pane.sessionId);
        const lines = text.split(/\r\n|\r|\n/);
        const send = () => {
            // Payload built per target: panes in a broadcast can disagree
            // about bracketed-paste mode (a Linux box beside a switch).
            // window.Paste owns the rules - and the sudo-flush story.
            for (const sid of targets) {
                const p = window.TermPanes.panes.get(sid);
                if (p && p.port) {
                    p.port.postMessage({ t: 'stdin', data: window.Paste.forTerm(p.term, text) });
                }
            }
        };
        // Same predicate as pasteAll, deliberately: ANY broadcast paste
        // confirms, single-line included - "reload" with no newline fanned
        // to eight switches deserves a dialog - and multiline to one pane
        // confirms unless that dialog was turned off. This path used to
        // require multiline before it would confirm anything, making
        // right-click quieter than Ctrl+Shift+V, which the header of this
        // file promises it never is.
        if (targets.length > 1 ||
            (lines.length > 1 && window.MultiExec.wantsMultilineConfirm())) {
            window.MultiExec.confirmBroadcastPaste(text, lines.length, targets.length, send);
        } else {
            send();
        }
    }

    // --- context menu (mode 2) -------------------------------------------
    // Built through Modals.menu rather than by hand. This used to be its own
    // popup, which meant it missed everything the shared one already did:
    // flipping back on screen near an edge (right-click low or far right and
    // half the menu was outside the window), Escape to dismiss, and putting
    // the keyboard back where it was. That last one is why Paste appeared to
    // work and then swallow the Enter after it - focus was sitting on a
    // button that no longer existed, so the terminal never saw the key.
    async function showMenu(e, pane) {
        const sel = pane.term.getSelection();
        const lastOut = window.TermPanes.lastCommandOutput(pane.sessionId);
        const items = [
            { label: 'Copy', onClick: () => navigator.clipboard.writeText(sel), disabled: !sel },
            { label: 'Paste', onClick: () => pasteInto(pane) },
            { label: 'Paste to All Panes', onClick: () => window.MultiExec.pasteAll() },
            // Only offered when the shell actually marks its commands (OSC
            // 133); greyed-out clutter would just advertise a feature the
            // device the user is on cannot do.
            { label: 'Copy Last Command Output', disabled: lastOut === null,
                onClick: () => navigator.clipboard.writeText(lastOut) },
            null,
            { label: 'Select All', onClick: () => pane.term.selectAll() },
            { label: 'Save Output As...', onClick: () => window.TermPanes.saveOutput(pane.sessionId) },
            null,
        ];
        // Only for SSH: there is no shell to integrate with on a serial
        // console into a switch, and none on a telnet vty either.
        if (pane.transport === 'ssh') {
            items.push({ label: 'Install SSH Key on This Device...',
                onClick: () => window.Forms.installKeyDialog(pane.sessionId) });
        }
        items.push({ label: 'Clear Scrollback', onClick: () => pane.term.clear() });
        if (pane.transport === 'ssh') {
            items.push({ label: 'Shell Integration...',
                onClick: () => window.ShellIntegration.openDialog() });
        }
        // Serial line controls. State is read fresh so the DTR/RTS labels
        // tell the truth; a session that just died degrades to no section
        // rather than a menu of dead switches.
        if (pane.transport === 'serial') {
            let st = null;
            try {
                st = await rsterm.invoke('rs:serial.signal',
                    { sessionId: pane.sessionId, req: { op: 'status' } });
            } catch (_) { /* not open; below */ }
            const say = (msg) => {
                const el = document.getElementById('status-text');
                if (el) el.textContent = msg;
            };
            const sig = async (req, done) => {
                try {
                    const r = await rsterm.invoke('rs:serial.signal',
                        { sessionId: pane.sessionId, req });
                    say(done(r));
                } catch (err) { say(`serial: ${err.message}`); }
            };
            if (st) {
                const s = st.signals || {};
                items.push(null, {
                    label: 'Send Break',
                    onClick: () => sig({ op: 'break' }, (r) => `break sent (${r.ms} ms)`),
                }, {
                    label: `DTR is ${s.dtr ? 'high' : 'low'} - set ${s.dtr ? 'low' : 'high'}`,
                    onClick: () => sig({ op: 'set', dtr: !s.dtr },
                        (r) => `DTR ${r.signals.dtr ? 'high' : 'low'}`),
                }, {
                    label: `RTS is ${s.rts ? 'high' : 'low'} - set ${s.rts ? 'low' : 'high'}`,
                    onClick: () => sig({ op: 'set', rts: !s.rts },
                        (r) => `RTS ${r.signals.rts ? 'high' : 'low'}`),
                }, {
                    label: `Line speed (${st.baud})...`,
                    onClick: async () => {
                        const v = await window.Modals.promptText('Line speed',
                            'Baud rate', String(st.baud));
                        if (!v) return;
                        sig({ op: 'baud', baud: Number(v.trim()) },
                            (r) => `line speed now ${r.baud}`);
                    },
                });
            }
        }
        window.Modals.menu(e.clientX, e.clientY, items);
    }

    // --- global wiring ----------------------------------------------------
    document.addEventListener('contextmenu', (e) => {
        const pane = paneFromEvent(e);
        if (!pane) return;
        e.preventDefault();
        const flipped = e.ctrlKey;
        const menuMode = (mode === 2) !== flipped;   // XOR: ctrl flips the mode
        if (menuMode) showMenu(e, pane);
        else pasteInto(pane);
    });

    document.addEventListener('auxclick', (e) => {
        if (e.button !== 1 || !middlePaste) return;
        const pane = paneFromEvent(e);
        if (!pane) return;
        e.preventDefault();
        pasteInto(pane);
    });

    window.ContextMenu = { armCopyOnSelect, pasteInto };
})();
