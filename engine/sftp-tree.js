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
const CONCURRENCY = 6;

// One path component, made safe to put on a local filesystem. Same rules as
// the renderer's localName, applied to every level of the tree instead of
// just the leaf: null means "this name cannot be written safely".
function safeComponent(name) {
    const last = String(name == null ? '' : name).split(/[/\\]/).pop();
    if (!last || last === '.' || last === '..' || last.includes(':')) return null;
    // Win32 strips trailing dots and spaces when creating the file, so
    // 'evil.exe. ' and 'evil.exe' are the same file - and that is also how
    // '..' would sneak past the check above as '.. '.
    const trimmed = last.replace(/[. ]+$/, '');
    if (!trimmed || trimmed === '.' || trimmed === '..') return null;
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

    const queue = [{ remote: remoteRoot, parts: [] }];
    while (queue.length) {
        const here = queue.shift();
        if (here.parts.length > MAX_DEPTH) { truncated = true; continue; }
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
            const remote = `${here.remote.replace(/\/+$/, '')}/${it.filename}`;
            if (isDir) {
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
            try {
                await new Promise((res, rej) =>
                    sftp.fastGet(f.remote, f.local, {}, (e) => (e ? rej(e) : res())));
            } catch (err) {
                // A half-written file is worse than a missing one: a
                // truncated config that looks complete is the failure mode
                // this whole app is careful about.
                try { fs.unlinkSync(f.local); } catch (_) { /* never created */ }
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
    if (!fs.existsSync(localRoot)) throw new Error(`${localRoot} does not exist`);

    const notes = [];
    onProgress({ phase: 'scanning', files: 0, total: 0 });
    const { files, dirs, skipped, truncated } =
        await walk(sftp, req.path, localRoot, (n) => notes.push(n));

    for (const d of dirs) fs.mkdirSync(d, { recursive: true });

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

module.exports = { downloadTree, safeComponent, localFor, walk, MAX_FILES, MAX_DEPTH };
