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
            syncRow, syncHint, row('Check sync every (s)', fPoll));

        const note = document.createElement('p');
        note.style.cssText = 'margin-top:10px;color:var(--se-txt-dim);font-size:11px;';
        note.textContent = 'Font and scrollback apply to new sessions.';
        body.appendChild(note);

        open('Settings', body, [
            { label: 'Cancel' },
            {
                label: 'Save', primary: true,
                onClick: () => {
                    rsterm.invoke('rs:settings.update', {
                        mouseMode: Number(fMouse.value),
                        middleClickPaste: fMiddle.value === 'yes',
                        confirmations: { pasteMultiline: fPasteConfirm.value === 'yes' },
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
                },
            },
        ]);
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
