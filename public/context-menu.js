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
        // Broadcasting multi-line input always confirms. A single pane
        // confirms multiline too - each line can execute the moment it
        // lands in a shell - unless the user turned that dialog off.
        if (lines.length > 1 &&
            (targets.length > 1 || window.MultiExec.wantsMultilineConfirm())) {
            window.MultiExec.confirmBroadcastPaste(text, lines.length, targets.length, send);
        } else {
            send();
        }
    }

    // --- context menu (mode 2) -------------------------------------------
    function showMenu(e, pane) {
        closeMenu();
        const menu = document.createElement('div');
        menu.id = 'term-menu';
        menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:2000;` +
            'background:var(--se-panel);border:1px solid var(--se-border);border-radius:4px;' +
            'display:flex;flex-direction:column;min-width:170px;box-shadow:0 4px 14px rgba(0,0,0,.4);';
        const add = (label, fn, disabled) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.disabled = !!disabled;
            b.style.cssText = 'border:none;background:none;text-align:left;padding:6px 12px;border-radius:0;';
            if (!disabled) {
                b.addEventListener('mouseenter', () => b.style.background = 'var(--se-panel-2)');
                b.addEventListener('mouseleave', () => b.style.background = 'none');
                b.addEventListener('click', () => { closeMenu(); fn(); });
            }
            menu.appendChild(b);
        };
        const sel = pane.term.getSelection();
        const lastOut = window.TermPanes.lastCommandOutput(pane.sessionId);
        add('Copy', () => navigator.clipboard.writeText(sel), !sel);
        add('Paste', () => pasteInto(pane));
        add('Paste to all panes', () => window.MultiExec.pasteAll());
        // Only offered when the shell actually marks its commands (OSC 133);
        // greyed-out clutter would just advertise a feature the device the
        // user is on cannot do.
        add('Copy last command output', () => navigator.clipboard.writeText(lastOut), lastOut === null);
        add('Select all', () => pane.term.selectAll());
        add('Save output as...', () => window.TermPanes.saveOutput(pane.sessionId));
        if (pane.transport === 'ssh') {
            add('Install SSH key on this device...', () => window.Forms.installKeyDialog(pane.sessionId));
        }
        add('Clear scrollback', () => pane.term.clear());
        // Only for SSH: there is no shell to integrate with on a serial
        // console into a switch, and none on a telnet vty either.
        if (pane.transport === 'ssh') {
            add('Shell integration...', () => window.ShellIntegration.openDialog());
        }
        document.body.appendChild(menu);
        setTimeout(() => document.addEventListener('mousedown', outside, { capture: true }));
        function outside(ev) {
            if (!menu.contains(ev.target)) closeMenu();
        }
        function closeMenuInner() {
            document.removeEventListener('mousedown', outside, { capture: true });
        }
        menu.dataset.cleanup = '1';
        menu._cleanup = closeMenuInner;
    }
    function closeMenu() {
        const m = document.getElementById('term-menu');
        if (m) { if (m._cleanup) m._cleanup(); m.remove(); }
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
