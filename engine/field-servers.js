'use strict';
// Field tools: the three things a network engineer actually needs a laptop
// to SERVE in a wiring closet, and nothing else.
//
//   TFTP  - `copy tftp: flash:` is still how an image gets onto a switch,
//           and Windows has no TFTP server. RFC 1350, plus the RFC 2347/8/9
//           options that matter: without blksize a 1 GB image is two
//           million lockstep round trips.
//   HTTP  - newer gear pulls firmware over HTTP, and it is 40 lines.
//   WoL   - a magic packet, for the lab box that is asleep.
//
// This is the file where the app stops being purely a client, so the rules
// are stricter than anywhere else in it:
//
//   * Nothing listens until a human presses start. No autostart, ever.
//   * A bind address is CHOSEN, not assumed. 0.0.0.0 is available and is
//     never the default.
//   * TFTP is read-only unless writes are ticked, and every path - read or
//     write - is resolved and checked to be inside the served directory.
//     TFTP has no authentication by design, so the directory boundary is
//     the entire security model.
//   * Every server has a deadline. A tool started to move one file must not
//     still be serving the directory tomorrow.
//
// Runs in the engine process, like tunnels, so a flood of transfers cannot
// touch the main process event loop.

const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// TFTP opcodes.
const RRQ = 1, WRQ = 2, DATA = 3, ACK = 4, ERROR = 5, OACK = 6;
const DEFAULT_BLKSIZE = 512;
const MAX_BLKSIZE = 65464;      // RFC 2348 ceiling
const RETRIES = 5;
const RETRY_MS = 1200;
// Upload ceiling. TFTP is unauthenticated, so "writes allowed" must not
// mean "can fill the disk"; 4 GiB is beyond any firmware image and far
// below any disk this app serves from.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

const servers = new Map();      // id -> {kind, close(), info}
// Live per-transfer sockets, by server id. Stop and the deadline used to
// close only the LISTENING socket, so a transfer in progress - and, worse,
// a stalled upload holding a file handle - outlived the button and the
// time limit the module makes a point of enforcing.
const transfers = new Map();    // id -> Set of cancel()
function trackTransfer(id, cancel) {
    let set = transfers.get(id);
    if (!set) { set = new Set(); transfers.set(id, set); }
    set.add(cancel);
    return () => set.delete(cancel);
}
let onEvent = () => {};

function setNotifier(fn) { onEvent = fn; }

function note(id, text, detail) {
    onEvent({ t: 'field-log', id, text, detail: detail || null, at: Date.now() });
}

// Every path a client names is resolved against the root and checked to be
// inside it. A device asking for '../../.ssh/id_ed25519' gets an error
// packet, not a key.
function inside(root, name) {
    const clean = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const full = path.resolve(root, clean);
    const base = path.resolve(root);
    if (full !== base && !full.startsWith(base + path.sep)) return null;
    // The check above is lexical; symlinks and junctions defeat it. A link
    // inside the served folder pointing outside it passes every string
    // test and then openSync follows it - so resolve what actually exists
    // and re-check. For a path that does not exist yet (an upload), the
    // deepest existing ancestor is what a link could hide in.
    let realBase;
    try { realBase = fs.realpathSync.native(base); } catch (_) { return null; }
    let real = null;
    try {
        real = fs.realpathSync.native(full);
    } catch (_) {
        try {
            real = path.join(fs.realpathSync.native(path.dirname(full)), path.basename(full));
        } catch (_) {
            // Nothing on the path exists, so nothing can be a link; the
            // lexical answer stands and open() will say "not found".
            return full;
        }
    }
    if (real !== realBase && !real.startsWith(realBase + path.sep)) return null;
    return real;
}

// --- TFTP -------------------------------------------------------------------

// The callback matters: send() is asynchronous, so a caller that closes
// the socket on the next line destroys the datagram before it leaves and
// the device waits out its own timeout instead of being told why.
function tftpError(sock, port, address, code, message, andThen) {
    const msg = Buffer.from(String(message || 'error'), 'utf8');
    const buf = Buffer.alloc(4 + msg.length + 1);
    buf.writeUInt16BE(ERROR, 0);
    buf.writeUInt16BE(code, 2);
    msg.copy(buf, 4);
    buf.writeUInt8(0, 4 + msg.length);
    sock.send(buf, port, address, () => { if (andThen) andThen(); });
}

