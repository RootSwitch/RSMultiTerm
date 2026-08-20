'use strict';
// Local SSH server impersonating a network device, for tests and smoke runs -
// no lab gear is assumed anywhere in the test chain. Ephemeral host key
// (generated per run, nothing committed), one account, a fake IOS-ish shell.
//
//   node tools/test-ssh-server.js [port]
//
// Account: nettest / nettest. Commands: "show version", "show int status"
// (both canned, fictional-estate content), "flood <mb>" (dumps N MB fast, for
// flow-control tests), "exit".

const crypto = require('crypto');
const { Server } = require('ssh2');
const { attachShell } = require('./fake-device');

const PORT = Number(process.argv[2]) || 2222;
const NAME = process.argv[3] || 'core-sw-01';
// Impersonate gear that has SCP but no SFTP subsystem.
const NO_SFTP = process.env.RSMT_FIXTURE_NO_SFTP === '1';

// The host key persists per port under the OS temp dir, because a key that
// changed on every restart made the app's TOFU store hard-block the fixture -
// correct behavior, useless for testing. Real gear keeps its key too.
// Nothing here is committed; delete the file to simulate a replaced device.
const KEY_FILE = require('path').join(require('os').tmpdir(), `rsmt-fixture-hostkey-${PORT}.pem`);
let hostKey;
try {
    hostKey = require('fs').readFileSync(KEY_FILE);
} catch (_) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    hostKey = privateKey.export({ type: 'pkcs1', format: 'pem' });
    require('fs').writeFileSync(KEY_FILE, hostKey, { mode: 0o600 });
}

// RSMT_FIXTURE_AUTHKEY=<private key path> turns on publickey auth.
const AUTH_KEY = (() => {
    const f = process.env.RSMT_FIXTURE_AUTHKEY;
    if (!f) return null;
    const parsed = require('ssh2').utils.parseKey(require('fs').readFileSync(f));
    if (parsed instanceof Error) throw parsed;
    return Array.isArray(parsed) ? parsed[0] : parsed;
})();

// RSMT_FIXTURE_LINUX_HOME=<dir>: behave like a Linux box for the key
// installer's exec commands (see the exec handler).
const LINUX_HOME = process.env.RSMT_FIXTURE_LINUX_HOME || null;
const keyInstall = require('../engine/key-install');

