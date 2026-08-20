'use strict';
// Wire-level proof of the AD-lockout promise: a stale password must cost
// exactly ONE backend authentication attempt. The dangerous case is gear
// that offers both 'password' and 'keyboard-interactive' (AD/TACACS behind
// sshd does): after the password method is rejected, the transport must NOT
// fall through to keyboard-interactive and answer with the same password -
// that would be a second lockout strike per connect.
//
// The counter lives in the server because that is where the strikes land.

const assert = require('assert');
const crypto = require('crypto');
const { Server } = require('ssh2');
const { SshTransport } = require('../engine/transports/ssh');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const hostKey = privateKey.export({ type: 'pkcs1', format: 'pem' });

// A minimal sshd stand-in. `mode` controls the auth backend:
//   'both'    - password and KI both enabled, backend checks the credential
//   'ki-only' - password method disabled (rejected without a backend check),
//               KI enabled - how PasswordAuthentication=no gear behaves
function startServer(mode, counts) {
    return new Promise((resolve) => {
        const server = new Server({ hostKeys: [hostKey] }, (client) => {
            client.on('error', () => { /* client gave up; the test asserts why */ });
            client.on('authentication', (ctx) => {
                if (ctx.method === 'password') {
                    if (mode === 'ki-only') {
                        // Method refused outright: no backend attempt burned,
                        // and the continue-list does not offer password.
                        return ctx.reject(['keyboard-interactive']);
                    }
                    counts.password++;
                    if (ctx.password === 'right') return ctx.accept();
                    return ctx.reject(['password', 'keyboard-interactive']);
                }
                if (ctx.method === 'keyboard-interactive') {
                    counts.ki++;
                    return ctx.prompt([{ prompt: 'Password:', echo: false }], (answers) => {
                        if (answers && answers[0] === 'right') return ctx.accept();
                        ctx.reject(mode === 'ki-only'
                            ? ['keyboard-interactive'] : ['password', 'keyboard-interactive']);
                    });
                }
                return ctx.reject(mode === 'ki-only'
                    ? ['keyboard-interactive'] : ['password', 'keyboard-interactive']);
            });
            client.on('ready', () => {
                client.on('session', (accept) => {
                    const session = accept();
                    session.on('pty', (a) => a && a());
                    session.on('shell', (a) => a());
                });
            });
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function dial(port, password) {
    const t = new SshTransport();
    try {
        await t.connect({ host: '127.0.0.1', port, timeoutMs: 5000 },
            { username: 'nettest', password });
        return { t, ok: true };
    } catch (err) {
        return { t, ok: false, err };
    }
}

(async () => {
    // 1. Wrong password against gear offering password + KI: exactly one
    // backend attempt, zero KI attempts, surfaced as an auth failure.
    {
        const counts = { password: 0, ki: 0 };
        const server = await startServer('both', counts);
        const { ok, err } = await dial(server.address().port, 'wrong');
        assert.strictEqual(ok, false, 'wrong password must fail the connect');
        assert.strictEqual(err.isAuthFailure, true, 'must be flagged as an auth failure');
        assert.strictEqual(counts.password, 1, `one wire attempt, got ${counts.password}`);
        assert.strictEqual(counts.ki, 0,
            `KI must not be fed a rejected password, got ${counts.ki} KI attempts`);
        server.close();
    }

    // 2. Right password, same gear: connects, still exactly one attempt.
    {
        const counts = { password: 0, ki: 0 };
        const server = await startServer('both', counts);
        const { t, ok } = await dial(server.address().port, 'right');
        assert.strictEqual(ok, true, 'correct password must connect');
        assert.strictEqual(counts.password, 1);
        assert.strictEqual(counts.ki, 0);
        await t.close();
        server.close();
    }

    // 3. KI-only gear (password method disabled): the method-level refusal
    // burned nothing, so falling through to KI with the stored password is
    // required - this is how Cisco TACACS boxes take passwords at all.
    {
        const counts = { password: 0, ki: 0 };
        const server = await startServer('ki-only', counts);
        const { t, ok } = await dial(server.address().port, 'right');
        assert.strictEqual(ok, true, 'KI-only gear must still accept the stored password');
        assert.strictEqual(counts.password, 0, 'password method was refused, not attempted');
        assert.strictEqual(counts.ki, 1, `one KI attempt, got ${counts.ki}`);
        await t.close();
        server.close();
    }

    // 4. Event ORDER on a failed connect: main must receive the verdict
    // ('connect-failed', which trips the auth guard) before the funeral
    // ('closed', which sweeps the canary and releases its queue). The
    // reverse order would release a batch the guard was about to halt.
    {
        const { Session } = require('../engine/session');
        const counts = { password: 0, ki: 0 };
        const server = await startServer('both', counts);
        const events = [];
        const session = new Session('s-test',
            { transport: 'ssh', host: '127.0.0.1', port: server.address().port, timeoutMs: 5000 },
            (m) => events.push(m.t), { verifyHostkey: () => Promise.resolve(true) });
        await session.connect({ username: 'nettest', password: 'wrong' });
        await new Promise((r) => setTimeout(r, 200));
        const failedAt = events.indexOf('connect-failed');
        const closedAt = events.indexOf('closed');
        assert.ok(failedAt !== -1 && closedAt !== -1, `expected both events, got ${events}`);
        assert.ok(failedAt < closedAt,
            `connect-failed must precede closed, got ${events}`);
        server.close();
    }

    console.log('ok - ssh auth attempts (wrong password = 1 wire attempt, KI-only fallthrough, event order)');
    process.exit(0);
})().catch((err) => {
    console.error('FAIL -', err.message);
    process.exit(1);
});