// A request packet: opcode, then NUL-terminated strings - filename, mode,
// then option/value pairs.
function parseRequest(msg) {
    const parts = [];
    let start = 2;
    for (let i = 2; i < msg.length; i++) {
        if (msg[i] === 0) { parts.push(msg.toString('utf8', start, i)); start = i + 1; }
    }
    const [filename, mode, ...rest] = parts;
    const options = {};
    for (let i = 0; i + 1 < rest.length; i += 2) options[rest[i].toLowerCase()] = rest[i + 1];
    return { filename, mode: (mode || 'octet').toLowerCase(), options };
}

function oackPacket(accepted) {
    const chunks = [Buffer.from([0, OACK])];
    for (const [k, v] of Object.entries(accepted)) {
        chunks.push(Buffer.from(k, 'utf8'), Buffer.from([0]),
            Buffer.from(String(v), 'utf8'), Buffer.from([0]));
    }
    return Buffer.concat(chunks);
}

// One transfer gets its own socket, which is what the RFC means by a new
// TID: the client replies to that port for the rest of the exchange.
function tftpRead(id, root, req, rinfo, bind) {
    const file = inside(root, req.filename);
    if (!file) { return refuse(rinfo, 2, 'access violation', id, req.filename); }
    let fd, size;
    try {
        size = fs.statSync(file).size;
        fd = fs.openSync(file, 'r');
    } catch (_) {
        return refuse(rinfo, 1, 'file not found', id, req.filename);
    }

    const sock = dgram.createSocket('udp4');
    let blksize = DEFAULT_BLKSIZE;
    const accepted = {};
    if (req.options.blksize) {
        const want = Number(req.options.blksize);
        if (Number.isFinite(want) && want >= 8) {
            blksize = Math.min(MAX_BLKSIZE, Math.floor(want));
            accepted.blksize = blksize;
        }
    }
    if (req.options.tsize !== undefined) accepted.tsize = size;

    let block = 0;
    let current = null;
    let tries = 0;
    let timer = null;
    let sent = 0;

    const finish = (text, detail) => {
        untrack();
        clearTimeout(timer);
        try { fs.closeSync(fd); } catch (_) { /* already closed */ }
        try { sock.close(); } catch (_) { /* already closed */ }
        note(id, text, detail);
    };
    const untrack = trackTransfer(id, () =>
        finish(`tftp: ${req.filename} stopped`, 'server stopped'));

    const sendCurrent = () => {
        sock.send(current, rinfo.port, rinfo.address);
        clearTimeout(timer);
        timer = setTimeout(() => {
            if (++tries > RETRIES) return finish(`tftp: ${req.filename} timed out`, rinfo.address);
            sendCurrent();
        }, RETRY_MS);
    };

    const sendBlock = (n) => {
        const buf = Buffer.alloc(blksize);
        const read = fs.readSync(fd, buf, 0, blksize, (n - 1) * blksize);
        const packet = Buffer.alloc(4 + read);
        packet.writeUInt16BE(DATA, 0);
        packet.writeUInt16BE(n & 0xffff, 2);
        buf.copy(packet, 4, 0, read);
        current = packet;
        tries = 0;
        sent += read;
        sendCurrent();
        return read;
    };

    sock.on('message', (msg, from) => {
        if (from.address !== rinfo.address) return;
        const op = msg.readUInt16BE(0);
        if (op === ERROR) return finish(`tftp: ${req.filename} cancelled by the device`, rinfo.address);
        if (op !== ACK) return;
        const acked = msg.readUInt16BE(2);
        // The OACK is acknowledged as block 0, then blocks start at 1.
        if (acked !== (block & 0xffff)) return;   // duplicate ACK: ignore
        if (block > 0 && current && current.length - 4 < blksize) {
            return finish(`tftp: sent ${req.filename} (${sent} bytes)`, rinfo.address);
        }
        block++;
        const read = sendBlock(block);
        if (read === 0 && block > 1) {
            // A file that is an exact multiple of blksize ends with an
            // empty DATA packet, which is what this is.
        }
    });
    sock.on('error', () => finish(`tftp: ${req.filename} failed`, rinfo.address));

    sock.bind(0, bind, () => {
        note(id, `tftp: sending ${req.filename}`, `${rinfo.address} (${size} bytes)`);
        if (Object.keys(accepted).length) {
            current = oackPacket(accepted);
            tries = 0;
            sendCurrent();
        } else {
            block = 1;
            sendBlock(1);
        }
    });

    function refuse(to, code, message, sid, name) {
        const s = dgram.createSocket('udp4');
        // An ICMP port-unreachable from a vanished client surfaces as an
        // 'error' event on Windows; with no listener that throws and takes
        // the engine with it. Anyone who can reach the port can cause it.
        s.on('error', () => { try { s.close(); } catch (_) { /* closed */ } });
        s.bind(0, bind, () => {
            tftpError(s, to.port, to.address, code, message,
                () => { try { s.close(); } catch (_) { /* closed */ } });
        });
        note(sid, `tftp: refused ${name}`, `${to.address} - ${message}`);
    }
}

