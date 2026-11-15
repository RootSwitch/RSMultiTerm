'use strict';
// The read-only file browser for SCP-only devices that have a shell
// (OpenWrt/LEDE: BusyBox + Dropbear, scp and ls but no sftp-server).
//
//   1. THE PARSER reads ls -l rows as BusyBox, GNU/uutils and toybox print
//      them, and trusts none of it: lines that are not rows are counted, a
//      name with a slash is dropped, '.' and '..' never become entries.
//   2. THE COMMANDS are exactly `pwd` and `LC_ALL=C ls -la[L] '<dir>/'`,
//      shell-quoted, absolute paths only.
//   3. THE ENGINE, through the real op dispatch against fixture devices:
//      a BusyBox-style device opens in its home, lists, follows a symlink
//      to a folder, reports ls's own reason for a folder it cannot list,
//      and still transfers by SCP.
//   4. READ-ONLY. Every exec command the device received is logged by the
//      fixture: nothing but scp, pwd and ls ever arrives, pwd once per
//      session, and mkdir/rename/delete are refused without sending
//      anything.
//   5. NOT EVERY DEVICE IS ASKED. Gear announcing itself as Cisco is never
//      sent pwd or ls. A device with no shell is asked pwd once and keeps
//      the transfer form; so does one where pwd answers but ls is not ls.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('ssh2');

const scpList = require('../engine/scp-list');
const files = require('../engine/sftp');

let failures = 0;
function check(name, cond, detail) {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
    if (!cond) failures++;
}

// --- 1. the parser ----------------------------------------------------------

// The root of an OpenWrt device, in BusyBox 1.25's layout. CONSTRUCTED from
// ls.c's printf formats ("%-10s ", "%4lu ", "%-8.8s %-8.8s", "%9llu ", then
// "Mon DD HH:MM " or "Mon DD  YYYY ") - not a capture: there was no BusyBox
// to capture from when this was written.
const BUSYBOX = [
    'drwxr-xr-x    1 root     root             0 May 20  2024 .',
    'drwxr-xr-x    1 root     root             0 May 20  2024 ..',
    'drwxr-xr-x    2 root     root             0 Nov 13 21:05 admin',
    'drwxr-xr-x    2 root     root           843 May 20  2024 bin',
    'drwxr-xr-x    7 root     root          1340 Nov 13 21:04 dev',
    'drwxr-xr-x    1 root     root             0 Nov 13 21:05 etc',
    'drwxr-xr-x    1 root     root             0 May 10  2024 overlay',
    'dr-xr-xr-x   95 root     root             0 Jan  1  1970 proc',
    'drwxrwxrwt   14 root     root           420 Nov 15 00:02 tmp',
    'lrwxrwxrwx    1 root     root             4 May 20  2024 var -> /tmp',
    '-rw-r--r--    1 root     root        178904 May 20  2024 firmware_0_2_8.hdr',
    'crw-rw-rw-    1 root     root        1,   3 Jan  1  1970 null',
    'brw-------    1 root     root       31,   0 Jan  1  1970 mtdblock0',
].join('\n');

// REAL: uutils coreutils 0.8.0 `LC_ALL=C ls -la` under WSL, 2026-11-15, of a
// throwaway folder (GNU's layout). Kept byte for byte.
const UUTILS = [
    'total 196',
    'drwx------ 4 user user    240 Nov 15 00:13 .',
    'drwxrwxrwt 7 root root    140 Nov 15 00:13 ..',
    '-rw-r--r-- 1 user user      1 Dec 31  1969 .hidden',
    '-rw-r--r-- 1 user user      1 Nov 15 00:13 arrow -> inside.txt',
    'lrwxrwxrwx 1 user user     19 Nov 15 00:13 broken-link -> /nonexistent/target',
    'drwxr-xr-x 2 user user     60 May 19  2024 configs',
    'drwxrwxrwt 2 user user     40 Nov 15 00:13 dir with spaces',
    '-rw-r--r-- 1 user user 183000 May 19  2024 firmware_0_3_7.hdr',
    'lrwxrwxrwx 1 user user      7 Nov 15 00:13 link-to-dir -> configs',
    'lrwxrwxrwx 1 user user      9 Nov 15 00:13 link-to-file -> plain.txt',
    '-rw-r--r-- 1 user user      1 Nov 15 00:13 name with spaces.cfg',
    '-rwsr-xr-x 1 user user      1 Nov 15 00:13 plain.txt',
].join('\n');

