'use strict';
// A directory listing for devices that offer SCP but no SFTP - and that have
// a shell behind SSH. OpenWrt/LEDE (BusyBox, Dropbear) is the usual one: a
// QNAP switch running it has scp and ls but no sftp-server, and without a
// listing the file panel was a type-the-path form. This is what MobaXterm's
// "SSH browser (SCP)" does: run ls over an exec channel and read the text.
//
// READ-ONLY, and that is the contract: the only commands this module ever
// sends are `pwd` and `ls`. No mkdir, rm or mv - SCP mode does not create,
// rename or delete anything on a device, and tools/test-scp-list.js holds
// the fixture to the exact strings below.
//
// Not every SCP device has a shell. Classic Cisco IOS answers exec with its
// own CLI, where `ls` is an invalid command - and with command accounting,
// one that is logged. So gear whose SSH banner says Cisco is never asked;
// everything else is asked `pwd` once, and a device that does not answer
// with an absolute path keeps the type-the-path form it had.
//
// The listing is DEVICE-CONTROLLED text. Nothing here trusts it: lines that
// are not an ls -l row are counted and dropped, a name with a slash in it
// is dropped (a listing of a directory has none), and the rows go to the
// same panel code that already treats SFTP names as hostile.

const { quote } = require('./scp');

// The locale is pinned so the date is "Nov 13 21:05" / "May 20  2024" on
// GNU, BusyBox and uutils alike (toybox prints ISO dates regardless, which
// the parser also takes). -a so dotfiles show, as they do over SFTP.
const PWD_CMD = 'pwd';
function lsCommand(dir, follow) {
    return `LC_ALL=C ls -la${follow ? 'L' : ''} ${quote(dirArg(dir))}`;
}

// ls -l of a symlink to a directory lists the LINK; with a trailing slash
// it lists what the link points at, which is what opening /var on OpenWrt
// (-> /tmp) has to mean.
function dirArg(dir) {
    const p = String(dir || '');
    if (!p.startsWith('/')) throw new Error('type a full path, starting with /');
    return p.replace(/\/+$/, '') + '/';
}

const MAX_OUTPUT = 8 * 1024 * 1024;   // ~60,000 rows; more is not a browser
const TIMEOUT_MS = 15000;

// One command over its own exec channel on the session's connection.
// Resolves {code, stdout, stderr}; rejects on a channel error, a timeout or
// output past the cap.
function run(client, command) {
    return new Promise((resolve, reject) => {
        client.exec(command, (err, stream) => {
            if (err) return reject(err);
            const out = [];
            const errOut = [];
            let size = 0;
            let settled = false;
            const finish = (fn, v) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn(v);
            };
            const timer = setTimeout(() => {
                try { stream.close(); } catch (_) { /* closing */ }
                finish(reject, new Error('the device did not answer in time'));
            }, TIMEOUT_MS);
            if (timer.unref) timer.unref();
            const take = (list) => (d) => {
                size += d.length;
                if (size > MAX_OUTPUT) {
                    try { stream.close(); } catch (_) { /* closing */ }
                    return finish(reject, new Error('that folder is too large to list'));
                }
                list.push(d);
            };
            stream.on('data', take(out));
            stream.stderr.on('data', take(errOut));
            stream.on('error', (e) => finish(reject, e));
            stream.on('close', (code) => finish(resolve, {
                code: typeof code === 'number' ? code : null,
                stdout: Buffer.concat(out).toString('utf8'),
                stderr: Buffer.concat(errOut).toString('utf8'),
            }));
            // Nothing to send: without this some servers wait on stdin.
            stream.end();
        });
    });
}

// Gear that cannot have a POSIX shell behind exec, by its SSH software
// version (ssh2's client._remoteVer: "Cisco-1.25", "dropbear_2017.75").
function mayHaveShell(remoteVer) {
    return !/cisco/i.test(String(remoteVer || ''));
}