function tftpWrite(id, root, req, rinfo, bind, allowWrites) {
    const sock = dgram.createSocket('udp4');
    let openHandle = null;
    let tmpFile = null;
    let idleTimer = null;
    let untrack = () => {};
    const done = (text, detail) => {
        untrack();
        clearTimeout(idleTimer);
        if (openHandle !== null) { try { fs.closeSync(openHandle); } catch (_) { /* closed */ } }
        openHandle = null;
        // An upload that did not finish leaves NOTHING behind: a truncated
        // image with the right name is exactly what a device will happily
        // flash. The temp file is the only thing we ever wrote.
        if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (_) { /* never written */ } }
        tmpFile = null;
        try { sock.close(); } catch (_) { /* closed */ }
        note(id, text, detail);
    };
    // The read path has had this from the start; the write path did not,
    // and an ACK to a client that has gone away surfaces an ICMP
    // port-unreachable as 'error' on Windows - unhandled, that crashed the
    // engine and every SSH session with it, from any host that could reach
    // an upload-enabled port.
    sock.on('error', () => done(`tftp: upload of ${req.filename} failed`, 'socket error'));
    // The read path self-terminates through its retransmit budget; a writer
    // that goes silent after WRQ used to hold the socket and file handle
    // open forever. Same budget, same policy.
    const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() =>
            done(`tftp: upload of ${req.filename} timed out`, rinfo.address),
        RETRY_MS * (RETRIES + 1));
    };
    sock.bind(0, bind, () => {
        if (!allowWrites) {
            return tftpError(sock, rinfo.port, rinfo.address, 2, 'server is read-only',
                () => done(`tftp: refused upload of ${req.filename}`, `${rinfo.address} - read-only`));
        }
        const file = inside(root, req.filename);
        if (!file) {
            return tftpError(sock, rinfo.port, rinfo.address, 2, 'access violation',
                () => done(`tftp: refused upload of ${req.filename}`, `${rinfo.address} - outside the folder`));
        }
        // A declared size beyond the cap is refused before a byte moves.
        // The cap exists because TFTP has no authentication: anything that
        // can reach the port can write, and "can write" must not include
        // "can fill the disk".
        if (req.options.tsize !== undefined) {
            const declared = Number(req.options.tsize);
            if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
                return tftpError(sock, rinfo.port, rinfo.address, 3, 'file too large',
                    () => done(`tftp: refused upload of ${req.filename}`,
                        `${rinfo.address} - declared ${declared} bytes`));
            }
        }
        // Written under a temp name and renamed into place on completion.
        // The old code opened the FINAL name with 'w' the instant the WRQ
        // arrived - so a single request carrying no data at all truncated
        // an existing served file to zero. startup-config, say.
        tmpFile = `${file}.part`;
        let handle;
        try {
            handle = fs.openSync(tmpFile, 'w');
            openHandle = handle;
        } catch (err) {
            tmpFile = null;
            return tftpError(sock, rinfo.port, rinfo.address, 3, 'cannot write there',
                () => done(`tftp: cannot write ${req.filename}`, err.message));
        }
        untrack = trackTransfer(id, () =>
            done(`tftp: upload of ${req.filename} stopped`, 'server stopped'));

        let blksize = DEFAULT_BLKSIZE;
        const accepted = {};
        if (req.options.blksize) {
            const want = Number(req.options.blksize);
            if (Number.isFinite(want) && want >= 8) {
                blksize = Math.min(MAX_BLKSIZE, Math.floor(want));
                accepted.blksize = blksize;
            }
        }
        let expect = 1;
        let received = 0;
        const ack = (n) => {
            const buf = Buffer.alloc(4);
            buf.writeUInt16BE(ACK, 0);
            buf.writeUInt16BE(n & 0xffff, 2);
            sock.send(buf, rinfo.port, rinfo.address);
        };
        sock.on('message', (msg, from) => {
            if (from.address !== rinfo.address) return;
            const op = msg.readUInt16BE(0);
            if (op === ERROR) {
                return done(`tftp: upload of ${req.filename} cancelled`, rinfo.address);
            }
            if (op !== DATA) return;
            armIdle();
            const n = msg.readUInt16BE(2);
            if (n !== (expect & 0xffff)) { ack(n); return; }   // duplicate: re-ack
            const body = msg.subarray(4);
            if (received + body.length > MAX_UPLOAD_BYTES) {
                return tftpError(sock, rinfo.port, rinfo.address, 3, 'file too large',
                    () => done(`tftp: refused upload of ${req.filename}`,
                        `${rinfo.address} - exceeded ${MAX_UPLOAD_BYTES} bytes`));
            }
            try {
                fs.writeSync(handle, body);
            } catch (err) {
                return tftpError(sock, rinfo.port, rinfo.address, 3, 'write failed',
                    () => done(`tftp: write failed for ${req.filename}`, err.message));
            }
            received += body.length;
            ack(n);
            expect++;
            if (body.length < blksize) {
                // Complete: close, move into place, and only then report.
                untrack();
                clearTimeout(idleTimer);
                openHandle = null;
                try { fs.closeSync(handle); } catch (_) { /* closed */ }
                try {
                    fs.renameSync(tmpFile, file);
                    tmpFile = null;
                } catch (err) {
                    return done(`tftp: could not finalize ${req.filename}`, err.message);
                }
                done(`tftp: received ${req.filename} (${received} bytes)`, rinfo.address);
            }
        });
        armIdle();
        if (Object.keys(accepted).length) sock.send(oackPacket(accepted), rinfo.port, rinfo.address);
        else ack(0);
        note(id, `tftp: receiving ${req.filename}`, rinfo.address);
    });
}

