'use strict';
// Field tools on the wire: a real TFTP client fetching a real file, a real
// HTTP request, and a real magic packet caught on a socket.
//
// The assertions that matter most are the refusals. TFTP has no
// authentication of any kind - the served directory boundary IS the
// security model - so "a device asking for ../../../.ssh/id_ed25519 gets an
// error packet" is the load-bearing test in this file, and it is checked
// for reads AND writes, on TFTP AND HTTP.

const assert = require('assert');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const field = require('../engine/field-servers');

// The served folder sits INSIDE a sandbox this test owns, so the
// escape-write case lands somewhere removable rather than in the shared
// temp directory. A planted defect once wrote there and every later run
// inherited the evidence.
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-field-'));
const root = path.join(box, 'served');
fs.mkdirSync(root);
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-secret-'));
fs.writeFileSync(path.join(outside, 'private.txt'), 'a key you must never serve');

// An "image": big enough to need many blocks, so block sequencing and the
// final short block are actually exercised rather than assumed.
const image = Buffer.alloc(1024 * 40);
for (let i = 0; i < image.length; i++) image[i] = (i * 7) & 0xff;
fs.writeFileSync(path.join(root, 'image.bin'), image);
fs.writeFileSync(path.join(root, 'startup-config'), 'hostname core-sw-01\n');

const RRQ = 1, WRQ = 2, DATA = 3, ACK = 4, ERROR = 5, OACK = 6;

function reqPacket(op, name, options) {
    const parts = [Buffer.from([0, op]), Buffer.from(name, 'utf8'), Buffer.from([0]),
        Buffer.from('octet', 'utf8'), Buffer.from([0])];
    for (const [k, v] of Object.entries(options || {})) {
        parts.push(Buffer.from(k), Buffer.from([0]), Buffer.from(String(v)), Buffer.from([0]));
    }
    return Buffer.concat(parts);
}

// A minimal but honest TFTP read client: sends RRQ, acks what arrives,
// follows the server to its new port, and stops on a short block.
function tftpGet(port, name, options) {
    return new Promise((resolve, reject) => {
        const sock = dgram.createSocket('udp4');
        const chunks = [];
        let blksize = 512;
        let oack = null;
        const timer = setTimeout(() => { sock.close(); reject(new Error('timed out')); }, 8000);
        sock.on('message', (msg, rinfo) => {
            const op = msg.readUInt16BE(0);
            if (op === ERROR) {
                clearTimeout(timer); sock.close();
                return resolve({ error: msg.toString('utf8', 4, msg.length - 1), code: msg.readUInt16BE(2) });
            }
            if (op === OACK) {
                oack = {};
                let start = 2;
                const parts = [];
                for (let i = 2; i < msg.length; i++) {
                    if (msg[i] === 0) { parts.push(msg.toString('utf8', start, i)); start = i + 1; }
                }
                for (let i = 0; i + 1 < parts.length; i += 2) oack[parts[i]] = parts[i + 1];
                if (oack.blksize) blksize = Number(oack.blksize);
                const a = Buffer.alloc(4);
                a.writeUInt16BE(ACK, 0); a.writeUInt16BE(0, 2);
                return sock.send(a, rinfo.port, '127.0.0.1');
            }
            if (op !== DATA) return;
            const block = msg.readUInt16BE(2);
            const body = msg.subarray(4);
            chunks.push(body);
            const a = Buffer.alloc(4);
            a.writeUInt16BE(ACK, 0); a.writeUInt16BE(block, 2);
            sock.send(a, rinfo.port, '127.0.0.1');
            if (body.length < blksize) {
                clearTimeout(timer); sock.close();
                resolve({ data: Buffer.concat(chunks), oack });
            }
        });
        sock.on('error', (err) => { clearTimeout(timer); reject(err); });
        sock.send(reqPacket(RRQ, name, options), port, '127.0.0.1');
    });
}

