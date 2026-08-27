'use strict';
// Recursive folder download, done entirely inside the engine.
//
// Two reasons it lives here rather than being a loop in the renderer, which
// is where the existing multi-file download runs:
//
//   1. SPEED. Every file the renderer downloads is a full round trip -
//      renderer to main to engine and back - and it waits for each one. For
//      167 small files that is 167 serial round trips on top of 167
//      open/read/close sequences, which is exactly the "watch each file copy
//      over" pace MobaXterm has. Walking and fetching in one place lets
//      several files be in flight at once, and ssh2's fastGet already
//      pipelines the reads inside a single file. Small files are round-trip
//      bound, not bandwidth bound.
//   2. SAFETY. Recursion turns one device-controlled filename into a whole
//      device-controlled directory TREE, and every component of it steers a
//      local path. A listing that answers with '..' or 'C:evil' or a symlink
//      pointing at '/' must not be able to write outside the folder the user
//      picked, or walk forever. The rules are in one place and tested.
//
// Symlinks are never followed. A link is not a file we were asked for, and
// a directory link is how a walk becomes infinite. They are counted and
// reported rather than silently dropped.

const fs = require('fs');
const path = require('path');

// Caps, so a hostile or merely enormous tree cannot run the app out of
// memory or disk. These are generous for real use: nobody drags a
// half-million-file tree out of a switch by accident.
const MAX_FILES = 20000;
const MAX_DEPTH = 32;
// Breadth needs its own caps: depth alone does not bound a walk against a
// server that answers every readdir with a thousand fresh subdirectories.
// Files were capped from the start; the QUEUE was not, so a hostile tree
// could still grow it - and the local mkdir list - without limit.
const MAX_DIRS = 5000;
const MAX_READDIRS = 10000;
const CONCURRENCY = 6;

