'use strict';
// Serial transport - USB console cables into switch/router console ports.
// The one runtime native dependency in the app (serialport, N-API prebuilds).
// No resize (a console port has no window), no auth phase (login is in-band).

const { SerialPort } = require('serialport');
const { Transport } = require('./base');

class SerialTransport extends Transport {
    constructor() {
        super();
        this._port = null;
        this._closedEmitted = false;
        this._aborted = false;   // close() arrived while open() was pending
    }

    get capabilities() { return { sftp: false, resize: false }; }

    async connect(descriptor, _auth) {
        const s = descriptor.serial || {};
        const path = s.device;
        if (!path) throw Object.assign(new Error('no COM port selected'), { isAuthFailure: false });
        this._status('connecting', path);

        return new Promise((resolve, reject) => {
            const port = new SerialPort({
                path,
                baudRate: s.baud || 9600,
                dataBits: s.dataBits || 8,
                parity: s.parity || 'none',
                stopBits: s.stopBits || 1,
                rtscts: s.flow === 'rtscts',
                xon: s.flow === 'xonxoff',
                xoff: s.flow === 'xonxoff',
                autoOpen: false,
            });
            this._port = port;

            port.on('data', (buf) => this.emit('data', buf));
            port.on('close', () => {
                this._status('closed', null);
                this._emitClose(0, 'port closed');
            });
            port.on('error', (err) => {
                this._status('error', err.message);
                // Surprise removal can error without a follow-up close; a
                // session that never emits close never terminates, and the
                // handle keeps the (exclusive) COM port. Force the close.
                if (port.isOpen) port.close(() => { /* close event finishes it */ });
                else this._emitClose(1, err.message);
            });

            port.open((err) => {
                if (err) {
                    // On Linux the serial devices belong to the `dialout`
                    // group, so a fresh install fails here with a bare
                    // "Permission denied" that says nothing about the fix.
                    const denied = /permission denied|EACCES/i.test(err.message);
                    const msg = (denied && process.platform === 'linux')
                        ? `${err.message} - on Linux, serial ports need group access: ` +
                          `sudo usermod -aG dialout $USER (then log out and back in)`
                        : err.message;
                    this._status('error', msg);
                    this._emitClose(1, msg);
                    return reject(new Error(msg));
                }
                if (this._aborted) {
                    // The pane closed while the port was opening. close()
                    // found nothing to close (isOpen was still false), and a
                    // COM port is exclusive on Windows - an orphaned handle
                    // here blocks every reopen until the app restarts.
                    port.close(() => {});
                    this._emitClose(0, 'cancelled');
                    return reject(new Error('cancelled'));
                }
                // serialport asserts DTR and RTS on open (unless told not
                // to); this mirror is what the signal menu reads back.
                this._signals = { dtr: true, rts: true };
                this._baud = s.baud || 9600;
                this._status('connected', `${path} @ ${s.baud || 9600}`);
                resolve();
            });
        });
    }

    write(data) {
        if (!this._port || !this._port.isOpen) return;
        // A console port drains at its baud rate and serialport buffers
        // everything handed to it, so a large paste into a 9600-baud line
        // queues silently for minutes. Full write backpressure needs a
        // renderer-visible channel (deferred); what CANNOT stay silent is
        // the state, so the status line says the line is behind, once, and
        // clears when the queue empties.
        this._pendingWrite = (this._pendingWrite || 0) + data.length;
        this._port.write(data, () => {
            this._pendingWrite -= data.length;
            if (this._pendingWrite === 0 && this._backlogged) {
                this._backlogged = false;
                this._status('connected', null);
            }
        });
        if (this._pendingWrite > 64 * 1024 && !this._backlogged) {
            this._backlogged = true;
            this._status('connected',
                `the line is behind - ${Math.round(this._pendingWrite / 1024)} KB still transmitting`);
        }
    }

    pause() { if (this._port) this._port.pause(); }
    resume() { if (this._port) this._port.resume(); }

    // Line controls: break, DTR/RTS, and a mid-session speed change - the
    // console-cable moves PuTTY and TeraTerm users expect. A break during
    // boot is how ROMMON is reached for password recovery, which makes it
    // the single most load-bearing thing a serial terminal can send.
    async signal(req) {
        const port = this._port;
        if (!port || !port.isOpen) throw new Error('the port is not open');
        const set = (opts) => new Promise((res, rej) =>
            port.set(opts, (e) => e ? rej(e) : res()));
        switch (req.op) {
            case 'break': {
                // Clamped: below ~100ms some USB adapters swallow the
                // condition entirely; a break that never ends wedges the
                // line. The deassert is unconditional - an error mid-wait
                // must not leave break held.
                const ms = Math.min(Math.max(Number(req.ms) || 300, 100), 3000);
                await set({ brk: true });
                try {
                    await new Promise((res) => setTimeout(res, ms));
                } finally {
                    await set({ brk: false });
                }
                return { sent: 'break', ms };
            }
            case 'set': {
                const next = {};
                if (typeof req.dtr === 'boolean') next.dtr = req.dtr;
                if (typeof req.rts === 'boolean') next.rts = req.rts;
                if (!Object.keys(next).length) throw new Error('nothing to set');
                await set(next);
                this._signals = { ...this._signals, ...next };
                return { signals: this._signals };
            }
            case 'baud': {
                const baud = Number(req.baud);
                if (!Number.isInteger(baud) || baud < 50 || baud > 4000000) {
                    throw new Error(`not a usable line speed: ${req.baud}`);
                }
                await new Promise((res, rej) =>
                    port.update({ baudRate: baud }, (e) => e ? rej(e) : res()));
                this._baud = baud;
                this._status('connected', `${port.path} @ ${baud}`);
                return { baud };
            }
            case 'status':
                return { signals: this._signals, baud: this._baud };
            default:
                throw new Error(`unknown serial op: ${req.op}`);
        }
    }

    async close() {
        this._status('closing', null);
        this._aborted = true;
        if (this._port && this._port.isOpen) {
            await new Promise((res) => this._port.close(() => res()));
        }
    }

    _emitClose(code, reason) {
        if (this._closedEmitted) return;
        this._closedEmitted = true;
        this.emit('close', { code, reason });
    }
}

async function listPorts() {
    const ports = await SerialPort.list();
    return ports.map((p) => ({
        path: p.path,
        friendlyName: p.friendlyName || p.manufacturer || p.path,
    }));
}

module.exports = { SerialTransport, listPorts };
