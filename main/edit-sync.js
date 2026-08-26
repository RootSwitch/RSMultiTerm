'use strict';
// Edit a remote file in the LOCAL editor, uploading on every save - the
// MobaXterm workflow, minus the bundled editor. The file is downloaded to a
// private scratch folder, handed to whatever editor the user actually
// lives in, and watched; each save goes back to the remote path it came
// from. Watching continues until the user stops it or the session closes -
// deliberately NOT until the editor exits, because VS Code and Notepad++
// are single-instance and their process lifetime means nothing.
//
// Plain node, no electron: the pieces that need the app (SFTP, events,
// opening the editor) are injected, which is also what makes this module
// testable without a window.

const fs = require('fs');
const path = require('path');

// Editors save several events' worth of noise per Ctrl+S (temp write,
// rename, attribute touch); one upload per save is the goal, so changes
// settle for a moment before anything is done about them.
const DEBOUNCE_MS = 400;

let deps = null;   // { sftpOp, forward, baseDir, openEditor }
const entries = new Map();   // id -> entry
let nextId = 1;

function init(d) {
    deps = d;
    // Scratch copies are remote configs and occasionally key material; a
    // crash must not leave last week's router config in a temp folder.
    // Live entries clean up in stop() - this sweeps what a crash left.
    try { fs.rmSync(deps.baseDir, { recursive: true, force: true }); } catch (_) { /* locked */ }
    fs.mkdirSync(deps.baseDir, { recursive: true });
}

// The remote name becomes a LOCAL filename, and directory listings are
// device-controlled input - same threat as the file browser's downloads.
// Last path segment only, Windows-hostile characters out, and the trailing
// dots/spaces Win32 strips on create (so 'evil.exe. ' can not dodge a
// check aimed at 'evil.exe').
function safeName(remotePath) {
    const last = String(remotePath == null ? '' : remotePath).split(/[/\\]/).pop();
    const cleaned = last
        .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
        .replace(/[. ]+$/, '');
    if (!cleaned || cleaned === '.' || cleaned === '..') return 'file';
    return cleaned;
}

function pub(e) {
    return {
        id: e.id, sessionId: e.sessionId, name: e.name, remotePath: e.remotePath,
        status: e.offline ? 'offline' : e.status,
        dirty: !!e.dirty, lastUploadAt: e.lastUploadAt || null, error: e.error || null,
    };
}

function list() {
    return { entries: [...entries.values()].map(pub) };
}

function broadcast() {
    deps.forward('rs:evt.edit-sync', list());
}

// --- watching ---------------------------------------------------------------

// The directory is watched, not the file: most editors save by writing a
// temp file and renaming it over the original, which kills a watcher
// pinned to the original's identity at the first Ctrl+S. Each entry owns
// its directory, so everything that happens in it is about this file.
function watch(e) {
    try {
        e.watcher = fs.watch(e.dir, (_ev, filename) => {
            if (filename && filename !== e.name) return;
            schedule(e);
        });
        e.watcher.on('error', () => pollInstead(e));
    } catch (_) {
        pollInstead(e);
    }
}

// Fallback when fs.watch cannot (network drives, exotic filesystems):
// stat polling. Slower to notice, impossible to starve.
function pollInstead(e) {
    if (e.polling) return;
    e.polling = true;
    fs.watchFile(e.localPath, { interval: 1000 }, () => schedule(e));
}

function unwatch(e) {
    clearTimeout(e.debounce);
    if (e.watcher) { try { e.watcher.close(); } catch (_) { /* closed */ } e.watcher = null; }
    if (e.polling) { fs.unwatchFile(e.localPath); e.polling = false; }
}

function schedule(e) {
    clearTimeout(e.debounce);
    e.debounce = setTimeout(() => check(e), DEBOUNCE_MS);
}

function check(e) {
    if (!entries.has(e.id)) return;
    let st;
    try {
        st = fs.statSync(e.localPath);
    } catch (_) {
        // Mid-save gap: the editor renamed the old file away and has not
        // put the new one down yet. The rename that completes the save
        // fires its own event.
        return;
    }
    if (st.mtimeMs === e.localMtime && st.size === e.localSize) return;
    e.localMtime = st.mtimeMs;
    e.localSize = st.size;
    queueUpload(e);
}

// --- uploading --------------------------------------------------------------

function queueUpload(e) {
    e.dirty = true;
    if (e.offline) { broadcast(); return; }
    if (e.uploading) { e.pendingUpload = true; return; }
    doUpload(e, false);
}

