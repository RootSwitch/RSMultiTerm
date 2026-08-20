'use strict';
// A session composes: transport + data-plane MessagePort (+ flow control and
// logging, which attach here as they land). The engine holds one Session per
// live connection; the renderer holds the other end of the port.
//
// Port protocol, engine -> renderer:
//   {t:'data', seq, buf}       buf is a Uint8Array chunk
//   {t:'status', state, detail}
// renderer -> engine:
//   {t:'stdin', data}          keystrokes, string
//   {t:'resize', cols, rows}
//   {t:'ack', seq, bytes}      flow-control credit return

const { SshTransport } = require('./transports/ssh');
const { TelnetTransport } = require('./transports/telnet');
const { SerialTransport } = require('./transports/serial');
const { Flow } = require('./flow');
const { SessionLogger } = require('./logger');

const TRANSPORTS = {
    ssh: SshTransport,
    telnet: TelnetTransport,
    serial: SerialTransport,
};

class Session {
    constructor(id, descriptor, onEvent, helpers) {
        this.id = id;
        this.descriptor = descriptor;
        this.onEvent = onEvent;   // engine -> main event sink
        this.helpers = helpers;   // {verifyHostkey}
        this.port = null;

        const T = TRANSPORTS[descriptor.transport];
        if (!T) throw new Error(`unknown transport: ${descriptor.transport}`);
        this.transport = new T();

        this.flow = new Flow(
            (msg) => this._post(msg),
            () => this.transport.pause && this.transport.pause(),
            () => this.transport.resume && this.transport.resume());

        this.transport.on('status', (s) => {
            this._post({ t: 'status', state: s.state, detail: s.detail });
            this.onEvent({ t: 'status', sessionId: this.id, state: s.state, detail: s.detail });
        });
        // Logging taps the raw transport stream BEFORE flow control, so a
        // paused renderer never gaps a log file.
        const logCfg = descriptor.logging;
        this.logger = (logCfg && logCfg.enabled && logCfg.dir)
            ? new SessionLogger({
                dir: logCfg.dir,
                sessionName: descriptor.name || descriptor.host,
                host: descriptor.host || (descriptor.serial && descriptor.serial.device) || 'local',
                mode: logCfg.mode || 'text',
                timestamps: logCfg.timestamps !== false,
            })
            : null;

        this._connectSettled = false;
        this._closeHeld = null;
        this.transport.on('close', (c) => {
            this.flow.close();   // deliver the tail before reporting death
            if (this.logger) this.logger.close();
            const msg = { t: 'closed', sessionId: this.id, code: c.code, reason: c.reason };
            // A connect-phase failure emits the transport's close BEFORE the
            // rejection reaches connect()'s catch. Main must see the verdict
            // ('connect-failed', which trips the auth guard) before the
            // funeral ('closed', which releases the canary queue) - the
            // other order releases a batch that a stale password should have
            // halted. Hold the close until connect() has settled.
            if (this._connectSettled) this.onEvent(msg);
            else this._closeHeld = msg;
        });
        this.transport.on('data', (buf) => {
            if (this.logger) this.logger.write(buf);
            this.flow.push(buf);
        });
    }

    attachPort(port) {
        this.port = port;
        port.on('message', (e) => {
            const m = e.data;
            if (!m || typeof m !== 'object') return;
            if (m.t === 'stdin') this.transport.write(m.data);
            else if (m.t === 'resize') this.transport.resize(m.cols, m.rows);
            else if (m.t === 'ack') this.flow.ack(m.seq, m.bytes);
        });
        port.start();
    }

    // auth: direct credentials (quick connect). authByProfile: map of
    // profileName -> credentials for saved sessions and their jump hops.
    async connect(auth, authByProfile) {
        const byProfile = authByProfile || {};
        const target = (auth && auth.username !== undefined) ? auth
            : (byProfile[this.descriptor.credentialProfile] || {});
        const helpers = {
            verifyHostkey: this.helpers.verifyHostkey,
            authFor: (name) => byProfile[name] || null,
        };
        try {
            await this.transport.connect(this.descriptor, target, helpers);
        } catch (err) {
            this.onEvent({
                t: 'connect-failed', sessionId: this.id,
                message: err.message, isAuthFailure: !!err.isAuthFailure,
            });
        } finally {
            this._connectSettled = true;
            if (this._closeHeld) {
                this.onEvent(this._closeHeld);
                this._closeHeld = null;
            }
        }
    }

    async close() {
        try { await this.transport.close(); } catch (_) { /* already down */ }
        if (this.logger) await this.logger.close();
        if (this.port) { this.port.close(); this.port = null; }
    }

    _post(msg) {
        if (this.port) this.port.postMessage(msg);
    }
}

module.exports = { Session };
