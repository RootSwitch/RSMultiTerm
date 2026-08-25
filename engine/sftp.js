'use strict';
// SFTP operations over an existing SSH session's connection - no second
// login, no separate credentials, exactly what makes the in-app file browser
// worth having. One sftp channel per session, opened lazily on first use and
// cached. Sessions whose server refuses the subsystem report sftp:false and
// the UI never offers the panel.

const fs = require('fs');
const path = require('path');
const scp = require('./scp');

// --- listing metadata -------------------------------------------------------
// The file type nibble of a POSIX mode, as ls prints it.
const FILE_TYPE = {
    0x1000: 'p',   // FIFO
    0x2000: 'c',   // character device
    0x4000: 'd',   // directory
    0x6000: 'b',   // block device
    0x8000: '-',   // regular file
    0xA000: 'l',   // symlink
    0xC000: 's',   // socket
};

// mode -> 'drwxr-xr-x'. setuid/setgid/sticky replace the matching execute
// bit with s/s/t (capitalised when the execute bit itself is clear), which
// is the detail that makes this worth doing properly rather than eyeballing
// four octal digits: `-rwsr-xr-x` on a binary is a finding.
function formatMode(mode) {
    if (typeof mode !== 'number') return '';
    let out = FILE_TYPE[mode & 0xF000] || '?';
    const triples = [
        { r: 0o400, w: 0o200, x: 0o100, special: 0o4000, ch: 's' },   // owner
        { r: 0o040, w: 0o020, x: 0o010, special: 0o2000, ch: 's' },   // group
        { r: 0o004, w: 0o002, x: 0o001, special: 0o1000, ch: 't' },   // other
    ];
    for (const t of triples) {
        out += (mode & t.r) ? 'r' : '-';
        out += (mode & t.w) ? 'w' : '-';
        if (mode & t.special) out += (mode & t.x) ? t.ch : t.ch.toUpperCase();
        else out += (mode & t.x) ? 'x' : '-';
    }
    return out;
}

// SFTP hands back numeric uid/gid; the NAMES only exist in `longname`, the
// server's own `ls -l` line. Parsing it is how every SFTP client shows
// "root" instead of "0". Format is not standardised, so a miss falls back
// to the numbers rather than inventing anything:
//   -rw-r--r--    1 root     wheel        1234 Jan  1 12:00 startup-config
function ownerGroup(longname, attrs) {
    const uid = attrs && typeof attrs.uid === 'number' ? String(attrs.uid) : '';
    const gid = attrs && typeof attrs.gid === 'number' ? String(attrs.gid) : '';
    const m = typeof longname === 'string'
        ? /^[dlbcps-][rwxsStT-]{9}[.+]?\s+\d+\s+(\S+)\s+(\S+)\s/.exec(longname) : null;
    return { owner: (m && m[1]) || uid, group: (m && m[2]) || gid };
}

const channels = new Map();   // sessionId -> sftp stream
// sessionId -> 'sftp' | 'scp'. Decided once per session, on first use.
const mode = new Map();

function forSession(session) {
    return new Promise((resolve, reject) => {
        const cached = channels.get(session.id);
        if (cached) return resolve(cached);
        const transport = session.transport;
        if (!transport.sftp) return reject(new Error('not an SSH session'));
        // Opening a channel before the handshake finishes writes a
        // channel-open into the middle of key exchange: the server sees a bad
        // packet length and drops the connection. That is what made a
        // reconnect fail while the file browser was open - it rebound and
        // probed the new session the instant it existed.
        if (transport.state !== 'connected') {
            return reject(new Error('the session is still connecting'));
        }
        transport.sftp((err, sftp) => {
            if (err) return reject(new Error(`SFTP unavailable: ${err.message}`));
            channels.set(session.id, sftp);
            sftp.on('close', () => channels.delete(session.id));
            resolve(sftp);
        });
    });
}

function drop(sessionId) {
    channels.delete(sessionId);
    mode.delete(sessionId);
}

// Which file protocol this device will actually do. SFTP is tried first
// because it can list directories; SCP cannot, which is why it is a fallback
// and not an equal - with SCP the panel becomes a transfer form, not a
// browser.
async function resolveMode(session) {
    const cached = mode.get(session.id);
    if (cached) return cached;
    // Not connected yet: answer without touching the client, and do not
    // cache - the answer would be wrong for the session once it is up.
    if (session.transport.state !== 'connected') return 'pending';
    try {
        await forSession(session);
        mode.set(session.id, 'sftp');
        return 'sftp';
    } catch (_) {
        const client = session.transport && session.transport._client;
        if (client && await scp.probe(client)) {
            mode.set(session.id, 'scp');
            return 'scp';
        }
        mode.set(session.id, 'none');
        return 'none';
    }
}