const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.username === 'nettest' && ctx.password === 'nettest') {
            return ctx.accept();
        }
        // Key auth, when the fixture is pointed at a private key. The
        // signature is verified rather than waved through: "it connected"
        // has to mean the app really signed with the key.
        if (ctx.method === 'publickey' && AUTH_KEY) {
            if (ctx.key.algo !== AUTH_KEY.type || !ctx.key.data.equals(AUTH_KEY.getPublicSSH())) {
                return ctx.reject();
            }
            if (!ctx.signature) return ctx.accept();   // key-offer probe
            return AUTH_KEY.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true
                ? ctx.accept() : ctx.reject();
        }
        const offer = AUTH_KEY ? ['password', 'publickey'] : ['password'];
        if (ctx.method === 'none') return ctx.reject(offer);
        return ctx.reject(offer);
    });

    client.on('ready', () => {
        // direct-tcpip support so this server can act as a jump host: the
        // app's hop pool dials forwardOut through here to reach the target.
        client.on('tcpip', (accept, reject, info) => {
            const net = require('net');
            const out = net.connect(info.destPort, info.destIP);
            out.on('connect', () => {
                const ch = accept();
                ch.pipe(out).pipe(ch);
                ch.on('close', () => out.destroy());
                out.on('close', () => ch.close());
            });
            out.on('error', () => reject());
        });

        client.on('session', (accept) => {
            const session = accept();
            // Remember what the client says the window is. A shell that
            // disagrees with the terminal redraws wrapped lines at the wrong
            // width, which eats rows on history recall - so the fixture has
            // to be able to report its own view for that to be testable.
            const winSize = { cols: 0, rows: 0, ptyCols: 0, ptyRows: 0, resizes: 0 };
            session.on('pty', (accept, reject, info) => {
                winSize.cols = winSize.ptyCols = info.cols;
                winSize.rows = winSize.ptyRows = info.rows;
                if (accept) accept();
            });
            session.on('window-change', (accept, reject, info) => {
                winSize.cols = info.cols;
                winSize.rows = info.rows;
                winSize.resizes++;
                if (accept) accept();
            });
            session.on('shell', (accept) => {
                const stream = accept();
                const shellWrite = attachShell(stream, {
                    name: NAME, winSize,
                    bracketed: process.env.RSMT_FIXTURE_BRACKET === '1',
                });
                stream.on('data', shellWrite);
                stream.on('close', () => client.end());
            });
            session.on('exec', (accept, reject, info) => {
                if (/^scp\s/.test(info.command)) return serveScp(accept(), info.command);
                // RSMT_FIXTURE_LINUX_HOME: emulate the two exec commands the
                // key installer sends, against a sandbox home directory -
                // matched EXACTLY against the strings the app really sends,
                // so a drifted command fails the test instead of the fake.
                if (LINUX_HOME && info.command === keyInstall.READ_CMD) {
                    const s = accept();
                    try {
                        s.write(require('fs').readFileSync(
                            path.join(LINUX_HOME, '.ssh', 'authorized_keys')));
                    } catch (_) { /* missing reads as empty, like 2>/dev/null */ }
                    s.exit(0);
                    s.end();
                    return;
                }
                if (LINUX_HOME && info.command === keyInstall.INSTALL_CMD) {
                    const s = accept();
                    let stdin = Buffer.alloc(0);
                    s.on('data', (d) => { stdin = Buffer.concat([stdin, d]); });
                    s.on('end', () => {
                        try {
                            const sshDir = path.join(LINUX_HOME, '.ssh');
                            const ak = path.join(sshDir, 'authorized_keys');
                            require('fs').mkdirSync(sshDir, { recursive: true });
                            let cur = Buffer.alloc(0);
                            try { cur = require('fs').readFileSync(ak); } catch (_) { /* fresh */ }
                            if (cur.length && cur[cur.length - 1] !== 0x0a) {
                                cur = Buffer.concat([cur, Buffer.from('\n')]);
                            }
                            require('fs').writeFileSync(ak, Buffer.concat([cur, stdin]));
                            s.exit(0);
                        } catch (err) {
                            s.stderr.write(String(err.message));
                            s.exit(1);
                        }
                        s.end();
                    });
                    return;
                }
                const s = accept();
                s.stderr.write(`% Unknown command: ${info.command}\r\n`);
                s.exit(1);
                s.end();
            });
            // A device with `NO_SFTP=1` refuses the subsystem, which is how
            // IOS behaves when only `ip scp server enable` is configured.
            session.on('sftp', (accept, reject) => {
                if (NO_SFTP) return reject();
                serveSftp(accept());
            });
        });
    });

    client.on('error', () => { /* client went away mid-handshake; fine */ });
});

// --- minimal SFTP subsystem over a sandbox directory ------------------------
// Enough of the protocol for the app's file browser: list, stat, get, put,
// mkdir, rename, delete. The sandbox root is created per run and seeded with
// a few fictional-estate files.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { utils: { sftp: { STATUS_CODE, OPEN_MODE } } } = require('ssh2');

const SFTP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-sftp-'));
fs.mkdirSync(path.join(SFTP_ROOT, 'configs'));
fs.writeFileSync(path.join(SFTP_ROOT, 'configs', 'startup-config'),
    'hostname core-sw-01\r\nip domain name example.com\r\n');
fs.writeFileSync(path.join(SFTP_ROOT, 'cat9k_iosxe.17.09.04a.SPA.bin'),
    Buffer.alloc(64 * 1024, 0x42));
fs.writeFileSync(path.join(SFTP_ROOT, 'vlan.dat'), Buffer.alloc(1024, 0x01));
fs.writeFileSync(path.join(SFTP_ROOT, '.bootlog'), 'hidden file for dotfile styling tests' + String.fromCharCode(10));

// Map the virtual absolute path ("/configs") into the sandbox, refusing
// escapes - it is a test fixture, not a file server, but habits are habits.
function real(p) {
    const norm = path.posix.normalize('/' + String(p || '/').replace(/\\/g, '/'));
    return path.join(SFTP_ROOT, norm);
}
function virt(p) {
    return '/' + path.relative(SFTP_ROOT, p).replace(/\\/g, '/');
}

