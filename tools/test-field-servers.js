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

        const listed = await field.start({
            id: 'http', kind: 'http', root, bind: '127.0.0.1', port: 0,
            listing: true, stopAfterMinutes: 5,
        });
        const index = await get(listed.port, '/');
        assert.strictEqual(index.status, 200);
        assert.ok(index.body.toString().includes('image.bin'), 'listing shows the folder');
        field.stop('http');

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
            'WRQ truncate guard + size cap + stop-kills-transfers, http, wol packet, ' +
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