// The directory exec starts in, or null when the device is not a shell: the
// answer has to be exactly one absolute path.
async function home(client) {
    const r = await run(client, PWD_CMD);
    const lines = r.stdout.split(/\r?\n/).filter((l) => l.length);
    if (r.code !== 0 || lines.length !== 1) return null;
    const p = lines[0];
    if (!p.startsWith('/') || /[\x00-\x1f\x7f]/.test(p) || p.length > 4096) return null;
    return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

const MONTH = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// One ls -l row:
//   drwxr-xr-x    1 root     root             0 May 20  2024 etc        BusyBox
//   -rw-r--r-- 1 user user 183000 Nov 15 00:08 name with spaces.cfg     GNU, uutils
//   crw-rw-rw-    1 root     root        1,   3 Jan  1  1970 null       a device: major, minor
//   -rw-r--r-- 1 root root 12 2024-05-20 00:00 notes                    toybox
// Owner and group are taken together and split afterwards: the size and the
// date are what can be recognized, so they anchor the row.
const ROW = new RegExp('^([bcdlps-])([rwxsStT-]{9})[.+@]?\\s+(\\d+)\\s+(.+?)\\s+' +
    '(\\d+(?:,\\s*\\d+)?)\\s+' +
    '([A-Z][a-z]{2}\\s+\\d{1,2}\\s+(?:\\d{4}|\\d{1,2}:\\d{2})|' +
    '\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}(?::\\d{2})?)\\s(.*)$');

const TYPE_BITS = { '-': 0x8000, d: 0x4000, l: 0xA000, b: 0x6000, c: 0x2000, p: 0x1000, s: 0xC000 };

// 'rwsr-xr-x' -> 0o4755. The type nibble comes from the first column.
function modeOf(type, perms) {
    let mode = TYPE_BITS[type] || 0;
    const bit = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
    const special = { 2: 0o4000, 5: 0o2000, 8: 0o1000 };
    for (let i = 0; i < 9; i++) {
        const ch = perms[i];
        if (ch === '-') continue;
        if (i % 3 === 2 && 'sStT'.includes(ch)) {
            mode |= special[i];
            if (ch === 's' || ch === 't') mode |= bit[i];
        } else {
            mode |= bit[i];
        }
    }
    return mode;
}

// The date column, as local time: what the panel then shows is what the
// device printed. A row with a time of day carries no year - ls prints
// those for the last six months - so it is this year, or last year when
// that would put it in the future.
function parseDate(text, now) {
    let m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
    if (m) {
        return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
    }
    m = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(?:(\d{4})|(\d{1,2}):(\d{2}))$/.exec(text);
    if (!m || !(m[1] in MONTH)) return null;
    if (m[3]) return new Date(+m[3], MONTH[m[1]], +m[2]).getTime();
    const year = new Date(now).getFullYear();
    let t = new Date(year, MONTH[m[1]], +m[2], +m[4], +m[5]).getTime();
    if (t > now + 24 * 3600 * 1000) t = new Date(year - 1, MONTH[m[1]], +m[2], +m[4], +m[5]).getTime();
    return t;
}

// ls -la output -> {entries, skipped, sawDot}. entries have the shape the
// SFTP listing returns, so the panel draws both the same way. skipped
// counts lines that were not a row (so nothing is dropped without a word);
// sawDot says a '.' row was there, which is what makes an empty folder a
// listing rather than nothing.
function parse(text, now = Date.now()) {
    const entries = [];
    let skipped = 0;
    let sawDot = false;
    for (const line of String(text).split(/\r?\n/)) {
        if (!line.trim() || /^total \d+/.test(line)) continue;
        const m = ROW.exec(line);
        if (!m) { skipped++; continue; }
        const type = m[1];
        let name = m[7];
        let target = null;
        if (type === 'l') {
            const at = name.indexOf(' -> ');
            if (at !== -1) { target = name.slice(at + 4); name = name.slice(0, at); }
        }
        if (name === '.') { sawDot = true; continue; }
        if (name === '..') continue;
        // A directory's listing holds bare names. Anything with a slash, or
        // nothing at all, is not one this panel should offer to act on.
        if (!name || name.includes('/')) { skipped++; continue; }
        const ids = m[4].split(/\s+/);
        entries.push({
            name,
            size: m[5].includes(',') ? null : Number(m[5]),
            mtime: parseDate(m[6].trim(), now),
            isDir: type === 'd',
            isLink: type === 'l',
            mode: modeOf(type, m[2]),
            perms: type + m[2],
            owner: ids[0] || '',
            group: ids.slice(1).join(' '),
            ...(target !== null ? { target } : {}),
        });
    }
    return { entries, skipped, sawDot };
}

// The reason out of ls's own complaint: "ls: /nope/: No such file or
// directory" -> "No such file or directory". Device text, so it is held to
// one plain line.
function reason(stderr) {
    const first = String(stderr || '').split(/\r?\n/).find((l) => l.trim()) || '';
    const clean = first.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200);
    const known = /(No such file or directory|Permission denied|Not a directory)/i.exec(clean);
    return known ? known[1] : clean;
}

// List one directory. Resolves {entries, skipped}. Rejects with a message
// for the panel; err.notAListing marks an answer that was not ls at all
// (as opposed to ls refusing THIS path), which is how the caller tells a
// device with no shell from a folder it may not read.
async function list(client, dir) {
    const r = await run(client, lsCommand(dir, false));
    const parsed = parse(r.stdout);
    const isListing = parsed.sawDot || parsed.entries.length > 0;
    if (!isListing) {
        const why = reason(r.stderr) || reason(r.stdout);
        const lsSpoke = /^ls: /m.test(r.stderr) ||
            /No such file or directory|Permission denied|Not a directory/i.test(r.stderr);
        const err = new Error(lsSpoke && why ? `cannot list ${dir}: ${why}`
            : 'this device did not answer ls with a listing');
        err.notAListing = !lsSpoke;
        throw err;
    }
    // Which symlinks lead to folders: ls -L shows each entry as what it
    // points at. Only asked when there are links, and a refusal (an ls with
    // no -L, a dangling link's nonzero exit) just leaves them as files.
    if (parsed.entries.some((e) => e.isLink)) {
        try {
            const followed = parse((await run(client, lsCommand(dir, true))).stdout);
            const dirs = new Set(followed.entries.filter((e) => e.isDir).map((e) => e.name));
            for (const e of parsed.entries) if (e.isLink && dirs.has(e.name)) e.isDir = true;
        } catch (_) { /* links stay as files */ }
    }
    return { entries: parsed.entries, skipped: parsed.skipped };
}

module.exports = { list, home, parse, mayHaveShell, lsCommand, dirArg, PWD_CMD };