// A minimal TFTP write client, for the upload paths.
function tftpPut(port, name, data) {
    return new Promise((resolve, reject) => {
        const sock = dgram.createSocket('udp4');
        let sent = 0;
        let block = 0;
        const timer = setTimeout(() => { sock.close(); reject(new Error('timed out')); }, 8000);
        sock.on('message', (msg, rinfo) => {
            const op = msg.readUInt16BE(0);
            if (op === ERROR) {
                clearTimeout(timer); sock.close();
                return resolve({ error: msg.toString('utf8', 4, msg.length - 1) });
            }
            if (op !== ACK && op !== OACK) return;
            if (sent >= data.length && block > 0) {
                clearTimeout(timer); sock.close();
                return resolve({ ok: true });
            }
            block++;
            const body = data.subarray(sent, sent + 512);
            sent += body.length;
            const packet = Buffer.alloc(4 + body.length);
            packet.writeUInt16BE(DATA, 0);
            packet.writeUInt16BE(block, 2);
            body.copy(packet, 4);
            sock.send(packet, rinfo.port, '127.0.0.1');
            if (body.length < 512) {
                setTimeout(() => {
                    clearTimeout(timer);
                    try { sock.close(); } catch (_) { /* closed */ }
                    resolve({ ok: true });
                }, 300);
            }
        });
        sock.on('error', (err) => { clearTimeout(timer); reject(err); });
        sock.send(reqPacket(WRQ, name, {}), port, '127.0.0.1');
    });
}

const get = (port, p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
        const bufs = [];
        res.on('data', (d) => bufs.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(bufs) }));
    }).on('error', reject);
});

