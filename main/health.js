'use strict';
// Reachability history, local only - never exported, never synced. Whether
// a device answered from YOUR machine says as much about your network path
// as about the device, so it is not something to publish to teammates.

const store = require('./store');

let data = null;
const listeners = [];

function init() {
    // Reachability history is a convenience; a wrong shape rebuilds it.
    data = store.shaped('health',
        (d) => d && typeof d === 'object' && d.nodes && typeof d.nodes === 'object',
        { schema: 1, nodes: {} });
}

function onChange(fn) { listeners.push(fn); }

function all() { return data.nodes; }

function get(nodeId) { return data.nodes[nodeId] || null; }

// streak counts consecutive failures, which is what "unreachable since" is
// derived from - a device that answers once resets it. lastState carries the
// distinction between "nothing there" and "something there that refused",
// which is what tells you a pruning candidate from a moved device.
function record(nodeId, reachable, state) {
    const now = new Date().toISOString();
    const prev = data.nodes[nodeId] || { lastOk: null, lastFail: null, streak: 0 };
    data.nodes[nodeId] = reachable
        ? { lastOk: now, lastFail: prev.lastFail, streak: 0, lastState: state || 'open' }
        : { lastOk: prev.lastOk, lastFail: now, streak: (prev.streak || 0) + 1, lastState: state || 'timeout' };
}

function flush() {
    store.save('health', data);
    for (const fn of listeners) fn();
}

function forget(nodeIds) {
    for (const id of nodeIds) delete data.nodes[id];
    flush();
}

// Sessions whose last success is older than `days` (or that have never
// answered), with at least one recorded failure - the prune candidates.
function staleNodeIds(days) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return Object.entries(data.nodes)
        .filter(([, h]) => {
            if (!h.lastFail) return false;
            if (!h.lastOk) return true;
            return Date.parse(h.lastOk) < cutoff;
        })
        .map(([id]) => id);
}

module.exports = { init, onChange, all, get, record, flush, forget, staleNodeIds };
