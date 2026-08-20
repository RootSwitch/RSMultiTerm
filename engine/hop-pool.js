'use strict';
// Shared, refcounted jump-host connections. Thirty sessions through one
// gateway must authenticate to that gateway ONCE - both a performance win
// and a lockout protection (every hop auth is an attempt against AD).
//
// Entries are keyed by the full chain PREFIX (not just the hop endpoint):
// the same bastion reached directly and reached through another bastion are
// different connections and must not share a pool slot.
//
// acquire() returns a HANDLE, not the bare client, and release is a method
// on that handle. This is what keeps the refcounts honest on every path the
// happy case never exercises: a handle releases at most once, it releases
// against the exact entry it was minted from (a reconnect that re-creates
// the slot under the same key cannot be decremented by the old riders), and
// an entry holds its OWN handle on its prefix chain, released exactly once
// when the entry retires - whether that is refs hitting zero, the gateway
// connection dying, or the chain build failing halfway up.

const { Client } = require('ssh2');

const pool = new Map();   // prefixKey -> entry

function keyFor(chainPrefix) {
    return chainPrefix
        .map((h) => `${h.host}:${h.port}:${h.credentialProfile || ''}`)
        .join('>');
}

function makeHandle(entry) {
    let released = false;
    return {
        get client() { return entry.client; },
        release() {
            if (released) return;
            released = true;
            entry.refs--;
            if (entry.refs <= 0) retire(entry, true);
        },
    };
}

// Take the entry out of service exactly once: remove it from the pool (only
// if it still owns its slot), optionally end the connection, and drop the
// ref it holds on its prefix chain so a dead or unused gateway releases the
// gateways beneath it.
function retire(entry, endClient) {
    if (entry.retired) return;
    entry.retired = true;
    if (pool.get(entry.key) === entry) pool.delete(entry.key);
    if (endClient) { try { entry.client.end(); } catch (_) { /* already down */ } }
    if (entry.prefixHandle) {
        entry.prefixHandle.release();
        entry.prefixHandle = null;
    }
}

// Acquire a connected client for the LAST hop of chainPrefix, dialing
// recursively through the earlier hops. helpers:
//   authFor(profileName) -> {username, password, keyPath, keyPassphrase}
//   verifyHostkey(host, port, keyBlob) -> Promise<boolean>
// Resolves to {client, release()}; the caller owns exactly one release.
async function acquire(chainPrefix, helpers) {
    const key = keyFor(chainPrefix);
    let entry = pool.get(key);
    if (entry) {
        entry.refs++;
        const handle = makeHandle(entry);
        try {
            await entry.ready;
        } catch (err) {
            // The build we piggybacked on failed; give our ref back.
            handle.release();
            throw err;
        }
        return handle;
    }

    const hop = chainPrefix[chainPrefix.length - 1];
    entry = {
        key, client: new Client(), refs: 1, ready: null,
        prefixHandle: null, retired: false,
    };
    pool.set(key, entry);
    const handle = makeHandle(entry);

    entry.ready = (async () => {
        // Reach this hop: directly, or through the previous hop's forwardOut.
        let sock;
        if (chainPrefix.length > 1) {
            entry.prefixHandle = await acquire(chainPrefix.slice(0, -1), helpers);
            sock = await forwardOut(entry.prefixHandle.client, hop.host, hop.port);
        }
        const auth = helpers.authFor(hop.credentialProfile);
        if (!auth) throw new Error(`no credentials for jump host '${hop.host}'`);
        await connectClient(entry.client, {
            host: hop.host, port: hop.port, sock,
            username: auth.username, password: auth.password,
            keyPath: auth.keyPath, keyPassphrase: auth.keyPassphrase, agent: auth.agent,
            timeoutMs: hop.timeoutMs,
        }, helpers);
        entry.client.on('close', () => {
            // A dead gateway invalidates the slot regardless of refcount and
            // gives back the ref it held on its prefix; the sessions riding
            // it die on their own, and their releases become no-ops here.
            retire(entry, false);
        });
        return entry.client;
    })();

    try {
        await entry.ready;
    } catch (err) {
        // Chain build failed. Retiring releases the prefix handle too, so a
        // bad password at hop 3 does not permanently pin hops 1 and 2.
        retire(entry, true);
        throw err;
    }
    return handle;
}

function forwardOut(client, dstHost, dstPort) {
    return new Promise((resolve, reject) => {
        client.forwardOut('127.0.0.1', 0, dstHost, dstPort, (err, stream) => {
            if (err) reject(new Error(`gateway cannot reach ${dstHost}:${dstPort} - ${err.message}`));
            else resolve(stream);
        });
    });
}

function connectClient(client, opts, helpers) {
    return new Promise((resolve, reject) => {
        let settled = false;
        client.on('ready', () => { settled = true; resolve(); });
        client.on('error', (err) => {
            if (!settled) {
                const isAuth = /authentication/i.test(err.message) || err.level === 'client-authentication';
                reject(Object.assign(err, { isAuthFailure: isAuth }));
            }
        });

        // Same auth discipline as the ssh transport, because a bastion is
        // often the SAME kind of AD/TACACS box as the targets behind it:
        // each method offered once, keyboard-interactive answered with the
        // password only when the password method was never backend-rejected
        // (a KI-only bastion needs the fallthrough; a rejected password must
        // not be re-spent - a hop auth is an AD attempt like any other).
        const methods = [];
        if (opts.agent) methods.push('agent');
        if (opts.keyPath) methods.push('publickey');
        if (opts.password !== undefined && opts.password !== null) methods.push('password');
        methods.push('keyboard-interactive');
        let idx = 0;
        let lastMethod = null;
        let passwordRejected = false;

        const authHandler = (methodsLeft, partialSuccess, next) => {
            if (lastMethod === 'password' && !partialSuccess &&
                Array.isArray(methodsLeft) && methodsLeft.includes('password')) {
                passwordRejected = true;
            }
            if (idx >= methods.length) return next(false);
            const m = methods[idx++];
            lastMethod = m;
            if (m === 'keyboard-interactive' && passwordRejected) return next(false);
            if (m === 'publickey') {
                let key;
                try {
                    key = require('fs').readFileSync(opts.keyPath);
                } catch (e) {
                    return next(null);   // skip to the next method
                }
                return next({
                    type: 'publickey', username: opts.username,
                    key, passphrase: opts.keyPassphrase || undefined,
                });
            }
            if (m === 'password') {
                return next({ type: 'password', username: opts.username, password: opts.password });
            }
            return next({
                type: 'keyboard-interactive', username: opts.username,
                prompt: (name, instructions, lang, prompts, finish) => {
                    if (prompts.length === 1 && !prompts[0].echo &&
                        opts.password !== undefined && opts.password !== null) {
                        return finish([opts.password]);
                    }
                    // No prompt UI on the hop path either; fail rather than
                    // hang into a misleading handshake timeout.
                    client.end();
                },
            });
        };

        client.connect({
            host: opts.host, port: opts.port, sock: opts.sock,
            username: opts.username,
            authHandler,
            readyTimeout: opts.timeoutMs || 15000,
            keepaliveInterval: 30000,
            hostVerifier: (key, verify) => {
                helpers.verifyHostkey(opts.host, opts.port, key)
                    .then(verify, () => verify(false));
            },
        });
    });
}

// Test/diagnostic view of the pool: {key: refs}.
function stats() {
    const out = {};
    for (const [key, entry] of pool) out[key] = entry.refs;
    return out;
}

module.exports = { acquire, forwardOut, connectClient, stats };
