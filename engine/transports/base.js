'use strict';
// The transport contract every session feature is written against. A
// transport turns a ConnectionDescriptor into a byte stream and a status
// stream; it knows nothing about panes, logging, or flow control - those
// compose around it in session.js.
//
// Events:
//   'data'   (Buffer)                       bytes from the remote side
//   'status' ({state, detail})              lifecycle, states below
//   'close'  ({code, reason})               transport is gone, terminal state
//   'hostkey'({host, port, keyType, fingerprint})  ssh only, first contact or mismatch
//   'auth-prompt' ({prompts})               ssh keyboard-interactive relay
//
// States: resolving -> connecting -> authenticating -> connected -> closing
//         -> closed, with 'error' and 'auth-blocked' as terminal branches.
// Every transport must emit 'status' monotonically and 'close' exactly once.

const { EventEmitter } = require('events');

class Transport extends EventEmitter {
    constructor() {
        super();
        this.state = 'closed';
    }

    // descriptor: resolved connection settings (host, port, serial params...).
    // auth: {username, password, keyPath, keyPassphrase} - plaintext lives
    // only for the duration of connect(); transports must not retain it.
    async connect(descriptor, auth) { throw new Error('not implemented'); }

    write(data) { throw new Error('not implemented'); }

    resize(cols, rows) { /* default no-op; serial cannot resize */ }

    async close() { throw new Error('not implemented'); }

    get capabilities() { return { sftp: false, resize: true }; }

    _status(state, detail) {
        this.state = state;
        this.emit('status', { state, detail: detail || null });
    }
}

module.exports = { Transport };