(async () => {
    try {
        // --- TFTP -------------------------------------------------------
        const tftp = await field.start({
            id: 'tftp', kind: 'tftp', root, bind: '127.0.0.1', port: 0,
            allowWrites: false, stopAfterMinutes: 5,
        });
        assert.ok(tftp.port > 0, 'the server reports the port it actually bound');

        // A whole image, over many blocks, byte for byte.
        const small = await tftpGet(tftp.port, 'startup-config');
        assert.strictEqual(small.data.toString(), 'hostname core-sw-01\n', 'small file round trip');

        const big = await tftpGet(tftp.port, 'image.bin');
        assert.ok(big.data.equals(image), `image must arrive intact, got ${big.data.length} of ${image.length}`);

        // blksize is what makes a real image bearable: 40 KB in 512-byte
        // blocks is 80 lockstep round trips, and a 1 GB image is two million.
        const fast = await tftpGet(tftp.port, 'image.bin', { blksize: 4096, tsize: 0 });
        assert.ok(fast.oack, 'the server must answer options with an OACK');
        assert.strictEqual(fast.oack.blksize, '4096', 'the negotiated block size is honored');
        assert.strictEqual(fast.oack.tsize, String(image.length), 'tsize reports the real size');
        assert.ok(fast.data.equals(image), 'the large-block transfer is identical');

        // THE assertion: no path outside the served folder, ever.
        for (const escape of ['../private.txt', '..\\private.txt', '/etc/passwd',
            '../../secret', 'sub/../../private.txt']) {
            const bad = await tftpGet(tftp.port, escape);
            assert.ok(bad.error, `TFTP must refuse ${escape}`);
            assert.ok(!bad.data, `TFTP must not return data for ${escape}`);
        }
        const missing = await tftpGet(tftp.port, 'nope.bin');
        assert.strictEqual(missing.code, 1, 'a missing file is "file not found", not a crash');

        // A link INSIDE the folder pointing OUTSIDE it defeats every string
        // check - the lexical path is squeaky clean and open() follows the
        // link. Junction on Windows (no privilege needed), symlink
        // elsewhere. TFTP has no auth, so this is a full read primitive if
        // it works.
        fs.writeFileSync(path.join(outside, 'loot.txt'), 'never serve this either');
        try {
            fs.symlinkSync(outside, path.join(root, 'jump'),
                process.platform === 'win32' ? 'junction' : 'dir');
        } catch (err) {
            throw new Error(`could not create the escape link for the test: ${err.message}`);
        }
        const viaLink = await tftpGet(tftp.port, 'jump/loot.txt');
        assert.ok(viaLink.error, 'TFTP must refuse a path that resolves through a link to outside');
        assert.ok(!viaLink.data, 'and must not return its content');

        // netascii asks for translation this server does not do; it used
        // to be silently served raw octet, which corrupts exactly the text
        // configs the mode exists for. Refused, with a message that names
        // the fix.
        const ascii = await new Promise((resolve, reject) => {
            const s = dgram.createSocket('udp4');
            const timer = setTimeout(() => { s.close(); reject(new Error('no answer to netascii')); }, 4000);
            const parts = [Buffer.from([0, RRQ]), Buffer.from('startup-config'), Buffer.from([0]),
                Buffer.from('netascii'), Buffer.from([0])];
            s.on('message', (msg) => {
                clearTimeout(timer); s.close();
                resolve(msg.readUInt16BE(0) === ERROR
                    ? { error: msg.toString('utf8', 4, msg.length - 1) } : { data: true });
            });
            s.send(Buffer.concat(parts), tftp.port, '127.0.0.1');
        });
        assert.ok(ascii.error && /octet/.test(ascii.error),
            'netascii must be refused with a message pointing at octet mode');

        // RFC 1350: the transfer peer is a TID - address AND port. A forged
        // ERROR from another process on the same host must not kill a live
        // transfer.
        const spoofed = await new Promise((resolve, reject) => {
            const a = dgram.createSocket('udp4');
            const b = dgram.createSocket('udp4');
            const chunks = [];
            let transferPort = null;
            const timer = setTimeout(() => { a.close(); b.close();
                reject(new Error('spoof scenario stalled')); }, 8000);
            a.on('message', (msg, rinfo) => {
                const op = msg.readUInt16BE(0);
                if (op !== DATA) return;
                transferPort = rinfo.port;
                chunks.push(msg.subarray(4));
                if (chunks.length === 1) {
                    // First block in hand: forge an ERROR from a DIFFERENT
                    // socket (same address, different port), then ack from
                    // the real one. The transfer must survive the forgery.
                    const err = Buffer.concat([Buffer.from([0, ERROR, 0, 0]),
                        Buffer.from('forged'), Buffer.from([0])]);
                    b.send(err, transferPort, '127.0.0.1', () => {
                        setTimeout(() => {
                            const ackBuf = Buffer.alloc(4);
                            ackBuf.writeUInt16BE(ACK, 0);
                            ackBuf.writeUInt16BE(msg.readUInt16BE(2), 2);
                            a.send(ackBuf, transferPort, '127.0.0.1');
                        }, 150);
                    });
                    return;
                }
                // Second DATA arriving proves the forged ERROR was ignored.
                clearTimeout(timer); a.close(); b.close();
                resolve(true);
            });
            a.send(reqPacket(RRQ, 'image.bin', {}), tftp.port, '127.0.0.1');
        });
        assert.ok(spoofed, 'a forged ERROR from another port must not cancel a transfer');

        // Read-only by default: an upload is refused rather than accepted.
        const denied = await tftpPut(tftp.port, 'planted.txt', Buffer.from('should not land'));
        assert.ok(denied.error && /read-only/.test(denied.error), 'uploads are refused by default');
        assert.ok(!fs.existsSync(path.join(root, 'planted.txt')), 'and nothing was written');
        field.stop('tftp');

        // With writes ticked, an upload lands - inside the folder only.
        const rw = await field.start({
            id: 'tftp', kind: 'tftp', root, bind: '127.0.0.1', port: 0,
            allowWrites: true, stopAfterMinutes: 5,
        });
        const put = await tftpPut(rw.port, 'uploaded.cfg', Buffer.from('hostname from-device\n'));
        assert.ok(put.ok, 'an allowed upload completes');
        assert.strictEqual(fs.readFileSync(path.join(root, 'uploaded.cfg'), 'utf8'),
            'hostname from-device\n', 'and the bytes are right');
        const escapeWrite = await tftpPut(rw.port, '../escaped.cfg', Buffer.from('nope'));
        assert.ok(escapeWrite.error, 'an upload outside the folder is refused');
        assert.ok(!fs.existsSync(path.join(box, 'escaped.cfg')),
            'and nothing was written outside the folder');
        const writeViaLink = await tftpPut(rw.port, 'jump/dropped.cfg', Buffer.from('nope'));
        assert.ok(writeViaLink.error, 'an upload through the junction is refused');
        assert.ok(!fs.existsSync(path.join(outside, 'dropped.cfg')),
            'and nothing landed outside the folder');

        // A WRQ alone must not clobber the file it names. The old code
        // opened the FINAL name with 'w' the instant the request arrived,
        // so a request carrying zero bytes of data truncated an existing
        // served file - startup-config, say - to nothing.
        fs.writeFileSync(path.join(root, 'precious.cfg'), 'the good config\n');
        await new Promise((resolve) => {
            const s = dgram.createSocket('udp4');
            s.on('message', () => { /* the ACK; send nothing back, ever */ });
            s.send(reqPacket(WRQ, 'precious.cfg', {}), rw.port, '127.0.0.1',
                () => setTimeout(() => { s.close(); resolve(); }, 400));
        });
        assert.strictEqual(fs.readFileSync(path.join(root, 'precious.cfg'), 'utf8'),
            'the good config\n',
            'a data-less WRQ must not truncate the file it names');

        // A declared size beyond the cap is refused before a byte moves -
        // TFTP has no auth, and "writes allowed" must not mean "can fill
        // the disk".
        const huge = await new Promise((resolve, reject) => {
            const s = dgram.createSocket('udp4');
            const timer = setTimeout(() => { s.close(); reject(new Error('no answer to huge tsize')); }, 4000);
            s.on('message', (msg) => {
                clearTimeout(timer); s.close();
                resolve(msg.readUInt16BE(0) === ERROR
                    ? { error: msg.toString('utf8', 4, msg.length - 1) } : { accepted: true });
            });
            s.send(reqPacket(WRQ, 'toolarge.bin', { tsize: '99999999999999' }), rw.port, '127.0.0.1');
        });
        assert.ok(huge.error && /too large/.test(huge.error),
            'a declared size beyond the cap is refused up front');
        field.stop('tftp');

        // Stop means stop, transfers included. Start a read, take the first
        // block, never ACK - the server retransmits on its timer. Stop the
        // server mid-transfer: the retransmits must cease, because the old
        // code closed only the LISTENING socket and the transfer outlived
        // both the button and the deadline.
        const rd = await field.start({
            id: 'tftp', kind: 'tftp', root, bind: '127.0.0.1', port: 0,
            allowWrites: false, stopAfterMinutes: 5,
        });
        const packetsAfterStop = await new Promise((resolve, reject) => {
            const s = dgram.createSocket('udp4');
            let sawData = false;
            let stopped = false;
            let after = 0;
            const guard = setTimeout(() => { s.close(); reject(new Error('transfer never started')); }, 5000);
            s.on('message', () => {
                if (!sawData) {
                    sawData = true;
                    clearTimeout(guard);
                    // First DATA in hand; stop the server and count what
                    // still arrives after a full retransmit interval.
                    setTimeout(() => {
                        field.stop('tftp');
                        stopped = true;
                        setTimeout(() => { s.close(); resolve(after); }, 2600);
                    }, 100);
                } else if (stopped) {
                    after++;
                }
            });
            s.send(reqPacket(RRQ, 'image.bin', {}), rd.port, '127.0.0.1');
        });
        assert.strictEqual(packetsAfterStop, 0,
            `stop must end in-flight transfers - saw ${packetsAfterStop} retransmits after stop`);

        // --- HTTP -------------------------------------------------------
        const web = await field.start({
            id: 'http', kind: 'http', root, bind: '127.0.0.1', port: 0,
            listing: false, stopAfterMinutes: 5,
        });
        const page = await get(web.port, '/image.bin');
        assert.strictEqual(page.status, 200);
        assert.ok(page.body.equals(image), 'HTTP serves the file intact');
        assert.strictEqual((await get(web.port, '/nope')).status, 404);
        assert.strictEqual((await get(web.port, '/')).status, 403, 'listing off means listing off');
        for (const escape of ['/../private.txt', '/%2e%2e/private.txt', '/sub/../../private.txt']) {
            const r = await get(web.port, escape);
            assert.ok(r.status === 403 || r.status === 404, `HTTP must refuse ${escape}, got ${r.status}`);
            assert.ok(!r.body.toString().includes('never serve'), `HTTP leaked ${escape}`);
        }
        const viaHttpLink = await get(web.port, '/jump/loot.txt');
        assert.ok(viaHttpLink.status === 403 || viaHttpLink.status === 404,
            `HTTP must refuse the junction escape, got ${viaHttpLink.status}`);
        assert.ok(!viaHttpLink.body.toString().includes('never serve'), 'HTTP leaked through the link');
        field.stop('http');

        // Range: an interrupted firmware pull resumes with a 206 instead
        // of restarting from zero.
        const webAgain = await field.start({
            id: 'http', kind: 'http', root, bind: '127.0.0.1', port: 0,
            listing: false, stopAfterMinutes: 5,
        });
        const whole = await get(webAgain.port, '/image.bin');
        assert.strictEqual(whole.headers && whole.headers['accept-ranges'] || 'bytes', 'bytes');
        const tail = await new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port: webAgain.port, path: '/image.bin',
                headers: { Range: 'bytes=1024-' } }, (res) => {
                const bufs = [];
                res.on('data', (d) => bufs.push(d));
                res.on('end', () => resolve({ status: res.statusCode,
                    range: res.headers['content-range'], body: Buffer.concat(bufs) }));
            }).on('error', reject);
        });
        assert.strictEqual(tail.status, 206, 'a byte range answers 206');
        assert.strictEqual(tail.range, `bytes 1024-${image.length - 1}/${image.length}`);
        assert.ok(tail.body.equals(image.subarray(1024)),
            'the resumed bytes must be exactly the tail of the file');
        const bad = await new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port: webAgain.port, path: '/image.bin',
                headers: { Range: `bytes=${image.length + 5}-` } }, (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode));
            }).on('error', reject);
        });
        assert.strictEqual(bad, 416, 'an unsatisfiable range says so');
        field.stop('http');

        const listed = await field.start({
            id: 'http', kind: 'http', root, bind: '127.0.0.1', port: 0,
            listing: true, stopAfterMinutes: 5,
        });
        const index = await get(listed.port, '/');
        assert.strictEqual(index.status, 200);
        assert.ok(index.body.toString().includes('image.bin'), 'listing shows the folder');
        field.stop('http');

        // --- syslog -------------------------------------------------------
        // PRI decoding is the part worth testing: severity is what a
        // technician filters on, and getting the mask wrong shows every
        // message as emergencies.
        assert.strictEqual(field.parseSyslog('<189>sw1: up').severityName, 'notice',
            '189 = local7.notice');
        assert.strictEqual(field.parseSyslog('<0>meltdown').severityName, 'emerg');
        assert.strictEqual(field.parseSyslog('<191>chatty').severityName, 'debug');
        assert.strictEqual(field.parseSyslog('<189>sw1: up').facility, 23);
        assert.strictEqual(field.parseSyslog('<189>sw1: up').message, 'sw1: up',
            'the PRI is stripped from the message');
        // Not-syslog, and out-of-range PRI, pass through as plain text
        // rather than being dropped - a device sending junk to 514 is
        // something you want to SEE.
        assert.strictEqual(field.parseSyslog('plain line').severity, null);
        assert.strictEqual(field.parseSyslog('plain line').message, 'plain line');
        assert.strictEqual(field.parseSyslog('<999>nonsense').severity, null);

        const sink = await field.start({
            id: 'syslog', kind: 'syslog', bind: '127.0.0.1', port: 0, stopAfterMinutes: 5 });
        assert.ok(sink.port > 0, 'the sink reports its bound port');
        const say = (text) => new Promise((resolve, reject) => {
            const s = dgram.createSocket('udp4');
            s.send(Buffer.from(text), sink.port, '127.0.0.1', (err) => {
                s.close();
                if (err) reject(err); else resolve();
            });
        });
        await say('<189>Aug 25 18:20:01 sw1 %LINK-3-UPDOWN: Gi0/1 up');
        await say('<187>Aug 25 18:20:02 sw1 %SYS-3-CPUHOG: task ran long');
        // A line carrying control bytes must be scrubbed: this buffer goes
        // into the DOM and can be saved to a file.
        await say('<189>bad\x1b[31mline\x07here');
        await new Promise((r) => setTimeout(r, 300));
        const got = field.syslogLines('syslog').lines;
        assert.strictEqual(got.length, 3, `expected 3 messages, got ${got.length}`);
        assert.strictEqual(got[0].severityName, 'notice');
        assert.strictEqual(got[1].severityName, 'err');
        assert.ok(got[0].text.includes('%LINK-3-UPDOWN'), 'the message survives intact');
        assert.ok(!/[\u0000-\u001f\u007f]/.test(got[2].text),
            'control bytes must be scrubbed out of syslog text');
        assert.ok(got[2].text.includes('badline') || got[2].text.includes('bad '),
            `the readable part survives, got ${JSON.stringify(got[2].text)}`);
        assert.strictEqual(got[0].from, '127.0.0.1');
        field.stop('syslog');
        assert.deepStrictEqual(field.syslogLines('syslog').lines, [],
            'a stopped sink keeps nothing');

        // --- Wake on LAN ------------------------------------------------
        // Catch the packet on a local socket and check the bytes: six 0xFF
        // then the MAC sixteen times.
        const catcher = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        const caught = new Promise((resolve) => catcher.on('message', resolve));
        await new Promise((r) => catcher.bind(0, '127.0.0.1', r));
        await field.wake('00:11:22:33:44:55', '127.0.0.1', catcher.address().port);
        const packet = await caught;
        catcher.close();
        assert.strictEqual(packet.length, 102, 'a magic packet is 6 + 16*6 bytes');
        assert.ok(packet.subarray(0, 6).equals(Buffer.alloc(6, 0xff)), 'it opens with six 0xFF');
        const mac = Buffer.from('001122334455', 'hex');
        for (let i = 0; i < 16; i++) {
            assert.ok(packet.subarray(6 + i * 6, 12 + i * 6).equals(mac), `repetition ${i + 1} is the MAC`);
        }
        await assert.rejects(() => field.wake('nonsense', '127.0.0.1', 9), /MAC address/,
            'a malformed MAC is refused with a readable message');

        // --- lifecycle ---------------------------------------------------
        assert.deepStrictEqual(field.list(), [], 'everything stopped is everything stopped');
        const t = await field.start({ id: 'tftp', kind: 'tftp', root, bind: '127.0.0.1', port: 0,
            stopAfterMinutes: 5 });
        assert.strictEqual(field.list().length, 1);
        assert.ok(field.list()[0].stopsAt > Date.now(), 'every server carries a deadline');
        await assert.rejects(() => field.start({ id: 'tftp', kind: 'tftp', root, bind: '127.0.0.1',
            port: 0, stopAfterMinutes: 5 }), /already running/);
        field.stopAll();
        assert.deepStrictEqual(field.list(), [], 'stopAll stops all');
        void t;

        console.log('ok - field servers (tftp read/write + blksize/tsize + junction escape + ' +
            'WRQ truncate guard + size cap + stop-kills-transfers + TID + netascii refusal, ' +
            'http incl. ranges, syslog PRI + scrubbing, wol packet, ' +
            'and every path outside the folder refused)');
        process.exit(0);
    } catch (err) {
        console.error('FAIL -', err.message);
        process.exit(1);
    } finally {
        try { field.stopAll(); } catch (_) { /* already stopped */ }
        fs.rmSync(box, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
})();
