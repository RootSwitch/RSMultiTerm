'use strict';
// Window construction. The renderer is fully sandboxed: no Node, no network
// (CSP in index.html), everything it can do is enumerated in preload.js.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, screen } = require('electron');

// The window icon, set explicitly rather than left to the executable.
//
// It was previously pointed at build/icon.ico unconditionally, but build/ is
// a build-resources directory that was not packaged: inside the asar the path
// did not resolve, so Electron fell back to its own logo in the title bar and
// Alt-Tab. The file is packaged now, and this checks before using it, so a
// missing icon can never override a good one on the exe.
function windowIcon() {
    // Windows takes the .ico (several sizes in one file, which is what the
    // taskbar and Alt-Tab want); Linux and macOS want a PNG - an .ico set
    // here on Linux is ignored and the window wears Electron's own logo.
    const dir = path.join(__dirname, '..', 'build');
    const names = process.platform === 'win32'
        ? ['icon.ico', 'icon.png']
        : ['icon.png', 'icon.ico'];
    for (const name of names) {
        const file = path.join(dir, name);
        try {
            if (fs.existsSync(file)) return file;
        } catch (_) { /* try the next one */ }
    }
    return null;
}

// A comfortable default for a multi-pane grid, clamped to the display so a
// smaller screen still gets a window that fits on it.
//
// This used to be sized to the toolbar: the whole 1560 existed so one row of
// controls would not overflow, and on any narrower screen the theme picker
// and the buttons beside it were pushed off the edge. Quick connect has its
// own row now, so the top bar holds only fixed-width buttons and fits in far
// less than this - the width is once again about how much terminal you want
// side by side.
const WANT_WIDTH = 1560;
const WANT_HEIGHT = 860;

function createMainWindow() {
    const work = screen.getPrimaryDisplay().workAreaSize;
    const icon = windowIcon();
    const win = new BrowserWindow({
        ...(icon ? { icon } : {}),
        width: Math.min(WANT_WIDTH, work.width),
        height: Math.min(WANT_HEIGHT, work.height),
        minWidth: 900,
        minHeight: 400,
        backgroundColor: '#262a33',   // --se-panel, avoids a white flash
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
            // A terminal keeps parsing output, acking flow-control credit,
            // and feeding logs while minimized or covered. Chromium's
            // occluded-window throttling clamps timers to 1 Hz, which
            // strangles xterm's write scheduler to ~300 KB/s - so it is off.
            backgroundThrottling: false,
        },
    });

    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, '..', 'public', 'index.html'));
    win.once('ready-to-show', () => win.show());

    // The renderer never navigates and never opens windows; anything trying
    // is hostile content and gets dropped.
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // Electron GRANTS permission requests (microphone, camera, ...) by
    // default when no handler is set, so this denies everything except the
    // two the clipboard needs.
    //
    // Both halves are required and it is worth saying why: an earlier
    // version allowed only the write, which silently killed EVERY paste in
    // the app - right-click, middle-click, Ctrl+Shift+V and the context
    // menu all read the clipboard through navigator.clipboard.readText(),
    // which then rejected with "Read permission denied" into a catch that
    // swallowed it. Copy kept working, so it looked like the mouse modes
    // were broken rather than the permission.
    // local-fonts powers the settings dialog's font suggestions
    // (queryLocalFonts) - list-only, no file access.
    const ALLOWED_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write', 'local-fonts']);
    win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
        cb(ALLOWED_PERMISSIONS.has(permission));
    });
    // Chromium asks synchronously on some paths; without this the request
    // handler above is never consulted for those.
    win.webContents.session.setPermissionCheckHandler(
        (_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

    return win;
}

module.exports = { createMainWindow };
