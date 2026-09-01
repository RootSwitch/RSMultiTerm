'use strict';
// App lifecycle: fork the session engine, open the window, wire IPC, and
// supervise the engine so a native-module crash restarts it instead of
// taking the app down.

const path = require('path');
const { app, utilityProcess, Menu } = require('electron');
const { createMainWindow } = require('./windows');
const { wireIpc } = require('./ipc');
const store = require('./store');
const sessionStore = require('./session-store');
const secrets = require('./secrets');
const hostkeys = require('./hostkeys');
const highlights = require('./highlights');
const settings = require('./settings');
const safeLog = require('./safe-log');
const { devOnlyHook } = require('./dev-hooks');

// Before anything can write a diagnostic: a broken stdout must never
// surface as a main-process crash dialog. See safe-log.js.
safeLog.install();

// Electron installs a default menu whose accelerators stay live even with
// the menu bar hidden: Ctrl+R reloads the renderer (killing every live
// session), and Ctrl+= / Ctrl+- / Ctrl+0 page-zoom the whole UI out from
// under the terminal font shortcuts. No menu, no surprise accelerators.
Menu.setApplicationMenu(null);

let win = null;
const engineRef = { proc: null };
let onEngineMessage = () => {};
let onEngineExit = () => {};
let quitting = false;

// Smoke mode drives an automated connect-capture-quit pass for testing
// without a human: RSMT_SMOKE=1 RSMT_SMOKE_TARGET=host:port:user:pass.
//
// RSMT_SMOKE_PROBE hands a string to executeJavaScript, and RSMT_SMOKE_
// SAVETEXT names a file to write - a code-execution hook and a write
// primitive that have no business existing in a build handed to anyone
// else. Both are refused when packaged (see devOnlyHook); the connect-and-
// screenshot pass stays available, because that is what verifies a
// packaged build actually boots.
const bootConfig = (() => {
    if (process.env.RSMT_SMOKE !== '1') return { smoke: false };
    const [host, port, username, password] = (process.env.RSMT_SMOKE_TARGET || '').split(':');
    return {
        smoke: true, host, port: Number(port) || 22, username, password,
        transport: process.env.RSMT_SMOKE_TRANSPORT || 'ssh',
        cmd: process.env.RSMT_SMOKE_CMD || 'show version',
        grid: process.env.RSMT_SMOKE_GRID || null,
        tree: process.env.RSMT_SMOKE_TREE === '1',
        sftp: process.env.RSMT_SMOKE_SFTP === '1',
    };
})();

function forkEngine() {
    const proc = utilityProcess.fork(
        path.join(__dirname, '..', 'engine', 'engine.js'),
        [], { serviceName: 'rsmultiterm-engine' });

    proc.on('message', (m) => onEngineMessage(m));
    proc.on('exit', (code) => {
        engineRef.proc = null;
        if (quitting) return;
        // Unplanned death: re-fork and tell the renderer its sessions died.
        safeLog.error(`engine exited unexpectedly (code ${code}), restarting`);
        // Sweep everything waiting on the dead engine: canaries and parked
        // connects, SFTP transfer promises, host-key prompts.
        onEngineExit();
        forkEngine();
        if (win && !win.isDestroyed()) {
            win.webContents.send('rs:evt.engine-restarted', { code });
        }
    });

    engineRef.proc = proc;
}

// Windows groups taskbar buttons - and picks the icon for them - by
// AppUserModelID, not by the window's icon. Without this, a dev run is
// "electron.exe" and wears Electron's icon however the window is configured.
// Must match the appId in electron-builder.yml so an installed copy and a
// dev run are the same identity.
if (process.platform === 'win32') app.setAppUserModelId('dev.rootswitch.rsmultiterm');

// Folder-portable: the portable marker honored beside the REAL exe, not
// only via the env var the single-file stub sets. The stub re-extracts
// ~260 MB on every launch by design (its NSIS template deletes and
// unpacks unconditionally), which costs ~5s per start - so the folder
// build IS the fast portable: unzip win-unpacked anywhere, drop
// rsmultiterm-portable.txt beside RSMultiTerm.exe, and data and logs
// live beside it at installed-build speed.
//
// One refusal: a directory holding the NSIS uninstaller is an INSTALL,
// and self-contained data inside an uninstaller's target is the exact
// lifetime mistake the log folders just escaped - removing the app
// would remove the sessions and profiles too.
if (!process.env.PORTABLE_EXECUTABLE_DIR && app.isPackaged) {
    try {
        const fs = require('fs');
        const exeDir = path.dirname(app.getPath('exe'));
        if (fs.existsSync(path.join(exeDir, 'rsmultiterm-portable.txt')) &&
            !fs.existsSync(path.join(exeDir, 'Uninstall RSMultiTerm.exe'))) {
            process.env.PORTABLE_EXECUTABLE_DIR = exeDir;
        }
    } catch (_) { /* an unreadable exe dir is just not portable */ }
}

