'use strict';
// JSON persistence with atomic writes, ported from rsoperator's store (same
// author, same hard-won details). Everything lives under the data dir:
// sessions.json, profiles.json, settings.json, known_hosts.json,
// team-cache.json, overrides.json, highlights.json, health.json.
//
// atomicWrite: temp file + fsync + rename. Without the fsync the rename can
// land before the data does, so a power loss leaves a present-but-empty file.
// The temp name carries pid + counter because a fixed ".tmp" lets two
// processes interleave onto the same path. Windows fails the rename
// EPERM/EBUSY when AV or a sync client holds the destination open, so retry
// briefly before giving up.
//
// loadCritical: absence and corruption mean different things. A tolerant
// loader that hands back the fallback for a truncated file is how a store
// silently "loses" every saved session after a power cut; fail closed instead.

const fs = require('fs');
const path = require('path');

let dataDir = null;

function init(dir) {
    dataDir = dir;
    fs.mkdirSync(dataDir, { recursive: true });
}

function fileOf(name) {
    if (!dataDir) throw new Error('store.init(dir) not called');
    return path.join(dataDir, name + '.json');
}

let tmpCounter = 0;
function atomicWrite(file, obj) {
    const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try {
        fs.renameSync(tmp, file);
    } catch (err) {
        if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') {
            try { fs.unlinkSync(tmp); } catch (_) { /* already gone */ }
            throw err;
        }
        let renamed = false;
        for (let i = 0; i < 20 && !renamed; i++) {
            try {
                fs.renameSync(tmp, file);
                renamed = true;
            } catch (_) {
                // Busy-wait deliberately: synchronous API, nowhere to await.
                // 20 x ~5ms is the whole budget.
                const until = Date.now() + 5;
                while (Date.now() < until) { /* spin */ }
            }
        }
        if (!renamed) {
            try { fs.unlinkSync(tmp); } catch (_) { /* already gone */ }
            throw err;
        }
    }
}

// Tolerant load: anything wrong returns the fallback. For files where a
// wrong "empty" answer is harmless (settings, health cache).
// A UTF-8 BOM is invisible in every editor and fatal to JSON.parse. Files
// here are written by the app, but they are plain JSON in a folder people
// open - one save from Notepad or a PowerShell redirect adds one, and
// without this the app refuses to start with a modal about corruption.
function parseJson(raw) {
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

function load(name, fallback) {
    try {
        return parseJson(fs.readFileSync(fileOf(name), 'utf8'));
    } catch (_) {
        return fallback;
    }
}

// Missing returns the fallback; present-but-unreadable or corrupt THROWS so
// callers fail closed. For sessions and profiles, where "empty" would cascade
// into overwriting the user's data with nothing.
function loadCritical(name, fallback) {
    const file = fileOf(name);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return fallback;
        throw new Error(`cannot read ${name}.json (${err.message}) - refusing to treat it as empty`);
    }
    if (!raw.trim()) {
        throw new Error(`${name}.json exists but is empty - refusing to treat it as empty. ` +
            'Restore it from a backup, or delete it deliberately to start over.');
    }
    try {
        return parseJson(raw);
    } catch (err) {
        throw new Error(`${name}.json is not valid JSON (${err.message}) - refusing to treat it as empty`);
    }
}

function save(name, obj) {
    atomicWrite(fileOf(name), obj);
}

// Shape guards. load()/loadCritical() verify a file PARSES; neither
// verified it was the right shape, so a file that is valid JSON but
// structurally wrong sailed through both and threw somewhere later -
// `highlights.json` containing {"schema":1} threw inside app.whenReady and
// the window never opened, with none of the friendly recovery loadCritical
// exists to provide.
//
// shaped() is for files that can be rebuilt: wrong shape means the default,
// and the caller is told so it can say something. shapedCritical() is for
// files where "default" would mean losing the user's data, so a wrong
// shape throws exactly like corrupt JSON does.
function shaped(name, isValid, fallback, onBad) {
    const data = load(name, null);
    if (data !== null && isValid(data)) return data;
    if (data !== null && onBad) {
        onBad(`${name}.json is not shaped like a ${name} file - starting from defaults. ` +
            'The old file is left on disk.');
    }
    return fallback;
}

function shapedCritical(name, isValid, fallback) {
    const data = loadCritical(name, null);
    if (data === null) return fallback;   // genuinely absent: a fresh install
    if (!isValid(data)) {
        throw new Error(`${name}.json is not valid ${name} data - refusing to start ` +
            'rather than treat it as empty. Move the file aside to start fresh.');
    }
    return data;
}

module.exports = { init, load, loadCritical, save, atomicWrite, shaped, shapedCritical };