function serveSftp(sftp) {
    const handles = new Map();   // handle string -> {type, fd?, entries?, sent?}
    let next = 1;
    const newHandle = (obj) => {
        const h = Buffer.from(`h${next++}`);
        handles.set(h.toString(), obj);
        return h;
    };
    // Real gear reports an owner and a group; Windows stat does not, so the
    // fixture supplies plausible ones. Without these the file browser's
    // owner/group columns have nothing to show and the feature cannot be
    // tested against anything.
    const FIXTURE_UID = 0;
    const FIXTURE_GID = 4;
    const FIXTURE_OWNER = 'root';
    const FIXTURE_GROUP = 'netops';

    const attrsOf = (st) => ({
        mode: st.mode, size: st.size,
        uid: FIXTURE_UID, gid: FIXTURE_GID,
        atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000),
    });

    // The `ls -l` line an SFTP server sends alongside each entry. It is the
    // ONLY place owner and group appear as names rather than numbers, which
    // is why clients parse it.
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const modeString = (mode) => {
        const type = (mode & 0xF000) === 0x4000 ? 'd' : (mode & 0xF000) === 0xA000 ? 'l' : '-';
        let s = type;
        for (const shift of [6, 3, 0]) {
            const bits = (mode >> shift) & 7;
            s += (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') + (bits & 1 ? 'x' : '-');
        }
        return s;
    };
    const longnameOf = (name, st) => {
        const d = new Date(st.mtimeMs);
        const p2 = (n) => String(n).padStart(2, '0');
        const when = `${MONTHS[d.getMonth()]} ${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
        return `${modeString(st.mode)}    1 ${FIXTURE_OWNER.padEnd(8)} ${FIXTURE_GROUP.padEnd(8)} ` +
            `${String(st.size).padStart(8)} ${when} ${name}`;
    };
    const fail = (reqid, err) => {
        sftp.status(reqid, err && err.code === 'ENOENT'
            ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE, err ? err.message : 'failure');
    };

    sftp.on('REALPATH', (reqid, p) => {
        const norm = path.posix.normalize('/' + String(p || '/').replace(/^\.$/, ''));
        sftp.name(reqid, [{ filename: norm === '//' ? '/' : norm }]);
    });
    sftp.on('OPENDIR', (reqid, p) => {
        fs.readdir(real(p), { withFileTypes: true }, (err, entries) => {
            if (err) return fail(reqid, err);
            const rows = entries.map((d) => {
                const st = fs.statSync(path.join(real(p), d.name));
                return { filename: d.name, longname: longnameOf(d.name, st), attrs: attrsOf(st) };
            });
            sftp.handle(reqid, newHandle({ type: 'dir', rows, sent: false }));
        });
    });
    sftp.on('READDIR', (reqid, handle) => {
        const h = handles.get(handle.toString());
        if (!h || h.type !== 'dir') return fail(reqid);
        if (h.sent) return sftp.status(reqid, STATUS_CODE.EOF);
        h.sent = true;
        sftp.name(reqid, h.rows);
    });
    const stat = (reqid, p) => {
        fs.stat(real(p), (err, st) => err ? fail(reqid, err) : sftp.attrs(reqid, attrsOf(st)));
    };
    sftp.on('STAT', stat);
    sftp.on('LSTAT', stat);
    sftp.on('FSTAT', (reqid, handle) => {
        const h = handles.get(handle.toString());
        if (!h || h.fd === undefined) return fail(reqid);
        fs.fstat(h.fd, (err, st) => err ? fail(reqid, err) : sftp.attrs(reqid, attrsOf(st)));
    });
    sftp.on('OPEN', (reqid, p, flags) => {
        const mode = (flags & OPEN_MODE.WRITE) ? 'w' : 'r';
        fs.open(real(p), mode, (err, fd) => {
            if (err) return fail(reqid, err);
            sftp.handle(reqid, newHandle({ type: 'file', fd }));
        });
    });
    sftp.on('READ', (reqid, handle, offset, length) => {
        const h = handles.get(handle.toString());
        if (!h || h.fd === undefined) return fail(reqid);
        const buf = Buffer.alloc(length);
        fs.read(h.fd, buf, 0, length, offset, (err, n) => {
            if (err) return fail(reqid, err);
            if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF);
            sftp.data(reqid, n === length ? buf : buf.subarray(0, n));
        });
    });
    sftp.on('WRITE', (reqid, handle, offset, data) => {
        const h = handles.get(handle.toString());
        if (!h || h.fd === undefined) return fail(reqid);
        fs.write(h.fd, data, 0, data.length, offset, (err) => {
            if (err) return fail(reqid, err);
            sftp.status(reqid, STATUS_CODE.OK);
        });
    });
    sftp.on('CLOSE', (reqid, handle) => {
        const h = handles.get(handle.toString());
        handles.delete(handle.toString());
        if (h && h.fd !== undefined) fs.close(h.fd, () => {});
        sftp.status(reqid, STATUS_CODE.OK);
    });
    sftp.on('MKDIR', (reqid, p) => {
        fs.mkdir(real(p), (err) => err ? fail(reqid, err) : sftp.status(reqid, STATUS_CODE.OK));
    });
    sftp.on('RMDIR', (reqid, p) => {
        fs.rmdir(real(p), (err) => err ? fail(reqid, err) : sftp.status(reqid, STATUS_CODE.OK));
    });
    sftp.on('REMOVE', (reqid, p) => {
        fs.unlink(real(p), (err) => err ? fail(reqid, err) : sftp.status(reqid, STATUS_CODE.OK));
    });
    sftp.on('RENAME', (reqid, from, to) => {
        fs.rename(real(from), real(to), (err) => err ? fail(reqid, err) : sftp.status(reqid, STATUS_CODE.OK));
    });
    sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
}

// --- minimal SCP responder --------------------------------------------------
// The device half of the rcp protocol: source mode (-f) sends a file, sink
// mode (-t) receives one. Enough to exercise the client for real, including
// the error path.
function serveScp(stream, command) {
    const m = /^scp\s+(-[ftr]+)\s+'?(.*?)'?$/.exec(command.trim());
    if (!m) { stream.stderr.write('scp: usage\n'); stream.exit(1); return stream.end(); }
    const mode = m[1];
    const target = m[2];

    if (mode.includes('f')) {
        // Source: wait for the client's ack, then send the file.
        let file;
        try {
            file = fs.readFileSync(real(target));
        } catch (_) {
            stream.once('data', () => {
                stream.write(Buffer.concat([Buffer.from([1]),
                    Buffer.from(`scp: ${target}: No such file or directory\n`)]));
                stream.exit(1);
                stream.end();
            });
            return;
        }
        let step = 0;
        stream.on('data', () => {
            step++;
            if (step === 1) {
                stream.write(`C0644 ${file.length} ${path.basename(target)}\n`);
            } else if (step === 2) {
                stream.write(file);
                stream.write(Buffer.from([0]));
            } else {
                stream.exit(0);
                stream.end();
            }
        });
        return;
    }

    // Sink: ack, read the header, take the bytes, ack again.
    let phase = 'header';
    let header = '';
    let remaining = 0;
    let name = '';
    const chunks = [];
    stream.write(Buffer.from([0]));
    stream.on('data', (chunk) => {
        let i = 0;
        while (i < chunk.length) {
            if (phase === 'header') {
                const b = chunk[i++];
                if (b === 0x0a) {
                    const h = /^C(\d{4})\s+(\d+)\s+(.*)$/.exec(header);
                    if (!h) {
                        stream.write(Buffer.concat([Buffer.from([2]), Buffer.from('bad header\n')]));
                        stream.exit(1);
                        return stream.end();
                    }
                    remaining = Number(h[2]);
                    name = h[3];
                    header = '';
                    phase = remaining ? 'data' : 'trailer';
                    stream.write(Buffer.from([0]));
                } else {
                    header += String.fromCharCode(b);
                }
                continue;
            }
            if (phase === 'data') {
                const take = Math.min(remaining, chunk.length - i);
                chunks.push(chunk.subarray(i, i + take));
                i += take;
                remaining -= take;
                if (!remaining) phase = 'trailer';
                continue;
            }
            i++;   // the client's end-of-file zero byte
            const dest = fs.statSync(real(target), { throwIfNoEntry: false });
            const outPath = dest && dest.isDirectory() ? path.join(real(target), name) : real(target);
            fs.writeFileSync(outPath, Buffer.concat(chunks));
            stream.write(Buffer.from([0]));
            phase = 'done';
            stream.exit(0);
            return stream.end();
        }
    });
}

server.listen(PORT, '127.0.0.1', () => {
    console.log(`test-ssh-server (${NAME}) listening on 127.0.0.1:${PORT}, sftp root ${SFTP_ROOT}`);
});
