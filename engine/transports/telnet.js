'use strict';
// Telnet transport: a TCP socket through the negotiator. descriptor.rawTcp
// skips negotiation entirely for console servers and bare TCP listeners that
// speak no telnet at all - bytes pass both ways untouched.

const net = require('net');
const { Transport } = require('./base');
const { TelnetNegotiator } = require('./telnet-negotiator');

class TelnetTransport extends Transport {
    constructor() {
        super();
        this._sock = null;
        this._neg = null;
        this._closedEmitted = false;
    }

    get capabilities() { return { sftp: false, resize: true }; }

    async connect(descriptor, _auth) {
        const host = descriptor.host;
        const port = descriptor.port || 23;
        this._status('connecting', `${host}:${port}`);

        if (!descriptor.rawTcp) {
            this._neg = new TelnetNegotiator();
            this._neg.cols = descriptor.cols || 80;
            this._neg.rows = descriptor.rows || 24;
            this._neg.on('data', (buf) => this.emit('data', buf));
            this._neg.on('send', (buf) => {
                if (this._sock && !this._sock.destroyed && !this._sock.writableEnded) this._sock.write(buf);
            });
        }

        // Outbound proxy: the tunnel is established first, and the socket
        // that comes back is already connected - the wiring below treats it
        // exactly like a direct socket whose 'connect' already fired.
        let proxied = null;
        if (descriptor.proxy) {
            this._status('connecting', `via proxy ${descriptor.proxy}`);
            try {
                proxied = await require('../proxy-dial').dial(
                    descriptor.proxy, host, port, descriptor.timeoutMs);
            } catch (err) {
                this._status('error', err.message);
                this._emitClose(1, err.message);
                throw err;
            }
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            const sock = proxied || net.connect({ host, port });
            this._sock = sock;
            sock.setNoDelay(true);
            // Half-open detection: a firewall idle-drop leaves the socket
            // "connected" forever without this - SSH gets the same from its
            // protocol keepalives, telnet only has TCP's.
            sock.setKeepAlive(true, 60000);

            const opened = () => {
                settled = true;
                sock.setTimeout(0);
                // No auth phase: telnet login happens in-band on screen.
                this._status('connected', null);
                resolve();
            };

            sock.on('timeout', () => {
                // Only the connect phase times out; established telnet
                // sessions to console gear legitimately sit idle for hours.
                if (!settled) sock.destroy(new Error('connection timed out'));
            });

            if (proxied) {
                opened();
            } else {
                sock.setTimeout(descriptor.timeoutMs || 15000);
                sock.on('connect', opened);
            }

            sock.on('data', (buf) => {
                if (this._neg) this._neg.feed(buf);
                else this.emit('data', buf);
            });

            sock.on('error', (err) => {
                if (!settled) {
                    settled = true;
                    this._status('error', err.message);
                    this._emitClose(1, err.message);
                    reject(err);
                } else {
                    // Remember the reason: the close that follows must not
                    // overwrite 'error' with 'closed' and report code 0 -
                    // a mid-session ECONNRESET is not a clean exit. Same
                    // ordering guard the SSH transport has always had.
                    this._lastError = err.message;
                    this._status('error', err.message);
                }
            });

            sock.on('close', () => {
                if (!settled) return;   // error path already reported
                if (this._lastError) {
                    this._emitClose(1, this._lastError);
                } else {
                    this._status('closed', null);
                    this._emitClose(0, 'connection closed');
                }
            });
        });
    }

    write(data) {
        // Same belt-and-braces as the ssh transport: input arriving after the
        // far end hung up is dropped here rather than relying on the socket's
        // own error path to swallow it.
        if (!this._sock || this._sock.destroyed || this._sock.writableEnded) return;
        this._sock.write(this._neg ? this._neg.encode(data) : data);
    }

    pause() { if (this._sock) this._sock.pause(); }
    resume() { if (this._sock) this._sock.resume(); }

    resize(cols, rows) {
        if (this._neg) this._neg.setSize(cols, rows);
    }

    async close() {
        this._status('closing', null);
        if (this._sock) this._sock.end();
    }

    _emitClose(code, reason) {
        if (this._closedEmitted) return;
        this._closedEmitted = true;
        this.emit('close', { code, reason });
    }
}

module.exports = { TelnetTransport };
