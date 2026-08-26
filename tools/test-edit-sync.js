'use strict';
// Edit-and-sync: a remote file downloaded, watched, and uploaded on save.
//
// The dangerous moments are all here: the atomic-rename saves editors
// actually perform (which kill naive file watchers), the burst of events
// one Ctrl+S produces (which must not become a burst of uploads), the
// remote changing underneath (which must be refused, not clobbered), and
// saves made while the session is down (which must flush on reconnect,
// under the session's NEW id). The SFTP layer is faked; the filesystem,
// the watcher, and the debounce are real.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const editSync = require('../main/edit-sync');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Debounce + fake-IO latency + watcher slack. Generous on purpose: a CI
// box under load must not turn a real pass into a flaky fail.
const SETTLE = editSync.DEBOUNCE_MS + 600;

// --- fake remote ------------------------------------------------------------

const remote = {
    content: Buffer.from('hostname core-sw-01' + String.fromCharCode(10)),
    mtime: 1000,
    mode: 0o100600,
};
const calls = [];
let chmodMode = null;
let editorOpens = 0;
let events = 0;

async function sftpOp(sessionId, req) {
    calls.push({ sessionId, op: req.op, path: req.path });
    await sleep(25);
    switch (req.op) {
        case 'download':
            fs.writeFileSync(req.local, remote.content);
            return { ok: true };
        case 'stat':
            return { size: remote.content.length, mtime: remote.mtime, mode: remote.mode };
        case 'upload':
            remote.content = fs.readFileSync(req.local);
            remote.mtime += 1;
            return { ok: true };
        case 'chmod':
            chmodMode = req.mode;
            return {};
        default:
            throw new Error(`unexpected op ${req.op}`);
    }
}

const uploads = () => calls.filter((c) => c.op === 'upload');

