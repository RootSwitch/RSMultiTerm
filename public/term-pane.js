'use strict';
// Terminal pane lifecycle: one xterm Terminal per session, opened once into a
// host div that survives for the session's lifetime. Panes re-parent between
// the visible grid and the offscreen #session-pool - never destroyed, so
// scrollback and selection live as long as the session does.
//
// window.TermPanes is the registry the tab/grid layer drives.

(function () {
    const panes = new Map();   // sessionId -> pane record

    // Cached app settings for new terminals; live panes keep their options.
    // Placeholder until main answers with the real settings (which carry a
    // platform-appropriate default); the CSS stack covers the gap.
    let appSettings = { font: { family: '' }, scrollbackLines: 10000 };
    if (window.rsterm) {
        rsterm.invoke('rs:settings.get').then((s) => { if (s) { appSettings = s; refreshTheme(); } });
        rsterm.on('rs:evt.settings-changed', (s) => { appSettings = s; refreshTheme(); });
    }

    // Fixed dark palette: the original terminal colors, kept as an explicit
    // choice for people who want a dark terminal inside a light app chrome.
    const DARK = { background: '#1b1e25', foreground: '#e6e9ef', accent: '#4c8bf5' };

    // OSC 52 clipboard bridge, per pane. The security shape is the whole
    // point: READ is refused unconditionally - a remote asking "what is on
    // your clipboard?" could scoop up a password just copied, and no
    // setting turns that on. WRITE is the useful direction (tmux/vim yank
    // reaching the local clipboard) and honors the osc52.allowWrite
    // setting, with a size cap so a hostile server cannot shove megabytes
    // in, and a quiet status-line note so it is never fully invisible.
    const OSC52_MAX = 256 * 1024;
    function osc52Provider(sessionId) {
        return {
            // Selection is 'c' (clipboard) or 'p' (primary); only the real
            // clipboard is ever touched, matching the addon's own default.
            readText() { return Promise.resolve(''); },
            writeText(selection, data) {
                if (selection !== 'c') return Promise.resolve();
                if (!((appSettings.osc52 || {}).allowWrite !== false)) return Promise.resolve();
                if (typeof data !== 'string' || !data || data.length > OSC52_MAX) return Promise.resolve();
                return navigator.clipboard.writeText(data).then(() => {
                    const pane = panes.get(sessionId);
                    const where = pane ? pane.title : 'a session';
                    setStatus(`${where} set the clipboard (${data.length} chars) via OSC 52`);
                }, () => { /* focus lost or permission denied */ });
            },
        };
    }

    function setStatus(text) {
        const el = document.getElementById('status-text');
        if (el) el.textContent = text;
    }

    // --- font zoom ----------------------------------------------------------
    // Ctrl+mousewheel (and Ctrl+plus/minus) scales every terminal at once -
    // the screen-share "make it readable from the back row" control. The
    // zoom is session-only on purpose: it does not touch settings, and
    // Ctrl+0 snaps back to the configured size, so a meeting-time bump
    // never becomes a permanent surprise.
    let zoomSize = null;    // null = follow settings
    function effectiveFontSize() {
        return zoomSize !== null ? zoomSize : ((appSettings.font || {}).size || 13);
    }
    function zoom(delta) {
        if (delta === 0) {
            if (zoomSize === null) return;
            zoomSize = null;
        } else {
            const next = Math.max(7, Math.min(40, effectiveFontSize() + delta));
            if (next === effectiveFontSize() && zoomSize !== null) return;
            zoomSize = next;
        }
        const size = effectiveFontSize();
        for (const pane of panes.values()) pane.term.options.fontSize = size;
        window.Grid.refit();
        setStatus(zoomSize === null
            ? `terminal font back to ${size}px (settings default)`
            : `terminal font ${size}px - Ctrl+0 resets`);
    }

    // Delegated: one listener, every pane, capture so xterm cannot swallow
    // it first. passive:false because zooming must preventDefault, or
    // Chromium ALSO zooms the whole page chrome.
    window.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        if (!e.target || !e.target.closest || !e.target.closest('.rs-term-host')) return;
        e.preventDefault();
        zoom(e.deltaY < 0 ? 1 : -1);
    }, { passive: false, capture: true });

    function cssVar(name, fallback) {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return v || fallback;
    }

    // The xterm palette, resolved from settings + the active app theme.
    // mode 'theme' follows the chosen palette (--se-input is the same surface
    // the pane chrome uses, so the terminal stops being a dark hole in a
    // light theme); 'dark' pins the original; 'custom' takes a chosen color
    // and derives a readable foreground for it.
    function terminalTheme() {
        const cfg = appSettings.terminalColors || { mode: 'theme' };
        let background, foreground, accent;

        if (cfg.mode === 'dark') {
            ({ background, foreground, accent } = DARK);
        } else if (cfg.mode === 'custom' && cfg.background) {
            background = cfg.background;
            foreground = window.Colors.isLight(background) ? '#1b1e25' : '#e6e9ef';
            accent = cssVar('--se-accent', DARK.accent);
        } else {
            background = cssVar('--se-input', DARK.background);
            foreground = cssVar('--se-txt', DARK.foreground);
            accent = cssVar('--se-accent', DARK.accent);
        }

        return {
            background,
            foreground,
            cursor: foreground,
            cursorAccent: background,
            selectionBackground: window.Colors.rgba(accent, 0.35),
        };
    }

    // The contrast floor xterm holds every foreground to, including the
    // ones a remote program chose for itself. xterm only adjusts colors
    // that FAIL the ratio, so this leaves a legible palette untouched and
    // rescues the combinations that are not - bright green on a light
    // theme's background being the one that prompted it.
    function minContrast() {
        const cfg = appSettings.terminalColors || {};
        const n = Number(cfg.minContrast);
        return Number.isFinite(n) && n >= 1 ? Math.min(21, n) : 3;
    }

    // Current terminal background, so the highlight engine can keep rule
    // colors legible against it.
    function currentBackground() {
        return terminalTheme().background;
    }

    // Re-palette every live terminal: theme change, or a settings change.
    function refreshTheme() {
        window.Colors.clearCache();
        const theme = terminalTheme();
        const floor = minContrast();
        for (const pane of panes.values()) {
            pane.term.options.theme = theme;
            // Live, not just for the next session opened: changing this and
            // seeing nothing happen is how a setting becomes decorative.
            pane.term.options.minimumContrastRatio = floor;
            if (pane.highlighter) pane.highlighter.rescan();
        }
    }

    function create(sessionId, title, highlightSet, transport) {
        const host = document.createElement('div');
        host.className = 'rs-term-host';

        const term = new Terminal({
            scrollback: appSettings.scrollbackLines || 10000,
            // The configured face first, then a per-platform ladder: a
            // Linux box has no Cascadia and a Windows box has no DejaVu.
            fontFamily: `'${(appSettings.font || {}).family || 'monospace'}', Consolas, ` +
                `'DejaVu Sans Mono', 'Ubuntu Mono', Menlo, monospace`,
            fontSize: effectiveFontSize(),
            theme: terminalTheme(),
            minimumContrastRatio: minContrast(),
            allowProposedApi: true,
        });
        const fit = new FitAddon.FitAddon();
        term.loadAddon(fit);
        const search = new SearchAddon.SearchAddon();
        term.loadAddon(search);
        // OSC 52: a remote program yanking to the local clipboard. Optional
        // like the other addons - a load failure costs the feature, not the
        // pane.
        try {
            term.loadAddon(new ClipboardAddon.ClipboardAddon(undefined, osc52Provider(sessionId)));
        } catch (_) { /* no remote-clipboard bridge in this pane */ }
        // Serialize turns a live buffer back into the escape sequences that
        // reproduce it - how a restored pane keeps yesterday's scrollback.
        // Optional on purpose: an addon that fails to load must cost the
        // feature it powers, not every terminal in the app. (It has already
        // cost that once, when the script tag went missing and pane
        // creation threw before a single session could open.)
        let serialize = null;
        try {
            serialize = new SerializeAddon.SerializeAddon();
            term.loadAddon(serialize);
        } catch (_) { /* no scrollback in workspace snapshots */ }
        term.open(host);

        // WebGL renderer: the difference between a `show tech` that scrolls
        // and one that stutters. Loaded after open() (it needs the element),
        // with the documented fallback: on context loss dispose the addon
        // and let xterm's DOM renderer take over.
        try {
            const webgl = new WebglAddon.WebglAddon();
            webgl.onContextLoss(() => webgl.dispose());
            term.loadAddon(webgl);
        } catch (_) { /* no GPU / blocklisted driver: DOM renderer is fine */ }

        const pane = {
            sessionId, title, host, term, fit, search, serialize,
            transport: transport || 'ssh',
            // Workspace snapshots read this to restore per-session
            // highlight rules; it was never stored, so every snapshot
            // saved null and restored panes wore the default rules.
            highlightSet: highlightSet || null,
            // The tree node this pane came from, when it came from one -
            // how a rename in the tree reaches an open pane's title.
            nodeId: null,
            // Output arrived while this pane's tab was in the background.
            unread: false,
            // A watched highlight rule matched while backgrounded.
            alert: false,
            port: null,
            state: 'connecting',
            el: null,          // grid cell wrapper, set by layout
            dot: null,
        };
        // Native paste (Ctrl+V, Shift+Insert) lands in xterm's own textarea
        // listener and would flow through onData - and with broadcast on,
        // out to every pane - without the confirm every other paste path
        // gets. Intercept it before xterm sees it and route it through the
        // same confirm-aware path as right-click and Ctrl+Shift+V.
        host.addEventListener('paste', (e) => {
            e.preventDefault();
            e.stopImmediatePropagation();
            const text = e.clipboardData ? e.clipboardData.getData('text') : '';
            if (text && window.ContextMenu) window.ContextMenu.pasteInto(pane, text);
        }, true);
        panes.set(sessionId, pane);
        // A refusal that raced this pane's creation was held by app.js;
        // deliver it now or it is lost and the pane dials forever.
        if (window.App && window.App.takeEarlyStatus) {
            const held = window.App.takeEarlyStatus(sessionId);
            if (held) setTimeout(() => setState(pane, held.state, held.detail), 0);
        }
        wireSemantics(pane);
        if (window.Highlight) window.Highlight.attach(pane, highlightSet);
        if (window.ContextMenu) window.ContextMenu.armCopyOnSelect(pane);
        checkSavable(sessionId);
        return pane;
    }

    // --- OSC 133 semantic prompts ----------------------------------------
    // Shells with shell integration (and the fixture switches) mark their
    // output: A = prompt start, B = prompt end, C = command output begins,
    // D;exit = command finished. When the marks are present they give the
    // terminal a memory of WHERE commands are: jump prompt-to-prompt, copy
    // the last command's output without mouse-selecting 400 lines, and a
    // red bar on any command that failed. Without them nothing changes.
    const MAX_COMMANDS = 500;

    function wireSemantics(pane) {
        const term = pane.term;
        pane.commands = [];
        term.parser.registerOscHandler(133, (data) => {
            const kind = data[0];
            const cur = pane.commands[pane.commands.length - 1];
            if (kind === 'A') {
                const marker = term.registerMarker(0);
                if (marker) {
                    pane.commands.push({ prompt: marker, output: null, end: null, exit: null, deco: null });
                    if (pane.commands.length > MAX_COMMANDS) disposeCommand(pane.commands.shift());
                }
            } else if (kind === 'C') {
                if (cur && !cur.output) cur.output = term.registerMarker(0);
            } else if (kind === 'D') {
                if (cur && cur.exit === null) {
                    cur.exit = Number(data.split(';')[1]) || 0;
                    cur.end = term.registerMarker(0);
                    // Failed commands get a red bar on their prompt line -
                    // success stays visually silent, failure is findable
                    // when scrolling back through a long change window.
                    if (cur.exit !== 0 && cur.prompt && !cur.prompt.isDisposed) {
                        const deco = term.registerDecoration({ marker: cur.prompt, x: 0, width: 1, layer: 'top' });
                        if (deco) {
                            deco.onRender((el) => el.classList.add('mt-cmd-failed'));
                            cur.deco = deco;
                        }
                    }
                }
            }
            return true;
        });
    }

    function disposeCommand(c) {
        for (const m of [c.prompt, c.output, c.end, c.deco]) {
            if (m) m.dispose();
        }
    }

    // Absolute buffer lines of the live prompt marks, for navigation.
    function promptLines(sessionId) {
        const pane = panes.get(sessionId);
        if (!pane || !pane.commands) return [];
        return pane.commands
            .filter((c) => c.prompt && !c.prompt.isDisposed)
            .map((c) => c.prompt.line);
    }

    // Text between the last finished command's C and D marks.
    function lastCommandOutput(sessionId) {
        const pane = panes.get(sessionId);
        if (!pane || !pane.commands) return null;
        for (let i = pane.commands.length - 1; i >= 0; i--) {
            const c = pane.commands[i];
            if (!c.output || c.output.isDisposed || !c.end || c.end.isDisposed) continue;
            const buf = pane.term.buffer.active;
            const lines = [];
            for (let y = c.output.line; y < c.end.line && y < buf.length; y++) {
                const line = buf.getLine(y);
                if (line) lines.push(line.translateToString(true));
            }
            return lines.join('\n');
        }
        return null;
    }

    function destroy(sessionId) {
        const pane = panes.get(sessionId);
        if (!pane) return;
        if (pane.port) { pane.port.close(); pane.port = null; }
        if (window.SftpPanel) window.SftpPanel.forget(sessionId);
        if (pane.highlighter) pane.highlighter.dispose();
        pane.term.dispose();
        pane.host.remove();
        panes.delete(sessionId);
    }

    function attachPort(sessionId, port) {
        const pane = panes.get(sessionId);
        if (!pane) { port.close(); return; }
        pane.port = port;

        port.onmessage = (e) => {
            const m = e.data;
            if (!m || typeof m !== 'object') return;
            if (m.t === 'data') {
                // Output landing in a BACKGROUND tab is news the user has
                // not seen; the tab strip says so until they look. Only the
                // transition is reported - data arrives in bursts, and the
                // strip does not need repainting per chunk. Panes in the
                // active tab are all visible in the grid, so their output
                // is by definition being seen.
                if (!pane.unread && window.Tabs) {
                    const owner = window.Tabs.tabOf(pane.sessionId);
                    const active = window.Tabs.active();
                    if (owner && (!active || owner.id !== active.id)) {
                        pane.unread = true;
                        window.Tabs.updateStatus();
                    }
                }
                // Credit returns only after xterm has parsed the bytes, so
                // the engine's window measures true end-to-end absorption.
                const bytes = m.buf.byteLength;
                pane.term.write(m.buf, () => {
                    port.postMessage({ t: 'ack', seq: m.seq, bytes });
                });
            } else if (m.t === 'status') {
                setState(pane, m.state, m.detail);
            }
        };

        pane.term.onData((data) => {
            // Route through multi-exec: normally just this session, but with
            // broadcast on, every participating pane in the tab.
            const targets = window.MultiExec
                ? window.MultiExec.routeInput(sessionId) : [sessionId];
            for (const sid of targets) {
                const p = panes.get(sid);
                if (p && p.port) p.port.postMessage({ t: 'stdin', data });
            }
        });
        pane.term.onResize(({ cols, rows }) => {
            port.postMessage({ t: 'resize', cols, rows });
        });
        // ...and state the size we are ALREADY at. The port can attach
        // either side of the pane being mounted and measured: if the fit
        // happened first, its resize event fired before this listener
        // existed and the far end would keep the 80x24 it was opened with
        // forever. A shell wrapping at 80 in a 180-column terminal eats a
        // row every time a long command is recalled from history.
        port.postMessage({ t: 'resize', cols: pane.term.cols, rows: pane.term.rows });
    }

    // States a session does not come back from on its own. A pane in one of
    // these is offering the R key.
    const DEAD = new Set(['closed', 'error', 'auth-blocked']);

    // Whether a freshly-connected session may grab the keyboard. Only the
    // focused pane of the active tab qualifies, and never out from under a
    // form field or an open dialog: a slow session connecting in a
    // background tab must not redirect the rest of a password being typed
    // into a prompt (or anything else) into a live remote shell.
    function mayTakeFocus(pane) {
        const tab = window.Tabs && window.Tabs.active();
        if (!tab || tab.focusedSessionId !== pane.sessionId) return false;
        if (document.querySelector('.modal-backdrop')) return false;
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.isContentEditable ||
            (ae.tagName === 'TEXTAREA' && !ae.classList.contains('xterm-helper-textarea')))) {
            return false;
        }
        return true;
    }

    function setState(pane, state, detail) {
        const wasDead = DEAD.has(pane.state);
        pane.state = state;
        if (pane.dot) pane.dot.className = 'status-dot ' + state;
        const status = document.getElementById('status-text');
        if (status) {
            status.textContent = `${pane.title}: ${state}${detail ? ' - ' + detail : ''}`;
        }
        if (state === 'connected' && mayTakeFocus(pane)) pane.term.focus();

        // Say so in the pane itself: a status dot in a six-pane grid is easy
        // to miss, and the whole point is to catch a switch as it comes
        // back. The REASON goes in too - an orange-then-red dot with no
        // words left "wrong password?" and "credential out of scope" and
        // "host down" all looking identical.
        if (DEAD.has(state) && !wasDead) {
            const why = detail
                ? `\x1b[31m[${window.App.plainText(detail)}]\x1b[0m\r\n` : '';
            pane.term.write(`\r\n${why}\x1b[2m[disconnected - press R to reconnect]\x1b[0m\r\n`);
        }
        // And in the tab strip, so a background tab can show it too.
        if (window.Tabs) window.Tabs.updateStatus();
        // Broadcast chrome tracks pane state: a pane dying or coming up
        // mid-broadcast changes who receives the next keystroke, and the
        // outlines and the "N of M" count must say so at that moment, not
        // at the next focus change.
        if (window.MultiExec) window.MultiExec.refreshChrome();

        if (window.SftpPanel) {
            if (state === 'connected') window.SftpPanel.considerAutoOpen(pane.sessionId);
            // SFTP rides the session's connection, so a dead session means a
            // dead file browser - it must not keep showing a live-looking
            // listing for a device that has hung up.
            else if (DEAD.has(state)) window.SftpPanel.noteDead(pane.sessionId);
        }
    }

    // Able to receive input RIGHT NOW: the shell channel exists. Between
    // 'connecting' and 'connected' the transport's write() is a silent
    // discard, so broadcast must not count such a pane as a recipient.
    function isReady(sessionId) {
        const pane = panes.get(sessionId);
        return !!pane && pane.state === 'connected';
    }

    function isDead(sessionId) {
        const pane = panes.get(sessionId);
        return !!pane && DEAD.has(pane.state);
    }

    // Mount a pane into a parent element (grid cell or pool) and refit.
    function mount(sessionId, parentEl) {
        const pane = panes.get(sessionId);
        if (!pane) return;
        parentEl.appendChild(pane.host);
        requestAnimationFrame(() => pane.fit.fit());
    }

    // Save the visible buffer plus scrollback as plain text. Plain text on
    // purpose: the point is a paste-into-a-ticket record, not a replayable
    // escape-sequence stream (session logging already exists for that).
    async function saveOutput(sessionId) {
        const pane = panes.get(sessionId);
        if (!pane) return;
        const buf = pane.term.buffer.active;
        const lines = [];
        for (let i = 0; i < buf.length; i++) {
            const line = buf.getLine(i);
            lines.push(line ? line.translateToString(true) : '');
        }
        while (lines.length && !lines[lines.length - 1]) lines.pop();
        const name = `${(pane.title || 'session').replace(/[^A-Za-z0-9.@-]+/g, '_')}-output.txt`;
        try {
            const r = await rsterm.invoke('rs:term.saveText', {
                name, text: lines.join(String.fromCharCode(10)) });
            if (r && r.path) setStatus(`saved ${lines.length} lines to ${r.path}`);
        } catch (err) {
            setStatus(`save failed: ${err.message}`);
        }
    }

    // Whether this session could be saved into the tree. Asked once per
    // pane, here, so every creation path gets it - quick connect,
    // duplicate, reconnect, workspace restore - without each one
    // remembering to. Panes opened FROM the tree answer no, which is what
    // hides the button for them.
    function checkSavable(sessionId) {
        rsterm.invoke('rs:session.describe', { sessionId }).then((d) => {
            const pane = panes.get(sessionId);
            if (!pane || !d || !d.savable) return;
            pane.savable = true;
            pane.saveArgs = d.args;
            window.Grid.render(true);   // the header gains its save button
        }).catch(() => { /* a session that vanished cannot be saved */ });
    }

    window.TermPanes = {
        create, attachPort, mount, setState, destroy, panes, checkSavable,
        refreshTheme, currentBackground, isDead, isReady,
        promptLines, lastCommandOutput, zoom, saveOutput,
        // null means "following Settings", so anything else is a zoom the
        // user can be offered a way out of.
        isZoomed: () => zoomSize !== null,
    };
})();
