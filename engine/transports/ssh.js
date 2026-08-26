'use strict';
// SSH transport over ssh2. The auth handler offers each configured method
// exactly once and never cycles - retrying auth is what locks out rotating
// AD accounts, so a failure here is surfaced, not papered over.

const fs = require('fs');
const { Client, utils: { parseKey } } = require('ssh2');
const { Transport } = require('./base');
const hopPool = require('../hop-pool');

class SshTransport extends Transport {
    constructor() {
        super();
        this._client = null;
        this._stream = null;
        this._closedEmitted = false;
        this._hop = null;      // pool handle for the jump chain, release-once
        this._aborted = false; // close() arrived while connect was in flight
    }

    get capabilities() { return { sftp: true, resize: true }; }

    // auth: the target's credentials. helpers (optional):
    //   verifyHostkey(host, port, keyBlob) -> Promise<boolean>
    //   authFor(profileName) -> hop credentials
    async connect(descriptor, auth, helpers) {
        const host = descriptor.host;
        const port = descriptor.port || 22;
        this._status('connecting', `${host}:${port}`);

        // Jump chain: dial the gateway(s) through the shared pool, then ride
        // a forwardOut stream to the target. One gateway auth per profile
        // per chain, however many sessions fan out behind it. Failures here
        // happen BEFORE the client error/close wiring exists, so this block
        // must surface them and give back the pool ref itself - a gateway
        // that cannot reach the target is routine, not exceptional.
        let sock;
        // Outbound proxy, for direct connections only: a jump chain already
        // has its own way out of the building, and dialing the GATEWAY
        // through a proxy is a different feature (say so rather than
        // silently doing something surprising either way).
        if (descriptor.proxy && !(descriptor.jumpChain && descriptor.jumpChain.length)) {
            this._status('connecting', `via proxy ${descriptor.proxy}`);
            try {
                sock = await require('../proxy-dial').dial(
                    descriptor.proxy, host, port, descriptor.timeoutMs);
                if (this._aborted) { sock.destroy(); throw new Error('cancelled'); }
            } catch (err) {
                this._status('error', err.message);
                this._emitClose(1, err.message);
                throw err;
            }
        }
        if (descriptor.jumpChain && descriptor.jumpChain.length && helpers) {
            this._status('connecting', `via ${descriptor.jumpChain.map((h) => h.host).join(' > ')}` +
                (descriptor.proxy ? ' (the proxy is not used on a jump chain)' : ''));
            try {
                this._hop = await hopPool.acquire(descriptor.jumpChain, helpers);
                if (this._aborted) throw new Error('cancelled');
                sock = await hopPool.forwardOut(this._hop.client, host, port);
                if (this._aborted) throw new Error('cancelled');
            } catch (err) {
                const isAuth = !!err.isAuthFailure;
                this._status(isAuth ? 'auth-blocked' : 'error', err.message);
                this._emitClose(1, err.message);   // releases the hop handle
                throw err;
            }
        }

        const client = new Client();
        this._client = client;

        // Offer each method once, in order, then give up. `tried` is the
        // guard: ssh2 calls authHandler again after every failure, and
        // returning false ends the attempt instead of cycling.
        const methods = [];
        // Agent first when there is one: it is the cheapest to try, costs no
        // stored secret, and a lab where the agent works is a lab where
        // nothing else needs to be typed.
        if (auth.agent) methods.push('agent');
        if (auth.keyPath) methods.push('publickey');
        if (auth.password !== undefined && auth.password !== null) methods.push('password');
        methods.push('keyboard-interactive');
        let idx = 0;
        let lastMethod = null;
        let passwordRejected = false;

        const authHandler = (methodsLeft, partialSuccess, next) => {
            // A wrong password must cost exactly one backend attempt. If the
            // server's continue-list still offers 'password' after our
            // password attempt failed, the method was accepted and the
            // CREDENTIAL was refused - by the AD/TACACS backend, which just
            // counted a strike. Falling through to keyboard-interactive would
            // answer with that same password and burn a second one. When
            // 'password' is absent from the list, the server refused the
            // method itself (password auth disabled, KI-only gear); the
            // backend never saw it, and trying KI is both safe and required.
            if (lastMethod === 'password' && !partialSuccess &&
                Array.isArray(methodsLeft) && methodsLeft.includes('password')) {
                passwordRejected = true;
            }
            if (idx > 0) this._status('authenticating', `method ${methods[idx - 1]} failed`);
            if (idx >= methods.length) return next(false);
            const m = methods[idx++];
            lastMethod = m;
            if (m === 'keyboard-interactive' && passwordRejected) return next(false);
            if (m === 'agent') {
                return next({ type: 'agent', username: auth.username, agent: auth.agent });
            }
            if (m === 'publickey') {
                let key;
                try {
                    key = fs.readFileSync(auth.keyPath);
                } catch (e) {
                    return next(null); // skip to the next method
                }
                // Parse here rather than handing ssh2 something it will
                // choke on mid-handshake: a wrong passphrase or an
                // unreadable key is a LOCAL problem, and reporting it as
                // one keeps it out of the auth-failure machinery that
                // halts a profile after a refused login.
                const parsed = parseKey(key, auth.keyPassphrase || undefined);
                if (parsed instanceof Error) {
                    const err = new Error(/encrypted|passphrase|decrypt|integrity/i.test(parsed.message)
                        ? `the passphrase does not open ${auth.keyPath}`
                        : `cannot use ${auth.keyPath}: ${parsed.message}`);
                    err.isKeyProblem = true;
                    this._keyError = err;
                    return next(false);
                }
                return next({
                    type: 'publickey', username: auth.username,
                    key, passphrase: auth.keyPassphrase || undefined,
                });
            }
            if (m === 'password') {
                return next({ type: 'password', username: auth.username, password: auth.password });
            }
            return next({
                type: 'keyboard-interactive', username: auth.username,
                prompt: (name, instructions, lang, prompts, finish) => {
                    // Single echo-less prompt is the common password-over-KI
                    // case (Cisco TACACS does this); answer it directly so the
                    // user is not prompted twice for the same password.
                    if (prompts.length === 1 && !prompts[0].echo &&
                        auth.password !== undefined && auth.password !== null) {
                        return finish([auth.password]);
                    }
                    // Anything else (2FA codes, echoed prompts, KI with no
                    // stored password) has no UI yet. Answering with wrong or
                    // empty strings would burn a backend attempt; leaving
                    // `finish` uncalled dies 15s later as a misleading
                    // "handshake timeout". Fail NOW with the real reason.
                    this._kiError = new Error(
                        'the server asked for an interactive prompt this app cannot answer yet' +
                        (prompts[0] && prompts[0].prompt ? ` ("${String(prompts[0].prompt).slice(0, 60).trim()}")` : ''));
                    this._client.end();
                },
            });
        };

        return new Promise((resolve, reject) => {
            let settled = false;
            const fail = (err) => {
                if (settled) return;
                settled = true;
                // A key that will not parse or open never reached the
                // server, so it is not an authentication failure and must
                // not halt the profile the way a refused password does.
                // Its message is also the useful one, so it wins.
                if (this._keyError) {
                    const ke = this._keyError;
                    this._status('error', ke.message);
                    this._emitClose(1, ke.message);
                    return reject(Object.assign(ke, { isAuthFailure: false }));
                }
                const isAuth = /authentication/i.test(err.message) || err.level === 'client-authentication';
                this._status(isAuth ? 'auth-blocked' : 'error', err.message);
                this._emitClose(1, err.message);
                reject(Object.assign(err, { isAuthFailure: isAuth }));
            };

            client.on('error', (err) => {
                // After settle, fail() is a no-op - remember the reason so
                // the close that follows can report it. A mid-session
                // ECONNRESET must not be indistinguishable from a clean exit.
                this._lastError = err.message;
                fail(err);
            });
            client.on('close', () => {
                if (!settled) return fail(this._keyError || this._kiError || new Error('connection closed'));
                // fail() already delivered a terminal verdict (auth-blocked/
                // error); a follow-up 'closed' status would overwrite it in
                // any state-driven UI.
                if (this._closedEmitted) return;
                if (this._lastError) {
                    this._status('error', this._lastError);
                    this._emitClose(1, this._lastError);
                } else {
                    this._status('closed', null);
                    this._emitClose(0, 'connection closed');
                }
            });

            client.on('ready', () => {
                this._status('authenticating', 'ok');
                client.shell(
                    { term: 'xterm-256color', cols: descriptor.cols || 80, rows: descriptor.rows || 24 },
                    (err, stream) => {
                        if (err) return fail(err);
                        this._stream = stream;
                        stream.on('data', (buf) => this.emit('data', buf));
                        // Keystrokes keep arriving after a session dies -
                        // people mash Enter at a rebooting switch. ssh2
                        // currently drops writes to a closed channel quietly,
                        // so this is belt and braces rather than a fix for an
                        // observed crash: dropping the reference makes the
                        // behavior ours instead of the dependency's, and the
                        // error listener means a future change there cannot
                        // surface as an unhandled 'error' in the engine.
                        stream.on('error', () => { /* reported via client error/close */ });
                        stream.on('close', () => {
                            this._stream = null;
                            client.end();
                        });
                        // Catch up on a size that arrived mid-handshake.
                        if (this._size &&
                            (this._size.cols !== (descriptor.cols || 80) ||
                             this._size.rows !== (descriptor.rows || 24))) {
                            stream.setWindow(this._size.rows, this._size.cols, 0, 0);
                        }
                        settled = true;
                        this._status('connected', null);
                        resolve();
                    });
            });

            client.connect({
                host, port, sock,
                username: auth.username,
                authHandler,
                hostVerifier: (key, verify) => {
                    // Fail CLOSED. Every in-app path passes a verifier; a
                    // future caller that forgets one must get a refused
                    // connection, not silently disabled host-key checking.
                    // Tests that want accept-all say so explicitly.
                    if (!helpers || !helpers.verifyHostkey) return verify(false);
                    helpers.verifyHostkey(host, port, key).then(verify, () => verify(false));
                },
                readyTimeout: descriptor.timeoutMs || 15000,
                keepaliveInterval: 30000,
                keepaliveCountMax: 3,
            });
            this._status('authenticating', null);
        });
    }

