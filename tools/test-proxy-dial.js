'use strict';
// Outbound proxy dialing: SOCKS5 and HTTP CONNECT, against mini proxies
// this file runs itself.
//
// The test that matters most: the target here talks FIRST (like an SSH
// server sending its banner), and both mini proxies deliberately coalesce
// their success reply and the target's first bytes into ONE TCP write -
// the segment layout that loses the banner if the dialer drops what it
// over-read. A dialer that fails this hangs real SSH handshakes forever,
// intermittently, depending on timing. Deterministic here.

const assert = require('assert');
const net = require('net');
const { dial, parseProxy } = require('../engine/proxy-dial');

const BANNER = 'BANNER-HELLO\r\n';
const servers = [];
const liveSockets = new Set();

function listen(server) {
    servers.push(server);
    // Piped tunnel sockets do not propagate closes here, so the test tracks
    // every accepted connection and destroys them at the end - otherwise a
    // passed run sits in the event loop forever.
    server.on('connection', (s) => {
        liveSockets.add(s);
        s.on('close', () => liveSockets.delete(s));
    });
    return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

// Target: sends a banner immediately, then echoes.
function startTarget() {
    return listen(net.createServer((c) => {
        c.write(BANNER);
        c.on('data', (d) => c.write(d));
        c.on('error', () => {});
    }));
}

// Mini SOCKS5 proxy. `mode` twists it: 'refuse' answers REP=5,
// 'authwall' demands credentials, 'mute' never answers the greeting.
function startSocks(targetPort, mode, seen) {
    return listen(net.createServer((c) => {
        c.on('error', () => {});
        let buf = Buffer.alloc(0);
        let phase = 'greet';
        c.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (phase === 'greet') {
                if (mode === 'mute') return;
                if (buf.length < 2 + buf[1]) return;
                buf = buf.slice(2 + buf[1]);
                phase = 'request';
                c.write(Buffer.from([5, mode === 'authwall' ? 0xFF : 0]));
                if (mode === 'authwall') return;
            }
            if (phase === 'request') {
                if (buf.length < 4) return;
                const atyp = buf[3];
                const alen = atyp === 1 ? 4 : atyp === 3 ? 1 + buf[4] : 16;
                if (buf.length < 4 + alen + 2) return;
                if (seen) seen.atyp = atyp;
                phase = 'open';
                if (mode === 'refuse') {
                    c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
                    return;
                }
                const out = net.connect(targetPort, '127.0.0.1');
                out.on('error', () => c.destroy());
                // The coalescing trick: hold the success reply until the
                // target's first bytes exist, then send both in ONE write.
                out.once('data', (first) => {
                    c.write(Buffer.concat([
                        Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]), first]));
                    out.on('data', (d) => c.write(d));
                    c.on('data', (d) => out.write(d));
                });
            }
        });
    }));
}

// Mini HTTP CONNECT proxy, same coalescing trick; 'refuse' answers 403.
function startHttpProxy(targetPort, mode) {
    return listen(net.createServer((c) => {
        c.on('error', () => {});
        let head = Buffer.alloc(0);
        const onData = (d) => {
            head = Buffer.concat([head, d]);
            if (head.indexOf('\r\n\r\n') === -1) return;
            c.removeListener('data', onData);
            if (mode === 'refuse') {
                c.end('HTTP/1.1 403 Forbidden\r\n\r\n');
                return;
            }
            const out = net.connect(targetPort, '127.0.0.1');
            out.on('error', () => c.destroy());
            out.once('data', (first) => {
                c.write(Buffer.concat([
                    Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'), first]));
                out.on('data', (d) => c.write(d));
                c.on('data', (d) => out.write(d));
            });
        };
        c.on('data', onData);
    }));
}

// Drive one dialed socket through the banner-then-echo conversation.
function converse(sock) {
    return new Promise((resolve, reject) => {
        let got = '';
        const deadline = setTimeout(() =>
            reject(new Error(`conversation stalled - received only ${JSON.stringify(got)}`)), 3000);
        sock.on('data', (d) => {
            got += d.toString();
            if (got === BANNER) sock.write('ping');
            if (got === BANNER + 'ping') {
                clearTimeout(deadline);
                sock.destroy();
                resolve(got);
            }
        });
        sock.on('error', (e) => { clearTimeout(deadline); reject(e); });
    });
}

(async () => {
    try {
        // --- address parsing -------------------------------------------------
        assert.deepStrictEqual(parseProxy('socks5://gw.corp:1080'),
            { kind: 'socks5', host: 'gw.corp', port: 1080 });
        assert.deepStrictEqual(parseProxy('http://10.1.1.1:3128/'),
            { kind: 'http', host: '10.1.1.1', port: 3128 });
        assert.throws(() => parseProxy('socks4://x:1080'), /not a usable proxy/);
        assert.throws(() => parseProxy('socks5://x:99999'), /not a usable proxy/);
        assert.throws(() => parseProxy('gw.corp:1080'), /not a usable proxy/);

        const targetPort = await startTarget();

        // --- SOCKS5: banner survives the coalesced segment -------------------
        const seen = {};
        const socksPort = await startSocks(targetPort, 'ok', seen);
        const s1 = await dial(`socks5://127.0.0.1:${socksPort}`, '127.0.0.1', targetPort, 3000);
        assert.strictEqual(await converse(s1), BANNER + 'ping',
            'every server-first byte arrives, echo works');
        assert.strictEqual(seen.atyp, 1, 'an IPv4 literal goes as ATYP 1');

        // Hostnames go as domains, so DNS happens at the proxy.
        const s2 = await dial(`socks5://127.0.0.1:${socksPort}`, 'localhost', targetPort, 3000);
        await converse(s2);
        assert.strictEqual(seen.atyp, 3, 'a hostname goes as ATYP 3, unresolved');

        // --- HTTP CONNECT: same property -------------------------------------
        const httpPort = await startHttpProxy(targetPort, 'ok');
        const s3 = await dial(`http://127.0.0.1:${httpPort}`, '127.0.0.1', targetPort, 3000);
        assert.strictEqual(await converse(s3), BANNER + 'ping');

        // --- refusals say who refused what ------------------------------------
        const refusePort = await startSocks(targetPort, 'refuse');
        await assert.rejects(
            () => dial(`socks5://127.0.0.1:${refusePort}`, '127.0.0.1', targetPort, 3000),
            /target refused/);
        const wallPort = await startSocks(targetPort, 'authwall');
        await assert.rejects(
            () => dial(`socks5://127.0.0.1:${wallPort}`, '127.0.0.1', targetPort, 3000),
            /requires authentication/);
        const badHttpPort = await startHttpProxy(targetPort, 'refuse');
        await assert.rejects(
            () => dial(`http://127.0.0.1:${badHttpPort}`, '127.0.0.1', targetPort, 3000),
            /refused CONNECT: 403/);

        // --- a proxy that never answers hits the deadline ---------------------
        const mutePort = await startSocks(targetPort, 'mute');
        await assert.rejects(
            () => dial(`socks5://127.0.0.1:${mutePort}`, '127.0.0.1', targetPort, 500),
            /did not finish in time/);

        console.log('ok - proxy dial (socks5 + http connect, coalesced-banner survival, ' +
            'atyp encoding, refusal/authwall/deadline messages)');
    } finally {
        for (const s of servers) s.close();
        for (const s of liveSockets) s.destroy();
    }
})().catch((err) => { console.error('FAIL -', err.stack || err.message); process.exit(1); });
