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
                this._status('connected', `${path} @ ${s.baud || 9600}`);
                resolve();
            });
        });
    }

    write(data) {
        if (this._port && this._port.isOpen) this._port.write(data);
    }

    pause() { if (this._port) this._port.pause(); }
    resume() { if (this._port) this._port.resume(); }

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
