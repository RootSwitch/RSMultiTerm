'use strict';
// Settings dialog: the machine/habit knobs. Device settings live on sessions
// and folders (with inheritance) - deliberately not here.

(function () {
    const { open, row, input, select } = window.Modals;

    async function openSettings() {
        const s = await rsterm.invoke('rs:settings.get');

        const body = document.createElement('div');
        const fMouse = select([
            { value: '1', label: 'Select copies, right-click pastes (PuTTY-style)' },
            { value: '2', label: 'Right-click opens a context menu (Windows-style)' },
        ], String(s.mouseMode || 1));
        const hint = document.createElement('p');
        hint.style.cssText = 'margin:2px 0 10px;color:var(--se-txt-dim);font-size:11px;';
        hint.textContent = 'Ctrl+right-click always does the other mode\'s action.';

        const fMiddle = select([
            { value: 'yes', label: 'Middle-click pastes' },
            { value: 'no', label: 'Middle-click does nothing' },
        ], s.middleClickPaste === false ? 'no' : 'yes');

        const tc = s.terminalColors || { mode: 'theme', background: null };
        const fTermMode = select([
            { value: 'theme', label: 'Follow the app theme' },
            { value: 'dark', label: 'Always dark' },
            { value: 'custom', label: 'Custom Color...' },
        ], tc.mode || 'theme');
        const fTermBg = document.createElement('input');
        fTermBg.type = 'color';
        fTermBg.value = tc.background || '#1b1e25';
        fTermBg.style.cssText = 'width:44px;height:26px;padding:0;';
        const termRow = document.createElement('div');
        termRow.className = 'field-row';
        const termLabel = document.createElement('label');
        termLabel.textContent = 'Terminal colors';
        termRow.append(termLabel, fTermMode, fTermBg);
        const syncTermBg = () => { fTermBg.style.display = fTermMode.value === 'custom' ? '' : 'none'; };
        fTermMode.addEventListener('change', syncTermBg);
        // A floor on text-against-background contrast, applied by xterm to
        // every foreground including the ones a remote program picks for
        // itself. That last part is why this exists and a theme cannot
        // replace it: a device emitting bright green does not know what it
        // is being drawn on.
        const fContrast = select([
            { value: '1', label: 'Off - draw exactly what the device asks for' },
            { value: '3', label: 'Gentle - fix only what is unreadable' },
            { value: '4.5', label: 'Standard - readable body text (WCAG AA)' },
            { value: '7', label: 'Strong - high contrast (WCAG AAA)' },
        ], String(tc.minContrast === undefined ? 3 : tc.minContrast));
        const contrastHint = document.createElement('p');
        contrastHint.style.cssText = 'margin:2px 0 10px;color:var(--se-txt-dim);font-size:11px;';
        contrastHint.textContent = 'Only colors that fail the ratio are adjusted, and the ' +
            'hue is kept - bright green on a light background gets darker, not grey. ' +
            'Applies to open sessions straight away.';
        syncTermBg();

        const fPasteConfirm = select([
            { value: 'yes', label: 'Confirm before sending multiple lines' },
            { value: 'no', label: 'Send multiple lines without asking' },
        ], ((s.confirmations || {}).pasteMultiline === false) ? 'no' : 'yes');

        const fAutoFiles = select([
            { value: 'yes', label: 'Open it when the device supports it' },
            { value: 'no', label: 'Only when I click Files' },
        ], s.autoOpenFileBrowser === false ? 'no' : 'yes');

        // The family field offers the machine's actual monospace fonts
        // instead of demanding the name from memory. queryLocalFonts lists
        // every installed family; a canvas measurement keeps only the
        // fixed-pitch ones, since a proportional face in a terminal is a
        // mistake nobody makes on purpose. A datalist rather than a select:
        // typing still works when enumeration is unavailable.
        const fFontFamily = input(s.font.family, 'monospace');
        fFontFamily.setAttribute('list', 'rsmt-font-families');
        ensureFontList();
        const fFontSize = input(s.font.size, '13', 'number');
        const fScrollback = input(s.scrollbackLines, '10000', 'number');
        const fLogFolder = input(s.defaultLogFolder || '', 'default: logs beside the app');
        fLogFolder.style.flex = '1';
        const logBrowse = document.createElement('button');
        logBrowse.textContent = 'Browse...';
        logBrowse.addEventListener('click', async () => {
            const dir = await rsterm.invoke('rs:sftp.pickFolder');
            if (dir) fLogFolder.value = dir;
        });
        const logRow = document.createElement('div');
        logRow.className = 'field-row';
        const logLabel = document.createElement('label');
        logLabel.textContent = 'Log folder';
        logRow.append(logLabel, fLogFolder, logBrowse);
        // Edit-and-sync hands remote files to this. Blank = whatever the OS
        // associates with the file type (with notepad as the net under it).
        const fEditor = input(s.editorCommand || '', 'default: what the OS opens it with');
        fEditor.style.flex = '1';
        const editorBrowse = document.createElement('button');
        editorBrowse.textContent = 'Browse...';
        editorBrowse.addEventListener('click', async () => {
            const exe = await rsterm.invoke('rs:sftp.pickUpload');
            if (exe) fEditor.value = exe;
        });
        const editorRow = document.createElement('div');
        editorRow.className = 'field-row';
        const editorLabel = document.createElement('label');
        editorLabel.textContent = 'External editor';
        editorRow.append(editorLabel, fEditor, editorBrowse);
        const fTimestamps = select([
            { value: 'yes', label: 'Timestamp each log line' },
            { value: 'no', label: 'No timestamps' },
        ], s.logTimestamps === false ? 'no' : 'yes');
        // Session sync: one tree kept in step with another copy of it -
        // a laptop and a workstation over a NAS share, or a group on SMB.
        // Configured here rather than behind a button of its own, because
        // for most people it is set once and then forgotten.
        const fSyncPath = input((s.teamSync || {}).filePath || '',
            'not syncing - pick a file to start');
        fSyncPath.style.flex = '1';
        const syncBrowse = document.createElement('button');
        syncBrowse.textContent = 'Browse...';
        syncBrowse.addEventListener('click', async () => {
            const p = await rsterm.invoke('rs:team.pickSyncFile');
            if (p) fSyncPath.value = p;
        });
        const syncClear = document.createElement('button');
        syncClear.textContent = 'Stop syncing';
        syncClear.addEventListener('click', () => { fSyncPath.value = ''; });
        const syncRow = document.createElement('div');
        syncRow.className = 'field-row';
        const syncLabel = document.createElement('label');
        syncLabel.textContent = 'Sync sessions file';
        syncRow.append(syncLabel, fSyncPath, syncBrowse, syncClear);
        const syncHint = document.createElement('p');
        syncHint.style.cssText = 'margin:2px 0 10px;color:var(--se-txt-dim);font-size:11px;';
        syncHint.textContent = 'Keeps this machine in step with another copy of your session ' +
            'tree - a share, a synced folder, a NAS. Sessions reference credential profiles ' +
            'by name, so usernames and passwords are never written to it. Publish and check ' +
            'from the session tree\'s Import menu.';

        // Idle animation: a screensaver that lives in the app. Off unless
        // chosen; the style list comes from idle.js so a new style needs no
        // change here.
        const idle = s.idle || { style: 'off', minutes: 5 };
        const styleOpts = [{ value: 'off', label: 'Off' }]
            .concat((window.Idle ? window.Idle.styles() : []).map((x) => ({ value: x.id, label: x.label })))
            .concat([{ value: 'random', label: 'Surprise Me' }]);
        const fIdleStyle = select(styleOpts, idle.style || 'off');
        fIdleStyle.style.flex = '1';
        // Preview, as on a Windows screensaver: saves what is in this
        // dialog, closes it, and plays the chosen style right now. Mostly
        // for troubleshooting "why has it not started" - and for showing
        // it off without a five-minute wait.
        const preview = document.createElement('button');
        preview.textContent = 'Preview';
        preview.title = 'Save these settings, close this dialog, and play the chosen style now';
        const styleRow = document.createElement('div');
        styleRow.className = 'field-row';
        const styleLabel = document.createElement('label');
        styleLabel.textContent = 'Idle animation';
        styleRow.append(styleLabel, fIdleStyle, preview);
        const fIdleMin = input(idle.minutes || 5, '5', 'number');
        const fIdleArea = select([
            { value: 'window', label: 'The whole window' },
            { value: 'panes', label: 'Terminal panes only - sidebar and tabs stay visible' },
        ], idle.area === 'window' ? 'window' : 'panes');
        // How long "Surprise me" stays on one style. Only meaningful for
        // "Surprise me", so it is disabled otherwise rather than hidden - a
        // field that vanishes is a field nobody finds again.
        const fIdleRotate = input(idle.rotateMinutes || 0, '0', 'number');
        const rotateRow = row('Change style every (min)', fIdleRotate);
        const syncRotate = () => {
            const on = fIdleStyle.value === 'random';
            fIdleRotate.disabled = !on;
            rotateRow.style.opacity = on ? '1' : '0.5';
            rotateRow.title = on ? 'Minutes on one style before another is picked. 0 stays put.'
                : 'Only applies to "Surprise me".';
        };
        fIdleStyle.addEventListener('change', syncRotate);
        syncRotate();
        // Which styles "Surprise me" may pick. Grouped by mood with a
        // toggle per group, because the flat checkbox row stopped scanning
        // once there were eleven of them - and because "give me the calm
        // ones" is the request people actually have. Every option stays
        // visible: a dropdown would hide exactly the list being chosen.
        const picks = new Set(Array.isArray(idle.picks) ? idle.picks : []);
        const allStyles = window.Idle ? window.Idle.styles() : [];
        const picksWrap = document.createElement('div');
        picksWrap.className = 'field-stack';
        const picksLabel = document.createElement('label');
        picksLabel.textContent = 'Surprise Me uses';
        const picksBox = document.createElement('div');
        picksBox.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

        const MOODS = [
            { key: 'calm', title: 'Calm', note: 'ambient, slow, easy to look up at' },
            { key: 'lively', title: 'Lively', note: 'busy, fast, or playing a game at you' },
        ];
        const groupBoxes = new Map();
        for (const mood of MOODS) {
            const inThis = allStyles.filter((st) => (st.mood || 'calm') === mood.key);
            if (!inThis.length) continue;
            const group = document.createElement('div');
            group.style.cssText = 'display:flex;flex-direction:column;gap:4px;';

            const head = document.createElement('div');
            head.style.cssText = 'display:flex;align-items:center;gap:8px;';
            const all = document.createElement('button');
            all.type = 'button';
            all.style.cssText = 'font-size:11px;padding:1px 8px;';
            const title = document.createElement('span');
            title.style.cssText = 'font-size:12px;font-weight:600;';
            title.textContent = mood.title;
            const note = document.createElement('span');
            note.style.cssText = 'font-size:11px;color:var(--se-txt-dim);';
            note.textContent = mood.note;
            head.append(title, note, all);

            const box = document.createElement('div');
            box.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px 14px;padding-left:2px;';
            for (const st of inThis) {
                const lab = document.createElement('label');
                lab.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:12px;';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = st.id;
                // "No preference" ticks the default surprise pool - which
                // excludes the clock, so its box starts clear until picked
                // by name, matching what the rotation will actually do.
                cb.checked = picks.size === 0 ? st.surprise !== false : picks.has(st.id);
                const sp = document.createElement('span');
                sp.textContent = st.label;
                lab.append(cb, sp);
                box.appendChild(lab);
            }
            groupBoxes.set(mood.key, box);

            // One button that means both "only these" and "none of these",
            // which is the whole point of grouping: "Surprise me (Calm)" is
            // two clicks - Only calm, then Lively off.
            const sync = () => {
                const boxes = [...box.querySelectorAll('input')];
                const on = boxes.filter((c) => c.checked).length;
                all.textContent = on === boxes.length ? `Turn ${mood.title.toLowerCase()} off`
                    : `Turn ${mood.title.toLowerCase()} on`;
            };
            all.addEventListener('click', () => {
                const boxes = [...box.querySelectorAll('input')];
                const turnOn = boxes.some((c) => !c.checked);
                for (const c of boxes) c.checked = turnOn;
                sync();
            });
            box.addEventListener('change', sync);
            sync();

            group.append(head, box);
            picksBox.appendChild(group);
        }
        picksWrap.append(picksLabel, picksBox);
        const readPicks = () => {
            const boxes = [...picksBox.querySelectorAll('input')];
            const on = boxes.filter((c) => c.checked).map((c) => c.value);
            // The DEFAULT set is every surprise-eligible style, not every
            // style: comparing against all boxes would store [] when the
            // clock is ticked too, and [] excludes the clock at runtime -
            // the ticked box would silently mean nothing. A selection equal
            // to the default stores empty so styles added later join
            // automatically; none ticked means "no preference" too.
            const dflt = allStyles.filter((st) => st.surprise !== false).map((st) => st.id).sort();
            const same = on.length === dflt.length && [...on].sort().every((v, i) => v === dflt[i]);
            return (same || on.length === 0) ? [] : on;
        };
        void groupBoxes;

        const idleHint = document.createElement('p');
        idleHint.style.cssText = 'margin:2px 0 10px;color:var(--se-txt-dim);font-size:11px;';
        idleHint.textContent = 'Starts after that many minutes without keyboard or mouse. ' +
            'Sessions keep running underneath; any key or mouse movement brings them back, ' +
            'and the waking keystroke is never sent to a device.' +
            (window.Idle && window.Idle.reducedMotion()
                ? ' Note: this machine asks apps for reduced motion (Windows Server and RDP ' +
                  'sessions do by default); the animation plays anyway because you turned it on.'
                : '');

        // Zoom keys: Ctrl+Minus doubles as emacs undo (C-_) on a remote,
        // so the modifier is a choice rather than a collision.
        const fZoomMod = select([
            { value: 'ctrl', label: 'Ctrl +/- (default)' },
            { value: 'ctrl+shift', label: 'Ctrl+Shift +/- - leaves Ctrl+Minus for the remote (emacs undo)' },
        ], s.zoomModifier === 'ctrl+shift' ? 'ctrl+shift' : 'ctrl');

        const fPoll = input((s.teamSync || {}).pollSeconds || 60, '60', 'number');

        const fOsc52 = select([
            { value: 'yes', label: 'Let remote programs set the local clipboard' },
            { value: 'no', label: 'Ignore remote clipboard requests' },
        ], (s.osc52 || {}).allowWrite === false ? 'no' : 'yes');
        const osc52Hint = document.createElement('p');
        osc52Hint.style.cssText = 'margin:2px 0 10px;color:var(--se-txt-dim);font-size:11px;';
        osc52Hint.textContent = 'OSC 52: a remote tmux/vim yank reaches your clipboard. ' +
            'Reading your clipboard is always refused, regardless of this setting.';

        body.append(
            row('Mouse mode', fMouse), hint,
            row('Middle click', fMiddle),
            row('Multiline paste', fPasteConfirm),
            termRow, row('Minimum contrast', fContrast), contrastHint,
            row('File browser', fAutoFiles),
            row('Remote clipboard', fOsc52), osc52Hint,
            row('Font', fFontFamily), row('Font size', fFontSize),
            row('Font zoom keys', fZoomMod),
            row('Scrollback lines', fScrollback),
            logRow, row('Log timestamps', fTimestamps), editorRow,
            syncRow, syncHint, row('Check sync every (s)', fPoll),
            styleRow, row('Start after (min)', fIdleMin), row('Play over', fIdleArea),
            picksWrap, rotateRow, idleHint);

        const note = document.createElement('p');
        note.style.cssText = 'margin-top:10px;color:var(--se-txt-dim);font-size:11px;';
        note.textContent = 'Font and scrollback apply to new sessions.';
        body.appendChild(note);

        const collect = () => ({
            mouseMode: Number(fMouse.value),
            middleClickPaste: fMiddle.value === 'yes',
            confirmations: { pasteMultiline: fPasteConfirm.value === 'yes' },
            idle: { style: fIdleStyle.value, minutes: Number(fIdleMin.value) || 5,
                area: fIdleArea.value, picks: readPicks(),
                rotateMinutes: Number(fIdleRotate.value) || 0 },
            autoOpenFileBrowser: fAutoFiles.value === 'yes',
            zoomModifier: fZoomMod.value,
            terminalColors: {
                mode: fTermMode.value,
                minContrast: Number(fContrast.value),
                background: fTermMode.value === 'custom' ? fTermBg.value : null,
            },
            // Blank means "whatever this machine's default is";
            // main owns that choice, so it is sent as null.
            font: { family: fFontFamily.value.trim() || null, size: Number(fFontSize.value) || 13 },
            scrollbackLines: Number(fScrollback.value) || 10000,
            defaultLogFolder: fLogFolder.value.trim() || null,
            editorCommand: fEditor.value.trim() || null,
            logTimestamps: fTimestamps.value === 'yes',
            osc52: { allowWrite: fOsc52.value === 'yes' },
            teamSync: {
                filePath: fSyncPath.value.trim() || null,
                pollSeconds: Number(fPoll.value) || 60,
            },
        });
        const dlg = open('Settings', body, [
            { label: 'Cancel' },
            {
                label: 'Save', primary: true,
                onClick: () => { rsterm.invoke('rs:settings.update', collect()); },
            },
        ]);
        preview.addEventListener('click', async () => {
            await rsterm.invoke('rs:settings.update', collect());
            dlg.close();
            const style = fIdleStyle.value === 'off' ? 'random' : fIdleStyle.value;
            window.Idle.start(style, { area: fIdleArea.value });
        });
    }

    // Build (once) the datalist of installed monospace families.
    let fontListStarted = false;
    async function ensureFontList() {
        if (fontListStarted) return;
        fontListStarted = true;
        let dl = document.getElementById('rsmt-font-families');
        if (!dl) {
            dl = document.createElement('datalist');
            dl.id = 'rsmt-font-families';
            document.body.appendChild(dl);
        }
        let families = [];
        try {
            if (window.queryLocalFonts) {
                const fonts = await window.queryLocalFonts();
                families = [...new Set(fonts.map((f) => f.family))].filter(isMonospace);
            }
        } catch (_) { /* denied or unavailable: fall back below */ }
        if (!families.length) {
            // Enumeration unavailable - which includes every Linux build,
            // since Chromium's Local Font Access API is Windows/macOS only.
            // The usual suspects for the platform, still just suggestions:
            // the field takes anything.
            const ua = navigator.userAgent;
            const common = ['JetBrains Mono', 'Fira Code', 'Source Code Pro', 'Hack'];
            if (/Windows/.test(ua)) {
                families = ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'Courier New',
                    'Lucida Console', ...common];
            } else if (/Mac OS X|Macintosh/.test(ua)) {
                families = ['Menlo', 'Monaco', 'SF Mono', 'Courier New', ...common];
            } else {
                families = ['DejaVu Sans Mono', 'Ubuntu Mono', 'Liberation Mono',
                    'Noto Sans Mono', 'Monospace', ...common];
            }
        }
        dl.replaceChildren();
        for (const fam of families.sort((a, b) => a.localeCompare(b))) {
            const o = document.createElement('option');
            o.value = fam;
            dl.appendChild(o);
        }
    }

    // Fixed-pitch check: in a monospace face, narrow and wide glyphs have
    // the same advance. Measured against the canvas fallback font so a
    // family that fails to load reads as "not monospace" and is dropped.
    let measureCtx = null;
    function isMonospace(family) {
        if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
        try {
            measureCtx.font = `16px "${family.replace(/"/g, '')}"`;
            const narrow = measureCtx.measureText('iiiii').width;
            const wide = measureCtx.measureText('MMMMM').width;
            return narrow > 0 && Math.abs(narrow - wide) < 0.5;
        } catch (_) { return false; }
    }

    window.SettingsUI = { openSettings };
})();