app.whenReady().then(() => {
    // Data dir resolution: env override (tests) > portable marker beside the
    // exe (fully self-contained on a share or USB stick) > normal userData.
    let dataDir = process.env.RSMT_DATA || null;
    if (!dataDir && process.env.PORTABLE_EXECUTABLE_DIR) {
        const portableRoot = process.env.PORTABLE_EXECUTABLE_DIR;
        const fs = require('fs');
        if (fs.existsSync(path.join(portableRoot, 'rsmultiterm-portable.txt'))) {
            dataDir = path.join(portableRoot, 'data');
            app.setPath('userData', path.join(portableRoot, 'data', 'chromium'));
        }
    }
    store.init(dataDir || path.join(app.getPath('userData'), 'data'));
    settings.init();
    sessionStore.init();
    secrets.init();
    hostkeys.init();
    highlights.init();
    require('./snippets').init();
    require('./tunnel-store').init();
    require('./workspace').init();
    require('./health').init();

    // Smoke tree mode: seed a fictional estate against the local fixture
    // servers so the saved-session path (profiles, canary, jump host) runs
    // end to end with no human. Only ever touches an empty store.
    if (bootConfig.tree && Object.keys(sessionStore.nodes()).length === 0) {
        const secretsMod = secrets;
        secretsMod.upsert({ name: 'Lab SSH', username: 'nettest', storage: 'prompt' });
        const lab = sessionStore.upsert({
            type: 'folder', name: 'Lab',
            defaults: { credentialProfile: 'Lab SSH' },
        });
        const bastion = sessionStore.upsert({
            type: 'session', name: 'core-sw-01', parentId: lab.id,
            host: '127.0.0.1', port: 2222,
        });
        sessionStore.upsert({
            type: 'session', name: 'acc-sw-03', parentId: lab.id,
            host: '127.0.0.1', port: 2224,
        });
        sessionStore.upsert({
            type: 'session', name: 'acc-sw-04 (via jump)', parentId: lab.id,
            host: '127.0.0.1', port: 2225, jumpHost: bastion.id,
        });
        sessionStore.upsert({
            type: 'session', name: 'dist-sw-02', parentId: lab.id,
            host: '127.0.0.1', port: 2323, transport: 'telnet',
        });
    }
    forkEngine();
    win = createMainWindow();
    const wired = wireIpc(engineRef, () => win, bootConfig);
    onEngineMessage = wired.onEngineMessage;
    onEngineExit = wired.onEngineExit;

    // Closing the window with live sessions is the classic Ctrl+W-adjacent
    // disaster; one confirm, only when sessions are actually open. On the
    // way out the renderer gets one chance to hand over a final snapshot
    // WITH scrollback, which is the difference between restoring a layout
    // and restoring a layout you can still read.
    //
    // Taking that snapshot re-enters this handler (cancel, save, close
    // again), so the sequencing lives in close-flow.nextStep and the two
    // booleans below - otherwise the second pass asks about live sessions
    // all over again.
    const closeFlow = require('./close-flow');
    let confirmed = false;
    let snapshotTaken = false;
    win.on('close', (e) => {
        for (;;) {
            const step = closeFlow.nextStep({
                quitting,
                smoke: bootConfig.smoke,
                liveCount: wired.liveCount(),
                confirmed,
                snapshotTaken,
            });
            if (step === 'allow') return;
            if (step === 'confirm') {
                const n = wired.liveCount();
                const { dialog } = require('electron');
                const choice = dialog.showMessageBoxSync(win, {
                    type: 'warning',
                    buttons: ['Close anyway', 'Keep working'],
                    defaultId: 1,
                    cancelId: 1,
                    message: `${n} session${n === 1 ? '' : 's'} still connected`,
                    detail: 'Closing the window disconnects them all. The layout is saved: ' +
                        'reopening offers to restore these panes.',
                });
                if (choice !== 0) return e.preventDefault();
                confirmed = true;
                continue;
            }
            // 'snapshot'
            e.preventDefault();
            snapshotTaken = true;
            wired.requestFinalSnapshot().then(() => win.close());
            return;
        }
    });
    // Focus is one of the three team-sync check triggers (poll and
    // pre-publish are the others).
    win.on('focus', () => {
        const teamSync = require('./team-sync');
        if ((settings.get().teamSync || {}).checkOnFocus !== false) teamSync.check('focus');
    });

    if (bootConfig.smoke) {
        // Give the renderer time to connect and paint, then capture proof.
        setTimeout(async () => {
            try {
                // Renderer console does not reliably reach a piped terminal
                // on Windows, so pull the diagnostic out through
                // executeJavaScript and print it from main, which does.
                const probeSource = devOnlyHook('RSMT_SMOKE_PROBE');
                if (probeSource) {
                    const probe = await win.webContents.executeJavaScript(probeSource, true);
                    safeLog.log('smoke probe: ' + JSON.stringify(probe));
                } else if (process.env.RSMT_SMOKE_PROBE) {
                    safeLog.log('smoke probe: refused - packaged builds do not run test hooks');
                }
                const image = await win.webContents.capturePage();
                const fs = require('fs');
                const out = process.env.RSMT_SMOKE_SHOT ||
                    path.join(app.getPath('temp'), 'rsmultiterm-smoke.png');
                fs.writeFileSync(out, image.toPNG());
                safeLog.log(`smoke: captured ${out}`);
            } catch (err) {
                safeLog.error('smoke: capture failed', err);
            }
            app.quit();
        }, Number(process.env.RSMT_SMOKE_MS) || 6000);
    }
});

app.on('before-quit', () => {
    quitting = true;
    if (engineRef.proc) engineRef.proc.postMessage({ t: 'shutdown' });
});

app.on('window-all-closed', () => app.quit());