    sftp(cb) {
        if (!this._client) return cb(new Error('not connected'));
        this._client.sftp(cb);
    }

    write(data) {
        if (this._stream) this._stream.write(data);
    }

    // Pause/resume the underlying channel - flow control's hook to push
    // backpressure to the far end via SSH's own window.
    pause() { if (this._stream) this._stream.pause(); }
    resume() { if (this._stream) this._stream.resume(); }

    // A resize can arrive before the shell channel exists - the renderer
    // measures its pane as soon as it is on screen, which routinely beats
    // the handshake. Dropping it left the far end on the 80x24 it was
    // opened with while the terminal was far wider, and a shell that wraps
    // at the wrong column corrupts every redraw of a recalled long line.
    resize(cols, rows) {
        this._size = { cols, rows };
        if (this._stream) this._stream.setWindow(rows, cols, 0, 0);
    }

    async close() {
        this._status('closing', null);
        // Mid-connect close: the connect resumes after its current await,
        // sees the flag, and unwinds through its own error path (which
        // releases the pool ref). Post-connect close: end() triggers the
        // client's close event, which does the same.
        this._aborted = true;
        if (this._client) this._client.end();
    }

    _emitClose(code, reason) {
        if (this._closedEmitted) return;
        this._closedEmitted = true;
        if (this._hop) {
            this._hop.release();
            this._hop = null;
        }
        this.emit('close', { code, reason });
    }
}

module.exports = { SshTransport };
