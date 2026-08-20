'use strict';
// Port forwarding, end to end against the real fixture SSH server: bytes
// actually traverse a local forward and a SOCKS5 proxy, the byte counters
// the UI shows are real, closing frees the listener, and - the property
// that makes tunnels worth putting in this app - two tunnels through one
// endpoint SHARE its pooled SSH connection instead of authenticating twice.
//
// Remote (-R) forwarding is not covered here: the fixture server does not
// implement tcpip-forward, and a fake one would test the fake.

const assert = require('assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const tunnels = require('../engine/tunnels');
const hopPool = require('../engine/hop-pool');

const SSH_PORT = 2261;

const helpers = {
    authFor: () => ({ username: 'nettest', password: 'nettest' }),
    verifyHostkey: () => Promise.resolve(true),
};
const endpoint = { host: '127.0.0.1', port: SSH_PORT, credentialProfile: 'lab' };
const noEvents = () => {};

function startFixture() {
    const proc = spawn(process.execPath,
        [path.join(__dirname, 'test-ssh-server.js'), String(SSH_PORT), 'tunnel-sw'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise((resolve, reject) => {
        proc.stdout.on('data', (d) => { if (/listening/.test(d.toString())) resolve(proc); });
        proc.stderr.on('data', (d) => reject(new Error(d.toString())));
        setTimeout(() => reject(new Error('ssh fixture did not start')), 8000);
    });
}

// The "device" behind the tunnel: uppercases whatever it receives, so a
// round trip proves data moved in both directions rather than just that a
// socket opened.
function startTarget() {
    return new Promise((resolve) => {
        const server = net.createServer((sock) => {
            sock.on('data', (d) => sock.write(d.toString().toUpperCase()));
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function roundTrip(port, text) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1');
        let got = '';
        const timer = setTimeout(() => { sock.destroy(); reject(new Error('round trip timed out')); }, 5000);
        sock.on('connect', () => sock.write(text));
        sock.on('data', (d) => {
            got += d.toString();
            if (got.length >= text.length) {
                clearTimeout(timer);
                sock.end();
                resolve(got);
            }
        });
        sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
}

// Minimal SOCKS5 client: greet, CONNECT to host:port, then talk.
function socksRoundTrip(proxyPort, destPort, text) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(proxyPort, '127.0.0.1');
        let stage = 'greet';
        let got = '';
        const timer = setTimeout(() => { sock.destroy(); reject(new Error('socks round trip timed out')); }, 5000);
        sock.on('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
        sock.on('data', (d) => {
            if (stage === 'greet') {
                assert.strictEqual(d[0], 0x05, 'socks version in the method reply');
                assert.strictEqual(d[1], 0x00, 'no-auth method selected');
                stage = 'reply';
                const req = Buffer.alloc(10);
                req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x01;
                req[4] = 127; req[5] = 0; req[6] = 0; req[7] = 1;
                req.writeUInt16BE(destPort, 8);
                sock.write(req);
                return;
            }
            if (stage === 'reply') {
                assert.strictEqual(d[1], 0x00, `socks CONNECT refused (code ${d[1]})`);
                stage = 'data';
                sock.write(text);
                // A reply and payload can arrive coalesced.
                if (d.length > 10) got += d.subarray(10).toString();
                return;
            }
            got += d.toString();
            if (got.length >= text.length) {
                clearTimeout(timer);
                sock.end();
                resolve(got);
            }
        });
        sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
}

const refused = (port) => new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.on('connect', () => { sock.destroy(); resolve(false); });
    sock.on('error', () => resolve(true));
});

(async () => {
    const ssh = await startFixture();
    const target = await startTarget();
    const targetPort = target.address().port;

    try {
        // 1. Local forward: bytes make the full round trip through SSH.
        const local = await tunnels.open({
            id: 't-local', kind: 'local', chain: [endpoint],
            bindHost: '127.0.0.1', bindPort: 0,
            destHost: '127.0.0.1', destPort: targetPort,
        }, helpers, noEvents);
        assert.strictEqual(local.state, 'open');
        assert.ok(local.bindPort > 0, 'an ephemeral listen port is reported back');

        assert.strictEqual(await roundTrip(local.bindPort, 'hello tunnel'), 'HELLO TUNNEL',
            'data crosses the local forward in both directions');

        const afterOne = tunnels.status('t-local');
        assert.strictEqual(afterOne.conns, 1, 'one connection counted');
        assert.ok(afterOne.bytesUp >= 12 && afterOne.bytesDown >= 12,
            `byte counters must be real, got up=${afterOne.bytesUp} down=${afterOne.bytesDown}`);

        // 2. A second tunnel to the same endpoint SHARES the pooled SSH
        // connection - the whole reason tunnels live in this app. Two refs,
        // one pool entry, one authentication.
        const socks = await tunnels.open({
            id: 't-socks', kind: 'dynamic', chain: [endpoint],
            bindHost: '127.0.0.1', bindPort: 0,
        }, helpers, noEvents);
        const stats = hopPool.stats();
        assert.strictEqual(Object.keys(stats).length, 1, 'both tunnels ride ONE pooled connection');
        assert.strictEqual(Object.values(stats)[0], 2, 'that connection carries two refs');

        // 3. SOCKS5: the proxy resolves and dials the destination far-side.
        assert.strictEqual(await socksRoundTrip(socks.bindPort, targetPort, 'via socks'), 'VIA SOCKS',
            'data crosses the SOCKS proxy');
        assert.strictEqual(tunnels.list().length, 2, 'both tunnels listed as open');

        // 4. Closing one frees its listener and its ref; the other lives on.
        tunnels.close('t-local');
        assert.ok(await refused(local.bindPort), 'the closed listener stops accepting');
        assert.strictEqual(Object.values(hopPool.stats())[0], 1, 'the surviving tunnel keeps one ref');
        assert.strictEqual(await socksRoundTrip(socks.bindPort, targetPort, 'still up'), 'STILL UP',
            'closing one tunnel must not disturb another on the same connection');

        // 4b. Open/close cycles must not accumulate listeners on the
        // SHARED pooled client. Anonymous handlers used to survive
        // close(), so a day of tunnel churn on one bastion connection
        // grew the listener list without bound.
        const probe = await hopPool.acquire([endpoint], helpers);
        const baseClose = probe.client.listenerCount('close');
        const baseTcp = probe.client.listenerCount('tcp connection');
        for (let i = 0; i < 5; i++) {
            await tunnels.open({
                id: 't-cycle', kind: 'local', chain: [endpoint],
                bindHost: '127.0.0.1', bindPort: 0,
                destHost: '127.0.0.1', destPort: targetPort,
            }, helpers, noEvents);
            tunnels.close('t-cycle');
        }
        assert.strictEqual(probe.client.listenerCount('close'), baseClose,
            'closing a tunnel must remove its close listener from the pooled client');
        assert.strictEqual(probe.client.listenerCount('tcp connection'), baseTcp,
            'closing a tunnel must remove its tcp-connection listener from the pooled client');
        probe.release();

        // 5. Closing the last one drains the pool: no gateway is left dialed.
        tunnels.close('t-socks');
        assert.ok(await refused(socks.bindPort), 'the socks listener stops accepting');
        assert.deepStrictEqual(tunnels.list(), [], 'no tunnels remain');
        for (let i = 0; i < 30 && Object.keys(hopPool.stats()).length; i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.deepStrictEqual(hopPool.stats(), {}, 'the pool drains when the last tunnel closes');

        console.log('ok - tunnels (local forward, SOCKS5, shared pooled connection, listener hygiene, clean teardown)');
        process.exit(0);
    } finally {
        ssh.kill();
        target.close();
    }
})().catch((err) => {
    console.error('FAIL -', err.message);
    process.exit(1);
});