// The way real editors save: write a temp file, rename it over the
// original. A watcher pinned to the original file's identity dies here.
function atomicSave(file, text) {
    const tmp = `${file}.tmpsave`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

(async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-editsync-'));
    editSync.init({
        sftpOp,
        forward: () => { events++; },
        baseDir,
        openEditor: async () => { editorOpens++; },
    });

    try {
        // --- names from device listings cannot become local path tricks ----
        assert.strictEqual(editSync.safeName('/configs/startup-config'), 'startup-config');
        assert.strictEqual(editSync.safeName('a/..\\evil.exe. '), 'evil.exe',
            'trailing dots and spaces are the Win32 dodge and must go');
        assert.strictEqual(editSync.safeName('x:y|z?.txt'), 'x_y_z_.txt',
            'NTFS stream / reserved characters must be neutralised');
        assert.strictEqual(editSync.safeName('..'), 'file');
        assert.strictEqual(editSync.safeName(''), 'file');

        // --- start: download, baseline, editor ------------------------------
        const en = await editSync.start('s1', '/configs/startup-config');
        assert.strictEqual(en.status, 'watching');
        assert.strictEqual(editorOpens, 1, 'the editor opens exactly once');
        const local = path.join(baseDir, en.id, 'startup-config');
        assert.ok(fs.existsSync(local), 'local copy exists where the entry says');
        assert.strictEqual(fs.readFileSync(local, 'utf8'), remote.content.toString());

        // --- an atomic save uploads, once -----------------------------------
        atomicSave(local, 'hostname core-sw-01' + String.fromCharCode(10) + 'ip domain-name lab' + String.fromCharCode(10));
        await sleep(SETTLE);
        assert.strictEqual(uploads().length, 1, `one save, one upload (got ${uploads().length})`);
        assert.ok(remote.content.toString().includes('ip domain-name lab'),
            'the remote holds what was saved');
        assert.strictEqual(chmodMode, 0o600,
            'the mode survives the upload (temp-and-rename would have reset it)');
        const afterFirst = editSync.list().entries[0];
        assert.ok(afterFirst.lastUploadAt, 'the entry records the upload');
        assert.strictEqual(afterFirst.dirty, false);

        // --- two rapid saves serialise, last content wins -------------------
        atomicSave(local, 'save-A' + String.fromCharCode(10));
        await sleep(60);
        atomicSave(local, 'save-B' + String.fromCharCode(10));
        await sleep(SETTLE + 300);
        assert.ok(uploads().length <= 3, 'rapid saves must not fan out into an upload per event');
        assert.strictEqual(remote.content.toString(), 'save-B' + String.fromCharCode(10),
            'the final save is what the device ends up with');

        // --- the remote changing underneath is refused, not clobbered -------
        const uploadsBefore = uploads().length;
        remote.mtime += 100;                       // someone else edited it
        remote.content = Buffer.from('their change' + String.fromCharCode(10));
        atomicSave(local, 'my change' + String.fromCharCode(10));
        await sleep(SETTLE);
        assert.strictEqual(uploads().length, uploadsBefore,
            'a conflicting save must NOT upload');
        assert.strictEqual(editSync.list().entries[0].status, 'conflict');
        assert.strictEqual(remote.content.toString(), 'their change' + String.fromCharCode(10),
            'their change is untouched while the conflict stands');

        // --- overwrite: my copy wins, deliberately --------------------------
        await editSync.resolve(en.id, 'overwrite');
        await sleep(200);
        assert.strictEqual(remote.content.toString(), 'my change' + String.fromCharCode(10));
        assert.strictEqual(editSync.list().entries[0].status, 'watching');

        // --- theirs: their copy replaces mine, and does NOT bounce back -----
        remote.mtime += 100;
        remote.content = Buffer.from('their second change' + String.fromCharCode(10));
        atomicSave(local, 'mine again' + String.fromCharCode(10));
        await sleep(SETTLE);
        assert.strictEqual(editSync.list().entries[0].status, 'conflict');
        const beforeTheirs = uploads().length;
        await editSync.resolve(en.id, 'theirs');
        await sleep(SETTLE);
        assert.strictEqual(fs.readFileSync(local, 'utf8'), 'their second change' + String.fromCharCode(10),
            'the editor copy now holds the device version');
        assert.strictEqual(uploads().length, beforeTheirs,
            'taking theirs must not upload it straight back (self-echo)');
        assert.strictEqual(remote.content.toString(), 'their second change' + String.fromCharCode(10));

        // --- saves while offline queue, and flush on reconnect --------------
        editSync.onSessionStatus('s1', 'closed');
        const beforeOffline = uploads().length;
        atomicSave(local, 'saved while down' + String.fromCharCode(10));
        await sleep(SETTLE);
        assert.strictEqual(uploads().length, beforeOffline, 'no upload while the session is down');
        const off = editSync.list().entries[0];
        assert.strictEqual(off.status, 'offline');
        assert.strictEqual(off.dirty, true, 'the pending save is visible');

        // The reconnect made a NEW session id; the entry follows it.
        editSync.remapSession('s1', 's2');
        editSync.onSessionStatus('s2', 'connected');
        await sleep(SETTLE);
        assert.strictEqual(remote.content.toString(), 'saved while down' + String.fromCharCode(10),
            'the offline save flushes on reconnect');
        const flush = uploads()[uploads().length - 1];
        assert.strictEqual(flush.sessionId, 's2', 'the flush rides the NEW session id');
        assert.strictEqual(editSync.list().entries[0].status, 'watching');

        // --- stop: watcher off, local copy gone -----------------------------
        editSync.stop(en.id);
        assert.strictEqual(editSync.list().entries.length, 0);
        assert.ok(!fs.existsSync(path.join(baseDir, en.id)),
            'stopping deletes the scratch copy - configs must not linger');

        assert.ok(events > 0, 'state changes were broadcast to the renderer');

        // --- which launcher a file goes to, per platform ---------------------
        // The routing lives in ipc.js (which needs electron), so the lists and
        // the branch are lifted out by source. Two opposite mistakes are
        // possible here and both have been made:
        //
        //   Too permissive on Windows: shell.openPath is ShellExecute's `open`
        //   verb, so a device's .cmd or .py is RUN, not opened.
        //   Too strict elsewhere: requiring a known text extension refuses
        //   `startup-config`, `running-config`, `sshd_config` - i.e. almost
        //   everything anyone edits on a device - and Linux got exactly that
        //   for a day.
        {
            const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc.js'), 'utf8');
            const grab = (re, name) =>
                new Function(`${ipcSrc.match(re)[0]}\nreturn ${name};`)();
            const TEXTISH = grab(/const TEXTISH = new Set\(\[[\s\S]*?\]\);/, 'TEXTISH');
            const LAUNCHABLE = grab(/const LAUNCHABLE = new Set\(\[[\s\S]*?\]\);/, 'LAUNCHABLE');
            // The REAL branch, lifted from openEditor and run - not a copy of
            // it written here. A first version of this test re-implemented the
            // decision, which meant re-opening the ShellExecute hole in ipc.js
            // left the test green: it pinned the lists and nothing else.
            const branchSrc = ipcSrc.match(
                /const ext = path\.extname\(file\)\.toLowerCase\(\);[\s\S]*?const assocOk = [\s\S]*?;\n/);
            assert.ok(branchSrc, 'the editor-routing branch must be findable in ipc.js');
            const decide = new Function('path', 'TEXTISH', 'LAUNCHABLE', 'file', 'platform',
                `const process = { platform };\n${branchSrc[0]}\nreturn assocOk;`);
            const usesAssociation = (file, platform) =>
                decide(path, TEXTISH, LAUNCHABLE, file, platform);

            for (const f of ['evil.cmd', 'payload.exe', 'script.py', 'x.vbs',
                'y.hta', 'z.bat', 'w.js', 'startup-config']) {
                assert.strictEqual(usesAssociation(f, 'win32'), false,
                    `on Windows the association must not receive ${f} - it would run it`);
            }
            for (const f of ['switch.cfg', 'notes.txt', 'data.json', 'run.log']) {
                assert.strictEqual(usesAssociation(f, 'win32'), true,
                    `plain text should still open with its handler: ${f}`);
            }
            for (const f of ['startup-config', 'running-config', 'sshd_config',
                'vlan.dat', 'script.py']) {
                assert.strictEqual(usesAssociation(f, 'linux'), true,
                    `on Linux ${f} must reach an editor - the file is not executable there`);
            }
            for (const f of ['trap.desktop', 'thing.appimage', 'payload.exe', 'app.jar']) {
                assert.strictEqual(usesAssociation(f, 'linux'), false,
                    `a desktop launches ${f} without an execute bit - not the association`);
            }
        }

        console.log('ok - edit-and-sync (atomic saves, debounce, conflicts, offline flush, ' +
            'cleanup, per-platform editor routing)');
    } finally {
        editSync.stopAll();
        try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
})().catch((err) => { console.error('FAIL -', err.stack || err.message); process.exit(1); });
