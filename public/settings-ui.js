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
            { value: 'custom', label: 'Custom color...' },
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
            .concat([{ value: 'random', label: 'Surprise me' }]);
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
        ], idle.area === 'panes' ? 'panes' : 'window');
        const idleHint = document.createElement('p');
        idleHint.style.cssText = 'margin:2px 0 10px;color:var(--se-txt-dim);font-size:11px;';
        idleHint.textContent = 'Starts after that many minutes without keyboard or mouse. ' +
            'Sessions keep running underneath; any key or mouse movement brings them back, ' +
            'and the waking keystroke is never sent to a device.' +
            (window.Idle && window.Idle.reducedMotion()
                ? ' Note: this machine asks apps for reduced motion (Windows Server and RDP ' +
                  'sessions do by default); the animation plays anyway because you turned it on.'
                : '');

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
            termRow,
            row('File browser', fAutoFiles),
            row('Remote clipboard', fOsc52), osc52Hint,
            row('Font', fFontFamily), row('Font size', fFontSize),
            row('Scrollback lines', fScrollback),
            logRow, row('Log timestamps', fTimestamps),
            syncRow, syncHint, row('Check sync every (s)', fPoll),
            styleRow, row('Start after (min)', fIdleMin), row('Play over', fIdleArea), idleHint);

        const note = document.createElement('p');
        note.style.cssText = 'margin-top:10px;color:var(--se-txt-dim);font-size:11px;';
        note.textContent = 'Font and scrollback apply to new sessions.';
        body.appendChild(note);

        const collect = () => ({
            mouseMode: Number(fMouse.value),
            middleClickPaste: fMiddle.value === 'yes',
            confirmations: { pasteMultiline: fPasteConfirm.value === 'yes' },
            idle: { style: fIdleStyle.value, minutes: Number(fIdleMin.value) || 5,
                area: fIdleArea.value },
            autoOpenFileBrowser: fAutoFiles.value === 'yes',
            terminalColors: {
                mode: fTermMode.value,
                background: fTermMode.value === 'custom' ? fTermBg.value : null,
            },
            // Blank means "whatever this machine's default is";
            // main owns that choice, so it is sent as null.
            font: { family: fFontFamily.value.trim() || null, size: Number(fFontSize.value) || 13 },
            scrollbackLines: Number(fScrollback.value) || 10000,
            defaultLogFolder: fLogFolder.value.trim() || null,
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
