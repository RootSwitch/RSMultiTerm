'use strict';
// SHA-1 key exchange for classic Cisco IOS, against real ssh2 servers
// shaped like the gear. IOSv 15.9 (CML) offers exactly what `sh ip ssh`
// lists below, under the ident "Cisco-1.25"; out of the box the app offered
// nothing it had, and the device logged %SSH-3-NO_MATCH.
//
//   1. With the setting on (the default), an IOSv-shaped device connects
//      over diffie-hellman-group14-sha1, and the session says so: a status
//      detail and a one-time notice for the pane.
//   2. SHA-1 is offered LAST. A server that has both a modern method and
//      SHA-1 gets the modern one, and the session says nothing.
//   3. The offer, as a server sees it: ssh2's own list, then
//      group14-sha1 and group-exchange-sha1, and never group1-sha1 (1024
//      bits). (ssh2's server has no group exchange, so that method is not
//      dialed here; ssh2 also drops it for Cisco, where group14 decides.)
//   4. A device with only group1-sha1 is refused, and the failure names
//      what it offered.
//   5. Setting off: modern methods only. The IOSv device is refused, and
//      the error lists its methods and points at the setting.
//   6. A jump host is held to the same list: an IOSv-shaped gateway in
//      front of a modern target connects, and the notice names the gateway.
//   7. Errors that are not a mismatch are left alone.

const assert = require('assert');
const crypto = require('crypto');
const net = require('net');
const { Server } = require('ssh2');
const C = require('ssh2/lib/protocol/constants.js');
const { SshTransport } = require('../engine/transports/ssh');
const sshAlgorithms = require('../engine/ssh-algorithms');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const hostKey = privateKey.export({ type: 'pkcs1', format: 'pem' });

const IOSV = {
    ident: 'Cisco-1.25',
    algorithms: {
        kex: ['diffie-hellman-group-exchange-sha1', 'diffie-hellman-group14-sha1'],
        serverHostKey: ['ssh-rsa'],
        cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr'],
        hmac: ['hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1', 'hmac-sha1-96'],
    },
};