function startTftp(id, spec) {
    return new Promise((resolve, reject) => {
        const root = path.resolve(spec.root);
        if (!fs.statSync(root).isDirectory()) return reject(new Error('not a folder'));
        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
        sock.on('error', (err) => reject(err));
        sock.on('message', (msg, rinfo) => {
            if (msg.length < 4) return;
            const op = msg.readUInt16BE(0);
            if (op !== RRQ && op !== WRQ) return;
            const req = parseRequest(msg);
            if (op === RRQ) tftpRead(id, root, req, rinfo, spec.bind);
            else tftpWrite(id, root, req, rinfo, spec.bind, !!spec.allowWrites);
        });
        sock.bind(spec.port, spec.bind === '0.0.0.0' ? undefined : spec.bind, () => {
            resolve({
                close: () => { try { sock.close(); } catch (_) { /* closed */ } },
                port: sock.address().port,
            });
        });
    });
}

// --- HTTP -------------------------------------------------------------------

const MIME = {
    '.txt': 'text/plain', '.log': 'text/plain', '.cfg': 'text/plain',
    '.json': 'application/json', '.xml': 'application/xml',
    '.html': 'text/html', '.htm': 'text/html',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
};

function startHttp(id, spec) {
    return new Promise((resolve, reject) => {
        const root = path.resolve(spec.root);
        const server = http.createServer((req, res) => {
            // Read-only by construction: anything but GET/HEAD is refused.
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405, { Allow: 'GET, HEAD' });
                return res.end('method not allowed\n');
            }
            let name;
            try {
                name = decodeURIComponent((req.url || '/').split('?')[0]);
            } catch (_) {
                res.writeHead(400); return res.end('bad request\n');
            }
            const full = inside(root, name === '/' ? '' : name);
            if (!full) {
                note(id, `http: refused ${name}`, `${req.socket.remoteAddress} - outside the folder`);
                res.writeHead(403); return res.end('forbidden\n');
            }
            let st;
            try { st = fs.statSync(full); } catch (_) {
                res.writeHead(404); return res.end('not found\n');
            }
            if (st.isDirectory()) {
                if (!spec.listing) { res.writeHead(403); return res.end('listing is off\n'); }
                const entries = fs.readdirSync(full, { withFileTypes: true })
                    .map((e) => e.name + (e.isDirectory() ? '/' : ''));
                const base = name.endsWith('/') ? name : name + '/';
                const body = entries.map((e) =>
                    `<a href="${encodeURI(base + e)}">${e.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</a>`)
                    .join('<br>\n');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end(`<!doctype html><meta charset="utf-8"><pre>${body}</pre>`);
            }
            note(id, `http: sending ${path.basename(full)}`, req.socket.remoteAddress);
            res.writeHead(200, {
                'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
                'Content-Length': st.size,
            });
            if (req.method === 'HEAD') return res.end();
            fs.createReadStream(full).pipe(res);
        });
        server.on('error', reject);
        server.listen(spec.port, spec.bind === '0.0.0.0' ? undefined : spec.bind, () => {
            resolve({ close: () => { try { server.close(); } catch (_) { /* closed */ } },
                port: server.address().port });
        });
    });
}

