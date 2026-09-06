'use strict';
// SSH host key TOFU store. First contact asks the user (fingerprint shown);
// a later mismatch is a hard block with a deliberately alarming dialog -
// that is the one scenario worth scaring people about.

const crypto = require('crypto');
const store = require('./store');

let known = {};   // "host:port" -> {fingerprint, keyType, addedAt}

function init() {
    // loadCritical, not load: the tolerant loader returns {} on a corrupt
    // file, which silently EMPTIES the trust store - every pinned host
    // reverts to first contact, and a man-in-the-middle gets the friendly
    // "accept this fingerprint?" prompt instead of the hard MISMATCH block.
    // The one code path that exists to be scary must not quietly vanish
    // because a sync tool mangled a JSON file. Missing is still fine (a
    // fresh install trusts nobody); unreadable stops the app with the
    // recovery message, same as sessions and profiles.
    known = store.loadCritical('known_hosts', {});
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

// One pinned entry, for main to read when it needs to SHOW a fingerprint in
// a dialog of its own. The renderer must never be the source of that text.
function get(host, port) {
    return known[`${host}:${port}`] || null;
}

// Every pinned host, for the manager UI. The key is "host:port" and a bare
// IPv6 address is full of colons, so the port is split off the END.
function list() {
    return Object.entries(known).map(([key, v]) => {
        const at = key.lastIndexOf(':');
        return {
            host: at > 0 ? key.slice(0, at) : key,
            port: at > 0 ? Number(key.slice(at + 1)) : null,
            fingerprint: v.fingerprint,
            keyType: v.keyType || null,
            addedAt: v.addedAt || null,
        };
    }).sort((a, b) => a.host.localeCompare(b.host) || (a.port || 0) - (b.port || 0));
}

module.exports = { init, fingerprintOf, check, trust, forget, isKnown, get, list };