// A device: password 'cisco', a shell that prints a prompt, and direct-tcpip
// so it can stand in as a jump host.
function startServer(opts = {}) {
    return new Promise((resolve) => {
        const server = new Server({ hostKeys: [hostKey], ...opts }, (client) => {
            client.on('error', () => { /* the client gave up; the test asserts why */ });
            client.on('authentication', (ctx) => {
                if (ctx.method === 'password' && ctx.password === 'cisco') return ctx.accept();
                return ctx.reject(['password']);
            });
            client.on('ready', () => {
                client.on('session', (accept) => {
                    const session = accept();
                    session.on('pty', (ok) => ok && ok());
                    session.on('shell', (ok) => { const ch = ok(); ch.write('IOSv-2#'); });
                });
                client.on('tcpip', (accept, reject, info) => {
                    const sock = net.connect(info.destPort, info.destIP, () => {
                        const ch = accept();
                        ch.pipe(sock).pipe(ch);
                    });
                    sock.on('error', () => reject());
                });
            });
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

const helpers = {
    verifyHostkey: () => Promise.resolve(true),
    authFor: () => ({ username: 'cisco', password: 'cisco' }),
};

// Connect, collect every status, close. Resolves {ok, error, statuses, kex}.
async function dial(port, extra = {}) {
    const t = new SshTransport();
    const statuses = [];
    t.on('status', (s) => statuses.push(s));
    let error = null;
    try {
        await t.connect({ host: '127.0.0.1', port, ...extra },
            { username: 'cisco', password: 'cisco' }, helpers);
    } catch (err) {
        error = err.message;
    }
    await t.close().catch(() => {});
    if (t._hop) t._hop.release();
    const connected = statuses.find((s) => s.state === 'connected');
    return { ok: !error, error, connected, kex: t.kex };
}

let failures = 0;
function check(name, cond, detail) {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
    if (!cond) failures++;
}

(async () => {
    const iosv = await startServer(IOSV);
    // Modern, but SHA-1 also allowed: the client's order decides, so this
    // catches a list that PREPENDS SHA-1 instead of appending it.
    const modern = await startServer({
        algorithms: { kex: [...C.DEFAULT_KEX, 'diffie-hellman-group14-sha1'] },
    });
    // Not Cisco, so ssh2 sends its whole list; the server's debug stream
    // records what arrived.
    let offered = null;
    const group1Only = await startServer({
        algorithms: { kex: ['diffie-hellman-group1-sha1'] },
        debug: (line) => {
            // The server's lines carry a "[timestamp] " prefix.
            const m = /Handshake: \(remote\) KEX method: (.*)$/.exec(line);
            if (m) offered = m[1].split(',').filter((n) => !/^ext-info-|^kex-strict-/.test(n));
        },
    });
    const sha1 = (list) => (list || []).filter((n) => /-sha1$/.test(n));
    try {
        console.log('legacy key exchange on (the default)');
        sshAlgorithms.configure({ legacyKex: true });
        {
            const r = await dial(iosv.address().port);
            check('an IOSv-shaped device connects', r.ok, r.error || r.kex);
            check('over diffie-hellman-group14-sha1', r.kex === 'diffie-hellman-group14-sha1', r.kex);
            check('the status says legacy key exchange',
                r.connected && r.connected.detail === 'legacy key exchange (SHA-1)',
                r.connected && r.connected.detail);
            check('the pane notice names the method',
                r.connected && /legacy key exchange: diffie-hellman-group14-sha1/.test(r.connected.notice || ''),
                r.connected && r.connected.notice);
        }
        {
            const r = await dial(modern.address().port);
            check('a modern device still gets a modern key exchange',
                r.ok && /^curve25519/.test(r.kex || ''), r.error || r.kex);
            check('and no notice', r.connected && !r.connected.detail && !r.connected.notice,
                r.connected && JSON.stringify(r.connected));
        }
        {
            offered = null;
            const r = await dial(group1Only.address().port);
            check("the offer is ssh2's list, then the SHA-1 pair, last",
                JSON.stringify(offered) === JSON.stringify([...C.DEFAULT_KEX, ...sshAlgorithms.LEGACY_KEX]),
                (offered || []).join(','));
            check('the SHA-1 pair is group14 then group-exchange',
                JSON.stringify(sha1(offered)) ===
                JSON.stringify(['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1']),
                sha1(offered).join(','));
            check('group1-sha1 is never offered', !r.ok && /no matching key exchange/.test(r.error || ''), r.error || r.kex);
            check('the error names what the device offered',
                /the device offers diffie-hellman-group1-sha1/.test(r.error || ''), r.error);
            check('and does not point at a setting that is already on',
                !/Settings/.test(r.error || ''), r.error);
        }

        console.log('legacy key exchange off');
        sshAlgorithms.configure({ legacyKex: false });
        {
            const r = await dial(iosv.address().port);
            check('the IOSv device is refused', !r.ok && /no matching key exchange/.test(r.error || ''), r.error || r.kex);
            check('the error lists its methods (minus protocol markers)',
                /the device offers diffie-hellman-group-exchange-sha1, diffie-hellman-group14-sha1/.test(r.error || ''),
                r.error);
            check('and points at the setting', /Settings > SSH key exchange/.test(r.error || ''), r.error);
        }
        {
            const r = await dial(modern.address().port);
            check('a modern device is unaffected', r.ok && /^curve25519/.test(r.kex || ''), r.error || r.kex);
        }
        {
            offered = null;
            await dial(group1Only.address().port);
            check('nothing SHA-1 is offered', offered && sha1(offered).length === 0, (offered || []).join(','));
        }

        console.log('jump hosts');
        sshAlgorithms.configure({ legacyKex: true });
        {
            const r = await dial(modern.address().port, {
                jumpChain: [{ host: '127.0.0.1', port: iosv.address().port, credentialProfile: 'lab' }],
            });
            check('a modern device behind an IOSv-shaped gateway connects', r.ok, r.error || r.kex);
            check('the device itself used a modern exchange', /^curve25519/.test(r.kex || ''), r.kex);
            check('the notice names the gateway',
                r.connected && /legacy key exchange on jump host 127\.0\.0\.1: diffie-hellman-group14-sha1/
                    .test(r.connected.notice || ''), r.connected && r.connected.notice);
        }
        sshAlgorithms.configure({ legacyKex: false });
        {
            const r = await dial(modern.address().port, {
                jumpChain: [{ host: '127.0.0.1', port: iosv.address().port, credentialProfile: 'lab' }],
            });
            check('with the setting off, the gateway is refused too',
                !r.ok && /no matching key exchange/.test(r.error || ''), r.error || r.kex);
        }

        console.log('other errors');
        {
            const w = sshAlgorithms.handshakeWatch();
            w.debug('Handshake: (remote) KEX method: diffie-hellman-group14-sha1');
            check('a non-mismatch error is unchanged',
                w.explain('connect ECONNREFUSED 127.0.0.1:22') === 'connect ECONNREFUSED 127.0.0.1:22');
            check('a mismatch with no list seen is unchanged',
                sshAlgorithms.handshakeWatch().explain('Handshake failed: no matching key exchange algorithm') ===
                'Handshake failed: no matching key exchange algorithm');
            w.debug('Handshake: (remote) Host key format: ssh-dss');
            check('a host key mismatch names the device\'s key type',
                /the device offers ssh-dss$/.test(w.explain('Handshake failed: no matching host key format')));
        }
    } finally {
        sshAlgorithms.configure({ legacyKex: true });
        for (const s of [iosv, modern, group1Only]) s.close();
    }
    if (failures) {
        console.error(`FAIL - ssh legacy key exchange: ${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('ok - ssh legacy key exchange (IOSv connects over SHA-1 and says so, modern stays modern, ' +
        'group1 never, setting off refuses with the device\'s list, jump hosts alike)');
    process.exit(0);
})().catch((err) => {
    console.error('FAIL - ssh legacy key exchange:', err && err.stack || err);
    process.exit(1);
});