async function doUpload(e, force) {
    e.uploading = true;
    e.status = 'uploading';
    e.error = null;
    broadcast();
    try {
        // Conflict check: if the remote moved since OUR last write, someone
        // else edited it, and silently clobbering their change is the one
        // unforgivable behavior for this feature. SFTP mtimes are seconds.
        // Skipped when the device could not answer a stat (SCP-only gear) -
        // no baseline means nothing to compare, not a reason to refuse.
        if (!force && e.remoteMtime !== null) {
            let st = null;
            try { st = await deps.sftpOp(e.sessionId, { op: 'stat', path: e.remotePath }); }
            catch (_) { /* stat lost its footing mid-session; upload anyway */ }
            if (st && st.mtime > e.remoteMtime) {
                e.status = 'conflict';
                e.uploading = false;
                broadcast();
                return;
            }
        }
        await deps.sftpOp(e.sessionId, { op: 'upload', local: e.localPath, path: e.remotePath });
        // The upload replaced the file via temp-and-rename, which reset its
        // mode; put it back. Best effort - plenty of network gear answers
        // SETSTAT with an error or a lie, and the upload still counts.
        if (e.mode !== null) {
            try {
                await deps.sftpOp(e.sessionId,
                    { op: 'chmod', path: e.remotePath, mode: e.mode & 0o7777 });
            } catch (_) { /* device does not do modes */ }
        }
        try {
            const st = await deps.sftpOp(e.sessionId, { op: 'stat', path: e.remotePath });
            e.remoteMtime = st.mtime;
        } catch (_) { /* keep the old baseline */ }
        e.lastUploadAt = Date.now();
        e.dirty = false;
        e.status = 'watching';
    } catch (err) {
        e.status = 'error';
        e.error = err.message;
    }
    e.uploading = false;
    if (e.pendingUpload) {
        e.pendingUpload = false;
        queueUpload(e);
        return;
    }
    broadcast();
}

// --- API --------------------------------------------------------------------

async function start(sessionId, remotePath) {
    const name = safeName(remotePath);
    const id = `e${nextId++}`;
    const dir = path.join(deps.baseDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const localPath = path.join(dir, name);
    const e = {
        id, sessionId, remotePath, name, dir, localPath,
        mode: null, remoteMtime: null, localMtime: 0, localSize: 0,
        status: 'watching', error: null, lastUploadAt: null,
        dirty: false, offline: false, uploading: false, pendingUpload: false,
        watcher: null, polling: false, debounce: null,
    };
    try {
        await deps.sftpOp(sessionId, { op: 'download', path: remotePath, local: localPath });
    } catch (err) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* empty */ }
        throw err;
    }
    try {
        const st = await deps.sftpOp(sessionId, { op: 'stat', path: remotePath });
        e.mode = typeof st.mode === 'number' ? st.mode : null;
        e.remoteMtime = typeof st.mtime === 'number' ? st.mtime : null;
    } catch (_) { /* SCP-only device: no conflict checks, no mode reassert */ }
    const st = fs.statSync(localPath);
    e.localMtime = st.mtimeMs;
    e.localSize = st.size;
    entries.set(id, e);
    watch(e);
    try {
        await deps.openEditor(localPath);
    } catch (err) {
        // The sync is up regardless; the file is at a real path the user
        // can open by hand, so a broken editor setting is a note, not a
        // failure.
        e.error = `editor: ${err.message}`;
    }
    broadcast();
    return pub(e);
}

function stop(id) {
    const e = entries.get(id);
    if (!e) return list();
    unwatch(e);
    entries.delete(id);
    // The local copy is deleted with the entry: these are device configs
    // and occasionally key material, and "stopped syncing" must not mean
    // "left on disk".
    try { fs.rmSync(e.dir, { recursive: true, force: true }); } catch (_) { /* locked by editor */ }
    broadcast();
    return list();
}

function stopAll() {
    for (const id of [...entries.keys()]) stop(id);
}

// 'overwrite' pushes the local copy over the remote change; 'theirs'
// abandons ours and takes the remote version into the editor.
async function resolve(id, action) {
    const e = entries.get(id);
    if (!e) return list();
    if (action === 'overwrite') {
        await doUpload(e, true);
        return list();
    }
    if (action === 'theirs') {
        await deps.sftpOp(e.sessionId, { op: 'download', path: e.remotePath, local: e.localPath });
        // Baselines refresh BEFORE the watcher's debounce fires, so the
        // download we just made does not read as a user save and upload
        // itself straight back.
        const st = fs.statSync(e.localPath);
        e.localMtime = st.mtimeMs;
        e.localSize = st.size;
        try {
            const rs = await deps.sftpOp(e.sessionId, { op: 'stat', path: e.remotePath });
            e.remoteMtime = typeof rs.mtime === 'number' ? rs.mtime : e.remoteMtime;
        } catch (_) { /* keep the old baseline */ }
        e.dirty = false;
        e.status = 'watching';
        broadcast();
    }
    return list();
}

// Sessions come and go under the entries. Offline entries keep watching -
// saves accumulate as 'dirty' - and flush when their session returns.
function onSessionStatus(sessionId, state) {
    let touched = false;
    for (const e of entries.values()) {
        if (e.sessionId !== sessionId) continue;
        if (state === 'connected' && e.offline) {
            e.offline = false;
            touched = true;
            if (e.dirty) queueUpload(e);
        } else if (state !== 'connected' && state !== 'connecting' && !e.offline) {
            e.offline = true;
            touched = true;
        }
    }
    if (touched) broadcast();
}

// Reconnect creates a NEW session id; the entries follow it, and the
// 'connected' status that arrives under the new id flushes them.
function remapSession(oldId, newId) {
    for (const e of entries.values()) {
        if (e.sessionId === oldId) e.sessionId = newId;
    }
}

module.exports = {
    init, start, stop, stopAll, list, resolve,
    onSessionStatus, remapSession, safeName,
    DEBOUNCE_MS,
};
