'use strict';
// Saved tunnel definitions. A tunnel names its SSH endpoint the same way a
// session does - by tree node id where possible, so an edited host or
// credential profile is picked up automatically - and is opened on demand
// (or on connect, when autoStart is set).
//
// Definitions carry no secrets: credentials come from the endpoint's
// credential profile at open time, through the same auth guard as sessions.

const store = require('./store');

let data = null;
const listeners = [];

const KINDS = new Set(['local', 'dynamic', 'remote']);

function init() {
    data = store.load('tunnels', { schema: 1, tunnels: [] });
}

function onChange(fn) { listeners.push(fn); }

function all() { return data.tunnels; }

function get(id) { return data.tunnels.find((t) => t.id === id) || null; }

function newId() {
    return 'tun-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// A tunnel is a small, entirely user-typed record, and the renderer that
// sends it parses hostile terminal output - so validate shape and ranges
// here rather than trusting it.
function validate(t) {
    if (!t || typeof t !== 'object') throw new Error('not a tunnel');
    if (!KINDS.has(t.kind)) throw new Error(`unknown tunnel kind: ${t.kind}`);
    if (typeof t.name !== 'string' || !t.name.trim()) throw new Error('a tunnel needs a name');
    if (!t.nodeId || typeof t.nodeId !== 'string') throw new Error('a tunnel needs an SSH endpoint');
    const port = (v, what) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${what} must be a port number`);
        return n;
    };
    const out = {
        id: typeof t.id === 'string' && t.id ? t.id : newId(),
        name: t.name.trim().slice(0, 120),
        kind: t.kind,
        nodeId: t.nodeId,
        bindHost: typeof t.bindHost === 'string' && t.bindHost.trim() ? t.bindHost.trim() : '127.0.0.1',
        bindPort: port(t.bindPort, 'listen port'),
        autoStart: !!t.autoStart,
        notes: typeof t.notes === 'string' ? t.notes.slice(0, 500) : '',
    };
    if (t.kind !== 'dynamic') {
        if (typeof t.destHost !== 'string' || !t.destHost.trim()) {
            throw new Error('a destination host is required');
        }
        out.destHost = t.destHost.trim();
        out.destPort = port(t.destPort, 'destination port');
    }
    return out;
}

function upsert(t) {
    const clean = validate(t);
    const at = data.tunnels.findIndex((x) => x.id === clean.id);
    if (at === -1) data.tunnels.push(clean);
    else data.tunnels[at] = clean;
    persist();
    return clean;
}

function remove(id) {
    data.tunnels = data.tunnels.filter((t) => t.id !== id);
    persist();
}

function persist() {
    store.save('tunnels', data);
    for (const fn of listeners) fn();
}

module.exports = { init, onChange, all, get, upsert, remove, newId, validate };