// --- Wake on LAN ------------------------------------------------------------
// Not a server: one packet, then done. Six 0xFF bytes followed by the MAC
// sixteen times, to the broadcast address - the NIC's firmware is listening
// for that pattern while the machine is off.

// async, so a malformed MAC comes back as a rejection like every other
// failure here. A function that sometimes throws synchronously and
// sometimes rejects makes every caller handle failure twice.
async function wake(mac, broadcast, port) {
    const hex = String(mac || '').replace(/[^0-9a-fA-F]/g, '');
    if (hex.length !== 12) throw new Error('a MAC address looks like 00:11:22:33:44:55');
    const addr = Buffer.from(hex, 'hex');
    const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(addr)]);
    return new Promise((resolve, reject) => {
        const sock = dgram.createSocket('udp4');
        sock.once('error', (err) => { try { sock.close(); } catch (_) { /* closed */ } reject(err); });
        sock.bind(() => {
            sock.setBroadcast(true);
            sock.send(packet, port || 9, broadcast || '255.255.255.255', (err) => {
                try { sock.close(); } catch (_) { /* closed */ }
                if (err) reject(err); else resolve({ sent: packet.length, mac: hex });
            });
        });
    });
}

// --- lifecycle --------------------------------------------------------------

async function start(spec) {
    if (servers.has(spec.id)) throw new Error('already running');
    const started = spec.kind === 'tftp' ? await startTftp(spec.id, spec)
        : spec.kind === 'http' ? await startHttp(spec.id, spec)
            : (() => { throw new Error(`unknown server ${spec.kind}`); })();

    // Every server has a deadline. A tool started to move one file must not
    // still be serving a directory tomorrow because someone forgot.
    const minutes = Math.max(1, Math.min(720, Number(spec.stopAfterMinutes) || 60));
    const timer = setTimeout(() => {
        stop(spec.id);
        onEvent({ t: 'field-state', id: spec.id, state: 'stopped', reason: 'time limit reached' });
    }, minutes * 60000);
    if (timer.unref) timer.unref();

    servers.set(spec.id, {
        kind: spec.kind, close: started.close, timer,
        info: { id: spec.id, kind: spec.kind, root: spec.root, bind: spec.bind,
            port: started.port, allowWrites: !!spec.allowWrites, listing: !!spec.listing,
            startedAt: Date.now(), stopsAt: Date.now() + minutes * 60000 },
    });
    return servers.get(spec.id).info;
}

function stop(id) {
    const s = servers.get(id);
    if (!s) return { stopped: false };
    clearTimeout(s.timer);
    s.close();
    servers.delete(id);
    // Stop means STOP: transfers in flight close with the listener, or
    // "stop after N minutes" is a promise about the front door only.
    const live = transfers.get(id);
    transfers.delete(id);
    if (live) for (const cancel of [...live]) cancel();
    return { stopped: true };
}

function stopAll() {
    for (const id of [...servers.keys()]) stop(id);
}

function list() {
    return [...servers.values()].map((s) => s.info);
}

// The addresses a device could actually reach this machine on.
function interfaces() {
    const out = [];
    const nets = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(nets)) {
        for (const a of addrs || []) {
            if (a.family === 'IPv4' || a.family === 4) {
                out.push({ name, address: a.address, internal: !!a.internal });
            }
        }
    }
    return out;
}

module.exports = { start, stop, stopAll, list, wake, interfaces, setNotifier, inside };