const NOW = new Date(2026, 10, 15, 12, 0).getTime();   // 15 Nov 2026, local noon
const local = (ms) => {
    const d = new Date(ms);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

console.log('parser: BusyBox layout');
{
    const r = scpList.parse(BUSYBOX, NOW);
    const by = Object.fromEntries(r.entries.map((e) => [e.name, e]));
    check('every row is read', r.skipped === 0 && r.entries.length === 11, `${r.entries.length} entries, ${r.skipped} skipped`);
    check('. and .. are not entries, and . was seen', !by['.'] && !by['..'] && r.sawDot === true);
    check('folders are folders', ['admin', 'bin', 'dev', 'etc', 'overlay', 'proc', 'tmp'].every((n) => by[n] && by[n].isDir));
    check('a file has its size', by['firmware_0_2_8.hdr'] && by['firmware_0_2_8.hdr'].size === 178904 && !by['firmware_0_2_8.hdr'].isDir);
    check('a link has its name, its target, and is not yet a folder',
        by.var && by.var.isLink && by.var.target === '/tmp' && by.var.isDir === false, JSON.stringify(by.var));
    check('owner and group', by.bin.owner === 'root' && by.bin.group === 'root');
    check('perms and mode', by.tmp.perms === 'drwxrwxrwt' && (by.tmp.mode & 0o7777) === 0o1777 &&
        (by.proc.mode & 0o7777) === 0o555, by.tmp.perms + ' ' + (by.tmp.mode & 0o7777).toString(8));
    check('a device node has no size', by.null && by.null.size === null && by.mtdblock0.size === null);
    check('a date with a year is that day', local(by.bin.mtime) === '2024-05-20 00:00', local(by.bin.mtime));
    check('a date with a time is this year', local(by.admin.mtime) === '2026-11-13 21:05', local(by.admin.mtime));
    check('1970 stays 1970', local(by.proc.mtime) === '1970-01-01 00:00', local(by.proc.mtime));
    // A time-of-day date that would be in the future belongs to last year.
    const dec = scpList.parse('-rw-r--r--    1 root     root            10 Dec 24 09:30 old.log', NOW).entries[0];
    check('a time-of-day date ahead of today is last year', local(dec.mtime) === '2025-12-24 09:30', local(dec.mtime));
}

console.log('parser: a real GNU-layout listing (uutils, WSL)');
{
    const r = scpList.parse(UUTILS, NOW);
    const by = Object.fromEntries(r.entries.map((e) => [e.name, e]));
    check('every row is read, total is not a row', r.skipped === 0 && r.entries.length === 10, `${r.entries.length} entries, ${r.skipped} skipped`);
    check('names keep their spaces', !!by['name with spaces.cfg'] && by['dir with spaces'].isDir);
    check('a FILE whose name holds " -> " keeps its whole name',
        !!by['arrow -> inside.txt'] && !by['arrow -> inside.txt'].isLink);
    check('links split into name and target', by['link-to-dir'].target === 'configs' &&
        by['broken-link'].target === '/nonexistent/target');
    check('setuid reads as 4755', (by['plain.txt'].mode & 0o7777) === 0o4755, (by['plain.txt'].mode & 0o7777).toString(8));
    check('a dotfile is listed', !!by['.hidden']);
}

console.log('parser: other layouts, and text that is not a listing');
{
    const toy = scpList.parse('-rw-r--r-- 1 root root 12 2024-05-20 13:45 notes.txt', NOW).entries[0];
    check('toybox ISO dates', toy && toy.name === 'notes.txt' && local(toy.mtime) === '2024-05-20 13:45', toy && local(toy.mtime));
    const acl = scpList.parse('-rw-r--r--+ 1 root root 5 May 20  2024 acl.txt\n-rw-r--r--. 1 root root 5 May 20  2024 se.txt', NOW);
    check('ACL and SELinux marks after the perms', acl.entries.length === 2 && acl.skipped === 0);
    const ids = scpList.parse('-rw-r--r--    1 0        0             1234 May 20  2024 f', NOW).entries[0];
    check('numeric owner and group', ids && ids.owner === '0' && ids.group === '0' && ids.size === 1234, JSON.stringify(ids));
    const lead = scpList.parse('-rw-r--r-- 1 root root 5 Nov 15 00:08  leading-space', NOW).entries[0];
    check('a name that starts with a space keeps it', lead && lead.name === ' leading-space', JSON.stringify(lead && lead.name));

    const hostile = scpList.parse([
        '% Invalid input detected at \'^\' marker.',
        '-rw-r--r-- 1 root root 5 May 20  2024 ../../../etc/passwd',
        '-rw-r--r-- 1 root root 5 May 20  2024 /abs/path',
        '-rw-r--r-- 1 root root 5 May 20  2024 ..',
        'l????????? ? ?    ?         ?            ? broken-link',
        '-rw-r--r-- 1 root root 5 May 20  2024 fine.txt',
    ].join('\n'), NOW);
    check('names with a slash are dropped', hostile.entries.length === 1 && hostile.entries[0].name === 'fine.txt',
        hostile.entries.map((e) => e.name).join());
    check('and everything dropped is counted', hostile.skipped === 4, hostile.skipped);
    check('.. is never an entry', !hostile.entries.some((e) => e.name === '..'));
    const junk = scpList.parse('Line has invalid autocommand "ls"\r\n', NOW);
    check('text that is not ls yields nothing, no dot', junk.entries.length === 0 && junk.sawDot === false && junk.skipped === 1);
}

// --- 2. the commands --------------------------------------------------------
console.log('commands');
{
    check('pwd is pwd', scpList.PWD_CMD === 'pwd');
    check('ls of a folder', scpList.lsCommand('/admin') === "LC_ALL=C ls -la '/admin/'", scpList.lsCommand('/admin'));
    check('ls following links', scpList.lsCommand('/', true) === "LC_ALL=C ls -laL '/'", scpList.lsCommand('/', true));
    check('a trailing slash is not doubled', scpList.lsCommand('/var/') === "LC_ALL=C ls -la '/var/'");
    check('a quote in a path cannot end the quoting',
        scpList.lsCommand("/it's; rm -rf x") === "LC_ALL=C ls -la '/it'\\''s; rm -rf x/'", scpList.lsCommand("/it's; rm -rf x"));
    let threw = null;
    try { scpList.lsCommand('etc'); } catch (e) { threw = e.message; }
    check('a relative path is refused', /full path/.test(threw || ''), threw);
    check('Cisco gear is not a shell', scpList.mayHaveShell('Cisco-1.25') === false &&
        scpList.mayHaveShell('dropbear_2017.75') === true && scpList.mayHaveShell(undefined) === true);
}

// --- 3-5. the engine, against fixture devices -------------------------------

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-scpls-'));

function startDevice(port, name, env) {
    const execLog = path.join(work, `exec-${port}.log`);
    fs.writeFileSync(execLog, '');
    const proc = spawn(process.execPath, [path.join(__dirname, 'test-ssh-server.js'), String(port), name], {
        env: { ...process.env, RSMT_FIXTURE_NO_SFTP: '1', RSMT_FIXTURE_EXECLOG: execLog, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Promise((resolve, reject) => {
        let buf = '';
        proc.stdout.on('data', (d) => {
            buf += d.toString();
            const m = /sftp root (.+)$/m.exec(buf);
            if (m) resolve({ proc, root: m[1].trim(), port,
                sent: () => fs.readFileSync(execLog, 'utf8').split('\n').filter(Boolean) });
        });
        proc.stderr.on('data', (d) => reject(new Error(d.toString())));
        setTimeout(() => reject(new Error('fixture did not start')), 8000);
    });
}

function connect(port) {
    return new Promise((resolve, reject) => {
        const c = new Client();
        c.on('ready', () => resolve(c));
        c.on('error', reject);
        c.connect({ host: '127.0.0.1', port, username: 'nettest', password: 'nettest', readyTimeout: 8000 });
    });
}

// What the engine's dispatch needs of a session.
let nextId = 1;
function sessionOn(client) {
    return { id: `t${nextId++}`, transport: { state: 'connected', sftp: (cb) => client.sftp(cb), _client: client } };
}
const op = (session, req) => files.run(session, req, () => {});
const rejects = async (p) => { try { await p; return null; } catch (e) { return e.message; } };

// A device answering one command, for home(): the exec channel yields the
// given stdout and exit code. No network - this is about what counts as an
// answer, which decides whether a device is ever sent ls.
function answering(stdout, code) {
    const { EventEmitter } = require('events');
    const seen = [];
    return {
        seen,
        exec(cmd, cb) {
            seen.push(cmd);
            const stream = new EventEmitter();
            stream.stderr = new EventEmitter();
            stream.end = () => {};
            stream.close = () => {};
            cb(null, stream);
            setImmediate(() => {
                if (stdout) stream.emit('data', Buffer.from(stdout));
                stream.emit('close', code);
            });
        },
    };
}

(async () => {
    const devices = [];
    const clients = [];

    console.log('what counts as a shell: the answer to pwd');
    {
        const ask = async (stdout, code) => scpList.home(answering(stdout, code));
        check('one absolute path, clean exit', await ask('/admin\n', 0) === '/admin');
        check('the root is the root', await ask('/\n', 0) === '/');
        check('a trailing slash is trimmed', await ask('/admin/\r\n', 0) === '/admin');
        check('a path after a banner line is not an answer', await ask('Welcome to the CLI\n/admin\n', 0) === null);
        check('two lines are not an answer', await ask('/admin\n/tmp\n', 0) === null);
        check('a path with a failing exit code is not an answer', await ask('/admin\n', 1) === null);
        check('an IOS-style pwd is not an answer', await ask('flash:/\n', 0) === null);
        check('an error line is not an answer', await ask('% Invalid input detected\n', 0) === null);
        check('a control character in the path is not an answer', await ask('/ad\x1b[2Jmin\n', 0) === null);
        check('silence is not an answer', await ask('', 0) === null);
        const one = answering('/admin\n', 0);
        await scpList.home(one);
        check('and asking sends exactly pwd', one.seen.length === 1 && one.seen[0] === 'pwd', one.seen.join(' | '));
    }

    try {
        console.log('engine: a BusyBox-style device (SCP, a shell, home /configs)');
        const wrt = await startDevice(2291, 'wrt-sw-01', { RSMT_FIXTURE_SHELL: '/configs' });
        devices.push(wrt);
        const c1 = await connect(wrt.port);
        clients.push(c1);
        const s1 = sessionOn(c1);

        check('it is an SCP device', (await op(s1, { op: 'mode' })).mode === 'scp');
        const homeDir = (await op(s1, { op: 'realpath', path: '.' })).path;
        check('the browser opens in its home', homeDir === '/configs', homeDir);

        const home = await op(s1, { op: 'list', path: homeDir });
        check('home lists', Array.isArray(home.entries) && home.entries.some((e) => e.name === 'startup-config' && e.size > 0),
            JSON.stringify((home.entries || []).map((e) => e.name)));

        const root = await op(s1, { op: 'list', path: '/' });
        const by = Object.fromEntries(root.entries.map((e) => [e.name, e]));
        check('the root lists folders, files and dotfiles',
            by.configs && by.configs.isDir && by['vlan.dat'] && by['vlan.dat'].size === 1024 && !!by['.bootlog'],
            Object.keys(by).join());
        check('nothing was skipped', root.skipped === 0, root.skipped);
        check('a link to a folder is a link AND a folder', by.latest && by.latest.isLink && by.latest.isDir === true &&
            by.latest.target === 'configs', JSON.stringify(by.latest));
        const via = await op(s1, { op: 'list', path: '/latest' });
        check('and opens onto what it points at', via.entries.some((e) => e.name === 'startup-config'),
            via.entries.map((e) => e.name).join());

        const missing = await rejects(op(s1, { op: 'list', path: '/nope' }));
        check('a missing folder says so, in ls\'s words', /cannot list \/nope: No such file or directory/.test(missing || ''), missing);
        const notDir = await rejects(op(s1, { op: 'list', path: '/vlan.dat' }));
        check('a file is not a folder', /Not a directory/.test(notDir || ''), notDir);
        const relative = await rejects(op(s1, { op: 'list', path: 'configs' }));
        check('a relative path is refused before anything is sent', /full path/.test(relative || ''), relative);
        const after = await op(s1, { op: 'list', path: '/configs' });
        check('one refused folder does not end the browsing', after.entries.length > 0 && !after.unsupported);

        // Transfers are still SCP, into and out of what was listed.
        const got = path.join(work, 'startup-config');
        await op(s1, { op: 'download', path: '/configs/startup-config', local: got });
        check('a listed file downloads by SCP', fs.readFileSync(got, 'utf8').includes('hostname core-sw-01'));
        const push = path.join(work, 'new-acl.txt');
        fs.writeFileSync(push, 'ip access-list standard MGMT\n');
        await op(s1, { op: 'upload', local: push, path: '/configs/new-acl.txt' });
        const relisted = await op(s1, { op: 'list', path: '/configs' });
        check('an upload shows up in the next listing', relisted.entries.some((e) => e.name === 'new-acl.txt' && e.size === 29),
            relisted.entries.map((e) => `${e.name}:${e.size}`).join());

        console.log('read-only');
        const before = wrt.sent().length;
        for (const req of [{ op: 'mkdir', path: '/configs/x' }, { op: 'rmdir', path: '/configs' },
            { op: 'delete', path: '/vlan.dat' }, { op: 'rename', from: '/vlan.dat', to: '/v2' },
            { op: 'chmod', path: '/vlan.dat', mode: 0o600 }]) {
            const why = await rejects(op(s1, req));
            check(`${req.op} is refused`, /SCP cannot/.test(why || ''), why);
        }
        check('and none of them sent the device anything', wrt.sent().length === before, wrt.sent().slice(before).join(' | '));
        check('vlan.dat is still there', fs.existsSync(path.join(wrt.root, 'vlan.dat')));
        const sent = wrt.sent();
        // scp -f/-t (the probe's path is unquoted), pwd, and the two ls forms.
        const allowed = (cmd) => /^scp -[ft] /.test(cmd) || cmd === 'pwd' || /^LC_ALL=C ls -laL? '.*'$/.test(cmd);
        check('the device was only ever sent scp, pwd and ls', sent.every(allowed), sent.filter((c) => !allowed(c)).join(' | '));
        check('pwd was asked once for the whole session', sent.filter((c) => c === 'pwd').length === 1,
            sent.filter((c) => c === 'pwd').length);
        check('ls -L only where there were links', sent.filter((c) => /ls -laL/.test(c)).length === 1 &&
            sent.some((c) => c === "LC_ALL=C ls -laL '/'"), sent.filter((c) => /ls -laL/.test(c)).join(' | '));
        files.drop(s1.id);

        console.log('devices that are not asked, or cannot answer');
        const cisco = await startDevice(2292, 'ios-sw-01', { RSMT_FIXTURE_SHELL: '/configs', RSMT_FIXTURE_IDENT: 'Cisco-1.25' });
        devices.push(cisco);
        const c2 = await connect(cisco.port);
        clients.push(c2);
        const s2 = sessionOn(c2);
        check('Cisco gear: SCP mode', (await op(s2, { op: 'mode' })).mode === 'scp');
        check('Cisco gear: opens at /', (await op(s2, { op: 'realpath', path: '.' })).path === '/');
        check('Cisco gear: no listing', (await op(s2, { op: 'list', path: '/' })).unsupported === true);
        check('Cisco gear: never sent pwd or ls, even with a shell there',
            !cisco.sent().some((c) => c === 'pwd' || /\bls\b/.test(c)), cisco.sent().join(' | '));
        files.drop(s2.id);

        const bare = await startDevice(2293, 'bare-sw-01', {});
        devices.push(bare);
        const c3 = await connect(bare.port);
        clients.push(c3);
        const s3 = sessionOn(c3);
        check('no shell: opens at /', (await op(s3, { op: 'realpath', path: '.' })).path === '/');
        check('no shell: no listing', (await op(s3, { op: 'list', path: '/' })).unsupported === true);
        await op(s3, { op: 'list', path: '/' });
        await op(s3, { op: 'realpath', path: '.' });
        check('no shell: asked pwd once, never ls',
            bare.sent().filter((c) => c === 'pwd').length === 1 && !bare.sent().some((c) => /\bls\b/.test(c)),
            bare.sent().join(' | '));
        const got3 = path.join(work, 'vlan3.dat');
        await op(s3, { op: 'download', path: '/vlan.dat', local: got3 });
        check('no shell: SCP transfers work as before', fs.statSync(got3).size === 1024);
        files.drop(s3.id);

        const nols = await startDevice(2294, 'odd-sw-01', { RSMT_FIXTURE_SHELL: '/configs', RSMT_FIXTURE_NO_LS: '1' });
        devices.push(nols);
        const c4 = await connect(nols.port);
        clients.push(c4);
        const s4 = sessionOn(c4);
        check('pwd but no ls: opens where pwd said', (await op(s4, { op: 'realpath', path: '.' })).path === '/configs');
        check('pwd but no ls: the first listing decides it has none',
            (await op(s4, { op: 'list', path: '/configs' })).unsupported === true);
        const lsCount = nols.sent().filter((c) => /\bls\b/.test(c)).length;
        await op(s4, { op: 'list', path: '/configs' });
        check('pwd but no ls: and it is not asked again',
            nols.sent().filter((c) => /\bls\b/.test(c)).length === lsCount && lsCount === 1, lsCount);
        files.drop(s4.id);
    } finally {
        for (const c of clients) c.end();
        for (const d of devices) d.proc.kill();
        fs.rmSync(work, { recursive: true, force: true });
    }
    if (failures) {
        console.error(`FAIL - scp listing: ${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('ok - scp listing (BusyBox/GNU/toybox rows, hostile text dropped and counted, exact read-only commands, ' +
        'home and links, Cisco never asked, no-shell devices keep the form)');
    process.exit(0);
})().catch((err) => {
    console.error('FAIL - scp listing:', err && err.stack || err);
    process.exit(1);
});
