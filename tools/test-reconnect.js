'use strict';
// Reconnect and dead-session behavior, against the real fixture device.
//
// What is proven here, and what is not:
//   1. close fires exactly once per transport. The UI writes its
//      "press R to reconnect" hint on that edge, so a duplicate close would
//      print it twice, and reconnect bookkeeping keys off it.
//   2. A dead session dials again and works - what the R key does.
//   3. Writing after close does not raise. This one is a canary on ssh2 and
//      net.Socket rather than a test of our guards: both currently drop such
//      writes on their own, so it passes with the guards removed. It is kept
//      because if a dependency ever starts throwing there, the failure would
//      otherwise show up as the engine dying under someone's fingers.

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const { SshTransport } = require('../engine/transports/ssh');
const { TelnetTransport } = require('../engine/transports/telnet');

const SSH_PORT = 2297;
const TELNET_PORT = 2296;

function startFixture(script, port, name) {
    const proc = spawn(process.execPath, [path.join(__dirname, script), String(port), name],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise((resolve, reject) => {
        proc.stdout.on('data', (d) => { if (/listening/.test(d.toString())) resolve(proc); });
        proc.stderr.on('data', (d) => reject(new Error(d.toString())));
        setTimeout(() => reject(new Error(`${script} did not start`)), 8000);
    });
}

function waitFor(emitter, event, ms = 8000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
        emitter.once(event, (v) => { clearTimeout(t); resolve(v); });
    });
}

(async () => {
    const sshFixture = await startFixture('test-ssh-server.js', SSH_PORT, 'reconnect-sw');
    const telnetFixture = await startFixture('test-telnet-server.js', TELNET_PORT, 'reconnect-tel');

    // Any unhandled error anywhere is the failure this test exists to catch.
    process.on('uncaughtException', (err) => {
        console.error('FAIL - unhandled error after disconnect:', err.message);
        sshFixture.kill(); telnetFixture.kill();
        process.exit(1);
    });

    try {
        // --- SSH: one close, and input after it is harmless ----------------
        const ssh = new SshTransport();
        let sshCloses = 0;
        ssh.on('close', () => { sshCloses++; });
        const closed = waitFor(ssh, 'close');
        await ssh.connect({ host: '127.0.0.1', port: SSH_PORT, cols: 80, rows: 24 },
            { username: 'nettest', password: 'nettest' },
            { verifyHostkey: () => Promise.resolve(true) });
        ssh.write('exit\r');          // the device hangs up on this
        await closed;
        await new Promise((r) => setTimeout(r, 400));
        assert.strictEqual(sshCloses, 1,
            `close must fire exactly once per session, saw ${sshCloses}`);

        // Keystrokes after death: the pane is still focused and still
        // receiving input until the user closes or reconnects it.
        for (let i = 0; i < 20; i++) ssh.write('\r');
        ssh.write('show version\r');
        await new Promise((r) => setTimeout(r, 300));
        assert.ok(true, 'writing to a dead SSH session did not raise');

        // Closing an already-dead transport is also safe, and still must not
        // produce a second close event.
        await ssh.close();
        await new Promise((r) => setTimeout(r, 300));
        assert.strictEqual(sshCloses, 1, 'closing a dead session must not re-fire close');

        // --- a failed connect closes exactly once --------------------------
        // This is the path where close can double-fire: the failure reports
        // it, and then ssh2's own close event arrives behind it. The UI
        // prints its reconnect hint on that edge, and a bulk connect counts
        // it, so twice is not cosmetic.
        const bad = new SshTransport();
        let badCloses = 0;
        bad.on('close', () => { badCloses++; });
        await bad.connect({ host: '127.0.0.1', port: SSH_PORT, cols: 80, rows: 24 },
            { username: 'nettest', password: 'wrong-password' },
            { verifyHostkey: () => Promise.resolve(true) })
            .then(() => { throw new Error('expected the auth to be refused'); },
                (err) => { assert.ok(err.isAuthFailure, 'auth failure should be flagged as such'); });
        await new Promise((r) => setTimeout(r, 600));
        assert.strictEqual(badCloses, 1,
            `a failed connect must close exactly once, saw ${badCloses}`);

        // --- reconnect: the same target dials again -----------------------
        const again = new SshTransport();
        const banner = new Promise((resolve) => {
            let seen = '';
            again.on('data', (b) => {
                seen += b.toString();
                if (seen.includes('#')) resolve(seen);
            });
        });
        await again.connect({ host: '127.0.0.1', port: SSH_PORT, cols: 80, rows: 24 },
            { username: 'nettest', password: 'nettest' },
            { verifyHostkey: () => Promise.resolve(true) });
        const text = await banner;
        assert.ok(text.includes('reconnect-sw'), 'reconnected session is usable');
        await again.close();

        // --- telnet: same guard -------------------------------------------
        const tel = new TelnetTransport();
        const telClosed = waitFor(tel, 'close');
        await tel.connect({ host: '127.0.0.1', port: TELNET_PORT, cols: 80, rows: 24 }, {});
        tel.write('exit\r');
        await telClosed;
        for (let i = 0; i < 20; i++) tel.write('\r');
        await new Promise((r) => setTimeout(r, 300));
        assert.ok(true, 'writing to a dead telnet session did not raise');
        await tel.close();

        // --- telnet: a mid-session RESET is an error, not a clean exit ----
        // The close handler used to overwrite the error status and emit
        // code 0 "connection closed" - the UI lost the reason at the one
        // moment it mattered. A local server that resets the socket (RST,
        // via resetAndDestroy) reproduces the ECONNRESET ordering exactly.
        const rstServer = require('net').createServer((sock) => {
            sock.write('welcome' + String.fromCharCode(13, 10));
            setTimeout(() => sock.resetAndDestroy(), 150);
        });
        await new Promise((r) => rstServer.listen(0, '127.0.0.1', r));
        const tel2 = new TelnetTransport();
        const closeArgs = new Promise((resolve) => tel2.on('close', (info) => resolve(info)));
        const statuses = [];
        tel2.on('status', (st) => statuses.push(st.state));
        await tel2.connect({ host: '127.0.0.1',
            port: rstServer.address().port, cols: 80, rows: 24 }, {});
        const ended = await closeArgs;
        rstServer.close();
        assert.strictEqual(ended.code, 1,
            `a reset mid-session must close with code 1, got ${ended.code} (${ended.reason})`);
        assert.ok(/ECONNRESET|reset/i.test(ended.reason || ''),
            `the close reason must carry the error, got '${ended.reason}'`);
        assert.ok(!statuses.includes('closed'),
            'the error status must not be overwritten by a clean-exit status');

        console.log('ok - reconnect (write-after-close is safe on ssh and telnet, ' +
            'redial works, telnet reset reports as an error)');
    } finally {
        sshFixture.kill();
        telnetFixture.kill();
    }
})().catch((err) => { console.error('FAIL -', err.stack || err.message); process.exit(1); });