// op dispatch: {op, path, from, to, local} -> result object
async function run(session, req, onProgress) {
    const how = await resolveMode(session);
    if (how === 'pending') {
        if (req.op === 'mode') return { mode: 'pending' };
        throw new Error('the session is still connecting');
    }
    if (how === 'none') {
        throw new Error('this device offers neither SFTP nor SCP');
    }
    if (how === 'scp') {
        const client = session.transport._client;
        switch (req.op) {
            case 'mode':
                return { mode: 'scp' };
            case 'realpath':
                // SCP has no notion of a working directory, so the panel
                // shows the path the user types and nothing else.
                return { path: req.path === '.' ? '/' : req.path };
            case 'list':
                // Not a limitation worth hiding behind an empty list.
                throw new Error('SCP cannot list directories - type a full path to download, or upload a file');
            case 'download':
                return scp.download(client, req.path, req.local, onProgress);
            case 'downloadTree':
                // SCP here is the fallback for devices with no SFTP at all -
                // switches, mostly - and it cannot even list a directory,
                // let alone walk one.
                throw new Error('SCP cannot download folders - it cannot list them');
            case 'upload':
                return scp.upload(client, req.local, req.path, onProgress);
            default:
                throw new Error(`SCP cannot ${req.op}`);
        }
    }

    const sftp = await forSession(session);
    switch (req.op) {
        case 'mode':
            return { mode: 'sftp' };
        case 'realpath':
            return new Promise((res, rej) => sftp.realpath(req.path || '.', (e, p) => e ? rej(e) : res({ path: p })));
        case 'list':
            return new Promise((res, rej) => sftp.readdir(req.path, (e, list) => {
                if (e) return rej(e);
                res({
                    entries: list.map((it) => {
                        const og = ownerGroup(it.longname, it.attrs);
                        return {
                            name: it.filename,
                            size: it.attrs.size,
                            mtime: it.attrs.mtime ? it.attrs.mtime * 1000 : null,
                            isDir: (it.attrs.mode & 0xF000) === 0x4000,
                            isLink: (it.attrs.mode & 0xF000) === 0xA000,
                            mode: it.attrs.mode,
                            perms: formatMode(it.attrs.mode),
                            owner: og.owner,
                            group: og.group,
                        };
                    }),
                });
            }));
        case 'download':
            return transfer(sftp, 'get', req, onProgress);
        // A whole folder, walked and fetched here rather than one round trip
        // per file from the renderer. See engine/sftp-tree.js.
        case 'downloadTree':
            return require('./sftp-tree').downloadTree(sftp, req, onProgress);
        case 'upload':
            return transfer(sftp, 'put', req, onProgress);
        case 'mkdir':
            return new Promise((res, rej) => sftp.mkdir(req.path, (e) => e ? rej(e) : res({})));
        case 'rmdir':
            return new Promise((res, rej) => sftp.rmdir(req.path, (e) => e ? rej(e) : res({})));
        case 'delete':
            return new Promise((res, rej) => sftp.unlink(req.path, (e) => e ? rej(e) : res({})));
        case 'rename':
            return new Promise((res, rej) => sftp.rename(req.from, req.to, (e) => e ? rej(e) : res({})));
        default:
            throw new Error(`unknown sftp op: ${req.op}`);
    }
}

function transfer(sftp, dir, req, onProgress) {
    return new Promise((resolve, reject) => {
        let total = 0;
        try {
            if (dir === 'put') total = fs.statSync(req.local).size;
        } catch (e) { return reject(e); }

        // Progress at most 4/s - a 10 GB transfer must not melt the IPC.
        let last = 0;
        const step = (transferred, _chunk, totalBytes) => {
            const now = Date.now();
            if (now - last < 250) return;
            last = now;
            onProgress({ bytes: transferred, total: totalBytes || total });
        };

        const done = (err) => {
            if (!err) return resolve({ ok: true });
            // A truncated startup-config that LOOKS complete is dangerous in
            // this domain; a failed download must not leave one behind.
            if (dir === 'get') {
                try { fs.unlinkSync(req.local); } catch (_) { /* never written */ }
            }
            reject(err);
        };
        if (dir === 'get') sftp.fastGet(req.path, req.local, { step }, done);
        else sftp.fastPut(req.local, req.path, { step }, done);
    });
}

module.exports = { run, forSession, drop, resolveMode, formatMode, ownerGroup };
