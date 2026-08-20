'use strict';
// Opening a file channel on a session that is still connecting.
//
// This is a regression test for a real failure: the file browser rebinds the
// moment a reconnect creates its session, and asking that half-open client
// for an SFTP channel wrote a channel-open into the middle of key exchange.
// The server answered "Bad packet length" and dropped the connection, so the
// reconnect failed - intermittently, depending on which won the race.
//
// The property under test is not the error message. It is that a file
// request during the handshake cannot damage the handshake.

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const { SshTransport } = require('../engine/transports/ssh');
const sftp = require('../engine/sftp');

const PORT = 2294;

function startFixture() {
    const proc = spawn(process.execPath,
        [path.join(__dirname, 'test-ssh-server.js'), String(PORT), 'race-sw'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise((resolve, reject) => {
        proc.stdout.on('data', (d) => { if (/listening/.test(d.toString())) resolve(proc); });
        proc.stderr.on('data', (d) => reject(new Error(d.toString())));
        setTimeout(() => reject(new Error('fixture did not start')), 8000);
    });
}

(async () => {
    const fixture = await startFixture();
    const transport = new SshTransport();
    const session = { id: 'race-1', transport };

    try {
        // Start connecting, and hit it with file requests immediately - the
        // window the file browser used to land in.
        const connecting = transport.connect(
            { host: '127.0.0.1', port: PORT, cols: 80, rows: 24 },
            { username: 'nettest', password: 'nettest' },
            { verifyHostkey: () => new Promise((r) => setTimeout(() => r(true), 40)) });

        const early = await sftp.run(session, { op: 'mode' }, () => {});
        assert.strictEqual(early.mode, 'pending',
            'a mode request during the handshake must answer "pending", not probe');

        await assert.rejects(
            sftp.run(session, { op: 'list', path: '/' }, () => {}),
            /still connecting/,
            'a listing during the handshake must be refused, not attempted');

        // The handshake must have survived all of that.
        await connecting;
        assert.strictEqual(transport.state, 'connected',
            'the connection must survive file requests made while it was opening');

        // And once up, the same calls work.
        const ready = await sftp.run(session, { op: 'mode' }, () => {});
        assert.strictEqual(ready.mode, 'sftp', `expected sftp once connected, got ${ready.mode}`);
        const listing = await sftp.run(session, { op: 'list', path: '/' }, () => {});
        assert.ok(listing.entries.length > 0, 'listing works once connected');

        // "pending" must not have been cached as the device's capability.
        sftp.drop(session.id);
        const again = await sftp.run(session, { op: 'mode' }, () => {});
        assert.strictEqual(again.mode, 'sftp', 'a pending answer must not be remembered');

        console.log('ok - sftp race (file requests during a handshake cannot break it)');
    } finally {
        try { await transport.close(); } catch (_) { /* already down */ }
        fixture.kill();
    }
})().catch((err) => { console.error('FAIL -', err.stack || err.message); process.exit(1); });
