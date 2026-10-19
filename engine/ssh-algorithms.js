'use strict';
// What RSMultiTerm offers in an SSH handshake, beyond ssh2's own defaults,
// and how a failed handshake explains itself. Shared by the session
// transport and the jump-host pool, so a gateway and the device behind it
// are held to the same list.
//
// ssh2's default key exchanges are all SHA-2 or curve methods. Classic
// Cisco IOS - 15.x on real gear, IOSv and IOSvL2 in CML - offers only
// diffie-hellman-group14-sha1 and diffie-hellman-group-exchange-sha1, so
// out of the box the two had nothing in common and the device logged
// %SSH-3-NO_MATCH. The SHA-1 pair is APPENDED: the client's list decides
// the outcome (the first method on it the server also has), so a device
// that speaks anything modern still gets that; and both lists are signed
// into the exchange hash, so nobody in the middle can strip the modern
// ones to force SHA-1. ssh2 also drops group-exchange by itself when the
// server says it is Cisco (whose implementation of it is broken), which
// leaves group14-sha1 as the one that actually matters there. group1-sha1
// (a 1024-bit group) is never offered.
//
// Main sends {legacyKex} at engine start and whenever settings change; the
// default here matches the settings default for the moment in between.

const LEGACY_KEX = ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1'];

let legacyKex = true;

function configure(cfg) {
    if (cfg && 'legacyKex' in cfg) legacyKex = cfg.legacyKex !== false;
}

// The `algorithms` option for ssh2's Client.connect.
function algorithms() {
    return legacyKex ? { kex: { append: LEGACY_KEX } } : undefined;
}

// A negotiated key exchange worth telling someone about.
function isLegacyKex(kex) {
    return typeof kex === 'string' && /-sha1$/.test(kex);
}

// ssh2 says WHAT it could not match but not what the device offered, and
// "no matching key exchange algorithm" alone sends people to the wrong
// tools. Its debug stream carries the device's lists, so watch that for the
// handshake and put them in the error.
const OFFERED = /^Handshake: \(remote\) (KEX method|Host key format|C->S cipher|S->C cipher|C->S MAC|S->C MAC): (.*)$/;
const FAILED = [
    [/no matching key exchange/i, 'KEX method'],
    [/no matching host key/i, 'Host key format'],
    [/no matching C->S cipher/i, 'C->S cipher'],
    [/no matching S->C cipher/i, 'S->C cipher'],
    [/no matching C->S MAC/i, 'C->S MAC'],
    [/no matching S->C MAC/i, 'S->C MAC'],
];

function handshakeWatch() {
    const offered = {};
    return {
        // ssh2's `debug` option. Called for every packet, so the cheap
        // test goes first.
        debug(line) {
            if (typeof line !== 'string' || line.charCodeAt(0) !== 72 /* H */) return;
            const m = OFFERED.exec(line);
            if (m) offered[m[1]] = m[2];
        },
        // The error message, with what the device offered when that is
        // what failed.
        explain(message) {
            const hit = FAILED.find(([re]) => re.test(message || ''));
            const list = hit && offered[hit[1]];
            if (!list) return message;
            const names = list.split(',').filter((n) => n && !/^ext-info-|^kex-strict-/.test(n));
            let out = `${message} - the device offers ${names.join(', ') || 'nothing'}`;
            if (hit[1] === 'KEX method' && !legacyKex && names.some((n) => LEGACY_KEX.includes(n))) {
                out += '; Settings > SSH key exchange can offer SHA-1 for older gear';
            }
            return out;
        },
    };
}

module.exports = { configure, algorithms, isLegacyKex, handshakeWatch, LEGACY_KEX };