// One path component, made safe to put on a local filesystem. Same rules as
// the renderer's localName, applied to every level of the tree instead of
// just the leaf: null means "this name cannot be written safely".
// Names Windows reserves for devices, with or without an extension:
// 'nul' and 'con.txt' both resolve to the device, so a remote file called
// nul would "download" into nothingness while being counted a success.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function safeComponent(name) {
    const last = String(name == null ? '' : name).split(/[/\\]/).pop();
    if (!last || last === '.' || last === '..' || last.includes(':')) return null;
    // Characters Win32 refuses in names, plus control bytes. A remote
    // directory named 'a|b' used to reach mkdirSync, which threw and took
    // the whole batch with it.
    if (/[<>"|?*\x00-\x1f]/.test(last)) return null;
    // Win32 strips trailing dots and spaces when creating the file, so
    // 'evil.exe. ' and 'evil.exe' are the same file - and that is also how
    // '..' would sneak past the check above as '.. '.
    const trimmed = last.replace(/[. ]+$/, '');
    if (!trimmed || trimmed === '.' || trimmed === '..') return null;
    if (RESERVED.test(trimmed)) return null;
    return trimmed;
}

// The local path for a remote tree path, or null if any component of it is
// unsafe. The final containment check is belt and braces: even if a
// component slipped through above, the result must still be inside root.
function localFor(root, parts) {
    const clean = [];
    for (const p of parts) {
        const c = safeComponent(p);
        if (!c) return null;
        clean.push(c);
    }
    const full = path.resolve(root, ...clean);
    const base = path.resolve(root);
    if (full !== base && !full.startsWith(base + path.sep)) return null;
    return full;
}

const readdir = (sftp, dir) => new Promise((res, rej) =>
    sftp.readdir(dir, (e, list) => (e ? rej(e) : res(list))));

// Walk the remote tree breadth-first, collecting files to fetch and
// directories to create. Nothing is downloaded here - the walk is cheap and
// finishing it first means the progress report can say "of 167" rather than
// counting up from nowhere.
async function walk(sftp, remoteRoot, localRoot, onNote) {
    const files = [];
    const dirs = [];
    const skipped = { links: 0, unsafe: 0 };
    let truncated = false;
    let readdirs = 0;
    // Distinct remote names can collide on ONE local path: 'a' and 'a. '
    // both clean to 'a', and README vs readme collide on a case-insensitive
    // filesystem - which is most of the machines this app runs on. With six
    // transfers in flight, two fastGets holding the same local path open
    // interleave their writes and both count as successes. First name wins;
    // the collision is skipped, counted, and said out loud.
    const claimed = new Set();

    const queue = [{ remote: remoteRoot, parts: [] }];
    while (queue.length) {
        // Once ANY cap is hit the walk is a lie either way - stop taking
        // readdirs from the server rather than continuing to grow state.
        if (truncated) break;
        const here = queue.shift();
        if (here.parts.length > MAX_DEPTH) { truncated = true; continue; }
        if (++readdirs > MAX_READDIRS) { truncated = true; break; }
        let list;
        try {
            list = await readdir(sftp, here.remote);
        } catch (err) {
            // A directory we cannot read is worth saying out loud, but it
            // must not abandon the rest of the tree.
            onNote(`skipped ${here.remote}: ${err.message}`);
            continue;
        }
        for (const it of list) {
            const mode = (it.attrs && it.attrs.mode) || 0;
            const isLink = (mode & 0xF000) === 0xA000;
            const isDir = (mode & 0xF000) === 0x4000;
            if (isLink) { skipped.links++; continue; }
            const parts = here.parts.concat([it.filename]);
            const local = localFor(localRoot, parts);
            if (!local) { skipped.unsafe++; continue; }
            const fold = local.toLowerCase();
            if (claimed.has(fold)) {
                skipped.unsafe++;
                onNote(`skipped ${it.filename}: its name collides with another entry on this filesystem`);
                continue;
            }
            claimed.add(fold);
            const remote = `${here.remote.replace(/\/+$/, '')}/${it.filename}`;
            if (isDir) {
                if (dirs.length >= MAX_DIRS) { truncated = true; continue; }
                dirs.push(local);
                queue.push({ remote, parts });
            } else {
                if (files.length >= MAX_FILES) { truncated = true; continue; }
                files.push({ remote, local, size: it.attrs ? it.attrs.size : 0 });
            }
        }
    }
    return { files, dirs, skipped, truncated };
}

// Fetch with a small pool. Concurrency is what turns this from a minute into
// a few seconds on a tree of small files; it stays small because each
// fastGet is itself pipelining reads, and stacking too many of those on one
// SSH channel just moves the queue.
async function fetchAll(sftp, files, onEach) {
    let next = 0;
    let done = 0;
    const failures = [];
    const worker = async () => {
        for (;;) {
            const i = next++;
            if (i >= files.length) return;
            const f = files[i];
            // Fetched under a temp name and renamed on success, so a
            // failure deletes only what THIS transfer wrote - never a file
            // that was already there - and a half-written config can never
            // sit on disk looking complete.
            const tmp = `${f.local}.part`;
            try {
                await new Promise((res, rej) =>
                    sftp.fastGet(f.remote, tmp, {}, (e) => (e ? rej(e) : res())));
                fs.renameSync(tmp, f.local);
            } catch (err) {
                try { fs.unlinkSync(tmp); } catch (_) { /* never created */ }
                failures.push({ remote: f.remote, error: err.message });
            }
            onEach(++done, files.length, f);
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
    return failures;
}

// req: {path, local}. `local` is the folder the user picked; the remote
// folder's own name is NOT appended here - the caller decides where the tree
// lands, so "download into this folder" and "download as this folder" are
// both expressible.
async function downloadTree(sftp, req, onProgress) {
    const localRoot = path.resolve(req.local);
    // Created, not required: the caller passes <picked folder>/<remote
    // name>, which by definition does not exist yet on a first download.
    // Requiring it made the feature fail on first use for everyone whose
    // destination was not already there - which the test masked, because
    // the test pre-created it.
    fs.mkdirSync(localRoot, { recursive: true });

    const notes = [];
    onProgress({ phase: 'scanning', files: 0, total: 0 });
    const { files, dirs, skipped, truncated } =
        await walk(sftp, req.path, localRoot, (n) => notes.push(n));

    // One undecipherable directory loses that subtree, not the batch: its
    // mkdir failure is noted here, and the files beneath it fail per-file
    // in fetchAll exactly as an unreadable remote file would.
    for (const d of dirs) {
        try {
            fs.mkdirSync(d, { recursive: true });
        } catch (err) {
            notes.push(`could not create ${path.basename(d)}: ${err.message}`);
        }
    }

    let last = 0;
    const failures = await fetchAll(sftp, files, (done, total, f) => {
        const now = Date.now();
        // At most 4 updates a second: 20000 files must not melt the IPC.
        if (now - last < 250 && done !== total) return;
        last = now;
        onProgress({ phase: 'downloading', files: done, total, name: path.basename(f.local) });
    });

    return {
        files: files.length - failures.length,
        folders: dirs.length,
        bytes: files.reduce((n, f) => n + (f.size || 0), 0),
        skippedLinks: skipped.links,
        skippedUnsafe: skipped.unsafe,
        truncated,
        failures: failures.slice(0, 10),
        failureCount: failures.length,
        notes: notes.slice(0, 10),
    };
}

// --- the other direction: a local folder pushed to the device ---------------
// The mirror of downloadTree, with the trust arrows flipped. The LOCAL tree
// is the user's own disk, so its names need no laundering to be read - but
// symlinks are still never followed (a directory link is how a walk becomes
// infinite, on either side), and a name the SFTP path syntax cannot carry
// cleanly (control bytes, '/') is skipped and counted rather than sent
// mangled. Same caps as the download: a mistaken drop of C:\ must run into
// a wall, not fill a switch's flash.

function remoteComponent(name) {
    const n = String(name == null ? '' : name);
    if (!n || n === '.' || n === '..') return null;
    if (/[/\u0000-\u001f]/.test(n)) return null;
    return n;
}

// Breadth-first over the local filesystem: parents are discovered before
// children, so the mkdir list is already in creation order.
function walkLocal(localRoot, remoteRoot, onNote) {
    const files = [];
    const dirs = [];
    const skipped = { links: 0, unsafe: 0 };
    let truncated = false;
    let readdirs = 0;
    const cleanRoot = remoteRoot.replace(/\/+$/, '');

    const queue = [{ local: localRoot, remote: cleanRoot, depth: 0 }];
    while (queue.length) {
        if (truncated) break;
        const here = queue.shift();
        if (here.depth > MAX_DEPTH) { truncated = true; continue; }
        if (++readdirs > MAX_READDIRS) { truncated = true; break; }
        let names;
        try {
            names = fs.readdirSync(here.local);
        } catch (err) {
            onNote(`skipped ${path.basename(here.local)}: ${err.message}`);
            continue;
        }
        for (const name of names) {
            const localPath = path.join(here.local, name);
            let st;
            try {
                // lstat, not stat: a symlink must be SEEN as one, or a
                // directory link becomes an infinite walk and a file link
                // uploads something outside the folder that was dropped.
                st = fs.lstatSync(localPath);
            } catch (err) {
                onNote(`skipped ${name}: ${err.message}`);
                continue;
            }
            if (st.isSymbolicLink()) { skipped.links++; continue; }
            const clean = remoteComponent(name);
            if (!clean) { skipped.unsafe++; continue; }
            const remote = `${here.remote}/${clean}`;
            if (st.isDirectory()) {
                if (dirs.length >= MAX_DIRS) { truncated = true; continue; }
                dirs.push(remote);
                queue.push({ local: localPath, remote, depth: here.depth + 1 });
            } else if (st.isFile()) {
                if (files.length >= MAX_FILES) { truncated = true; continue; }
                files.push({ local: localPath, remote, size: st.size });
            }
            // Sockets, FIFOs, devices: not files we were asked to copy.
        }
    }
    return { files, dirs, skipped, truncated };
}

const mkdirRemote = (sftp, dir) => new Promise((res, rej) =>
    sftp.mkdir(dir, (e) => (e ? rej(e) : res())));
const statRemote = (sftp, p) => new Promise((res, rej) =>
    sftp.stat(p, (e, a) => (e ? rej(e) : res(a))));

// req: {local, path}. `path` is the remote folder the tree lands AS - the
// caller appends the dropped folder's name, mirroring downloadTree.
async function uploadTree(sftp, req, onProgress) {
    const localRoot = path.resolve(req.local);
    const st = fs.lstatSync(localRoot);
    if (!st.isDirectory()) throw new Error(`${path.basename(localRoot)} is not a folder`);

    const notes = [];
    onProgress({ phase: 'scanning', files: 0, total: 0 });
    const remoteRoot = req.path.replace(/\/+$/, '');
    const { files, dirs, skipped, truncated } =
        walkLocal(localRoot, remoteRoot, (n) => notes.push(n));

    // Directories first, root included, parents before children (the walk
    // is breadth-first). mkdir over an EXISTING directory fails on most
    // servers - re-uploading a tree is routine, so that failure is checked
    // against a stat and forgiven when the directory is really there. Any
    // other failure is noted, and the files beneath it fail per-file the
    // way an unwritable remote file would.
    for (const dir of [remoteRoot, ...dirs]) {
        try {
            await mkdirRemote(sftp, dir);
        } catch (err) {
            let isDir = false;
            try { isDir = ((await statRemote(sftp, dir)).mode & 0xF000) === 0x4000; }
            catch (_) { /* not there at all */ }
            if (!isDir) notes.push(`could not create ${dir}: ${err.message}`);
        }
    }

    // Pooled uploads, each through transfer()'s temp-and-rename - a torn
    // upload must not leave a half-file looking complete on flash, in a
    // tree exactly as much as alone. Lazy require: sftp.js loads this
    // module lazily, so the cycle is safe by the time either runs.
    const { transfer } = require('./sftp');
    let next = 0;
    let done = 0;
    let last = 0;
    const failures = [];
    const worker = async () => {
        for (;;) {
            const i = next++;
            if (i >= files.length) return;
            const f = files[i];
            try {
                await transfer(sftp, 'put', { local: f.local, path: f.remote }, () => {});
            } catch (err) {
                failures.push({ remote: f.remote, error: err.message });
            }
            done++;
            const now = Date.now();
            if (now - last >= 250 || done === files.length) {
                last = now;
                onProgress({ phase: 'uploading', files: done, total: files.length,
                    name: path.basename(f.local) });
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

    return {
        files: files.length - failures.length,
        folders: dirs.length + 1,
        bytes: files.reduce((n, f) => n + (f.size || 0), 0),
        skippedLinks: skipped.links,
        skippedUnsafe: skipped.unsafe,
        truncated,
        failures: failures.slice(0, 10),
        failureCount: failures.length,
        notes: notes.slice(0, 10),
    };
}

module.exports = { downloadTree, uploadTree, walkLocal, remoteComponent,
    safeComponent, localFor, walk, MAX_FILES, MAX_DEPTH, MAX_DIRS, MAX_READDIRS };
