'use strict';
// SSH host key TOFU store. First contact asks the user (fingerprint shown);
// a later mismatch is a hard block with a deliberately alarming dialog -
// that is the one scenario worth scaring people about.

const crypto = require('crypto');
const store = require('./store');

let known = {};   // "host:port" -> {fingerprint, keyType, addedAt}

function init() {
    known = store.load('known_hosts', {});
}

function fingerprintOf(keyBlob) {
    return 'SHA256:' + crypto.createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '');
}

// Whether first contact (and therefore the fingerprint dialog) is expected.
function isKnown(host, port) {
    return !!known[`${host}:${port}`];
}

// Returns 'known' | 'unknown' | 'MISMATCH'
function check(host, port, fingerprint) {
    const entry = known[`${host}:${port}`];
    if (!entry) return 'unknown';
    return entry.fingerprint === fingerprint ? 'known' : 'MISMATCH';
}

function trust(host, port, fingerprint, keyType) {
    known[`${host}:${port}`] = { fingerprint, keyType: keyType || null, addedAt: new Date().toISOString() };
    store.save('known_hosts', known);
}

function forget(host, port) {
    delete known[`${host}:${port}`];
    store.save('known_hosts', known);
}

module.exports = { init, fingerprintOf, check, trust, forget, isKnown };
