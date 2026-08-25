'use strict';
// Hop-pool refcount accounting, against two real fixture gateways. The pool
// is the most state-heavy file in the engine and every bug it has had lived
// on an ERROR path, so that is what this attacks: gateway death, failed
// chain builds, and stale handles releasing against re-created slots. Every
// scenario asserts the pool drains back to empty - a leaked ref here is a
// gateway connection (and an AD auth) pinned until app restart.

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const hopPool = require('../engine/hop-pool');

const PORT_A = 2251;
const PORT_B = 2252;

const hopA = { host: '127.0.0.1', port: PORT_A, credentialProfile: 'lab' };
const hopB = { host: '127.0.0.1', port: PORT_B, credentialProfile: 'lab' };

const helpers = {
    authFor: (name) => name === 'lab'
        ? { username: 'nettest', password: 'nettest' }
        : { username: 'nettest', password: 'wrong-password' },
    verifyHostkey: () => Promise.resolve(true),
};

function startFixture(port, name) {
    const proc = spawn(process.execPath,
        [path.join(__dirname, 'test-ssh-server.js'), String(port), name],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise((resolve, reject) => {
        proc.stdout.on('data', (d) => { if (/listening/.test(d.toString())) resolve(proc); });
        proc.stderr.on('data', (d) => reject(new Error(d.toString())));
        setTimeout(() => reject(new Error('fixture did not start')), 8000);
    });
}

async function drainedTo(expect, ms = 5000) {
    const until = Date.now() + ms;
    for (;;) {
        if (JSON.stringify(hopPool.stats()) === JSON.stringify(expect)) return;
        if (Date.now() > until) {
            assert.fail(`pool never reached ${JSON.stringify(expect)}, ` +
                `stuck at ${JSON.stringify(hopPool.stats())}`);
        }
        await new Promise((r) => setTimeout(r, 100));
    }
}

const keyA = `127.0.0.1:${PORT_A}:lab`;
const keyAB = `${keyA}>127.0.0.1:${PORT_B}:lab`;

(async () => {
    const gwA = await startFixture(PORT_A, 'gw-a');
    const gwB = await startFixture(PORT_B, 'gw-b');
    try {
        // 1. Sharing and idempotent release: two riders, one connection.
        const h1 = await hopPool.acquire([hopA], helpers);
        const h2 = await hopPool.acquire([hopA], helpers);
        assert.strictEqual(h1.client, h2.client, 'same chain must share one connection');
        assert.deepStrictEqual(hopPool.stats(), { [keyA]: 2 });
        h1.release();
        h1.release();   // a handle releases at most once
        assert.deepStrictEqual(hopPool.stats(), { [keyA]: 1 }, 'double release must not double-decrement');
        h2.release();
        await drainedTo({}, 2000);

        // 2. Gateway death releases the prefix ref (the A>B leak). Dialing
        // the two-hop chain implicitly acquires A; when B's connection dies,
        // A must drain to zero and close, not stay pinned forever.
        const hAB = await hopPool.acquire([hopA, hopB], helpers);
        assert.deepStrictEqual(hopPool.stats(), { [keyA]: 1, [keyAB]: 1 });
        hAB.client.end();   // the gateway connection drops
        await drainedTo({});

        // 3. A failed last hop releases every hop it did reach. Bad
        // credentials at B must not leave A acquired.
        const badB = { ...hopB, credentialProfile: 'stale' };
        await assert.rejects(() => hopPool.acquire([hopA, badB], helpers),
            /authentication|password/i, 'bad hop credentials must reject');
        await drainedTo({}, 2000);

        // 4. A stale handle must not decrement a re-created slot. Kill the
        // connection behind h3, re-acquire the same chain (fresh entry),
        // then release the DEAD handle: the fresh entry keeps its ref.
        const h3 = await hopPool.acquire([hopA], helpers);
        h3.client.end();
        await drainedTo({});
        const h4 = await hopPool.acquire([hopA], helpers);
        assert.notStrictEqual(h4.client, h3.client, 'fresh slot must be a fresh connection');
        h3.release();   // rider of the dead connection finally lets go
        assert.deepStrictEqual(hopPool.stats(), { [keyA]: 1 },
            'a stale release must not drain the re-created slot');
        h4.release();
        await drainedTo({});

        // 5. connectClient's auth and close discipline, driven directly with
        // a stub client so the exact ssh2 event sequences are reproducible.
        const { EventEmitter } = require('events');

        // 5a. An offered 'agent' method must be SENT as agent. It used to
        // fall through to keyboard-interactive, which answered with the
        // stored password - a second backend attempt per connect, against
        // the exact lockout policies the pool exists to protect.
        {
            const fake = new EventEmitter();
            const offered = [];
            fake.connect = (cfg) => {
                // Drive the authHandler the way ssh2 would until it stops.
                const step = () => cfg.authHandler(['publickey', 'password'], false, (choice) => {
                    if (choice === false) return;
                    offered.push(choice === null ? '(skip)' : choice.type);
                    setImmediate(step);
                });
                setImmediate(step);
                setTimeout(() => fake.emit('ready'), 50);
            };
            fake.end = () => {};
            await hopPool.connectClient(fake,
                { host: 'x', port: 22, username: 'u', agent: 'pageant', password: 'pw' },
                helpers);
            assert.strictEqual(offered[0], 'agent',
                `agent must be offered AS agent, not fall through - got ${offered.join(',')}`);
            assert.ok(!offered.slice(0, 2).includes('keyboard-interactive'),
                'keyboard-interactive must not jump the queue past agent and password');
        }

        // 5b. A close WITHOUT an error must settle the promise. ssh2 emits
        // exactly that when our own KI dead-end calls client.end(); an
        // unsettled promise here left the pool entry permanently pending,
        // bricking the gateway for every later session until app restart.
        {
            const fake = new EventEmitter();
            fake.connect = () => { setTimeout(() => fake.emit('close'), 30); };
            fake.end = () => {};
            let settled = false;
            const p = hopPool.connectClient(fake, { host: 'x', port: 22, username: 'u' }, helpers)
                .then(() => { settled = true; }, () => { settled = true; });
            await new Promise((r) => setTimeout(r, 400));
            assert.ok(settled,
                'close-without-error must reject the connect, not hang it (and the pool) forever');
            await p.catch(() => {});
        }

        console.log('ok - hop pool (sharing, gateway death, failed chain, stale handles, ' +
            'agent offered as agent, close-without-error settles - pool drains to zero)');
        process.exit(0);
    } finally {
        gwA.kill();
        gwB.kill();
    }
})().catch((err) => {
    console.error('FAIL -', err.message);
    process.exit(1);
});
