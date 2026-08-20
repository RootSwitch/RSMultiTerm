'use strict';
// Device reachability probing, to answer "which of these 400 saved sessions
// are devices that no longer exist". A TCP connect to the session's own port
// is the probe: it answers the question actually being asked ("can I still
// SSH to this"), needs no ICMP privileges, and does not lie about a host that
// pings but has management shut.
//
// Deliberately gentle. A fast sweep of a few hundred network devices looks
// exactly like a port scan to security monitoring, so: a small concurrency
// cap, a real timeout, and one retry before anything is called unreachable.
// Nothing here ever deletes a session - it only marks them for a human.

const net = require('net');

const DEFAULTS = { concurrency: 8, timeoutMs: 3000, retryDelayMs: 60000 };

// Resolves 'open' | 'refused' | 'timeout' | 'error'.
//
// Only 'open' counts as reachable, because the question this answers is
// "can I still get a session on this device", and a refused port means no.
// 'refused' is kept distinct from 'timeout' rather than folded into failure:
// something is answering at that address, which usually means the IP was
// reassigned or management moved, and that is a different fix from a device
// that has been decommissioned.
function probe(host, port, timeoutMs) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let done = false;
        const finish = (result) => {
            if (done) return;
            done = true;
            sock.destroy();
            resolve(result);
        };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => finish('open'));
        sock.once('timeout', () => finish('timeout'));
        sock.once('error', (err) => finish(err.code === 'ECONNREFUSED' ? 'refused' : 'error'));
        sock.connect(port, host);
    });
}

// targets: [{nodeId, host, port}]. onResult fires per device so the tree can
// fill in as it goes rather than after the whole sweep.
// opts.retryDelayMs = 0 makes the retry immediate, for tests.
async function run(targets, opts, onResult, shouldStop) {
    const cfg = { ...DEFAULTS, ...(opts || {}) };
    // Seam for tests: sweep behavior (retry, cap, cancel) is worth proving
    // deterministically, and real sockets can only be prodded into failing
    // by waiting out timeouts.
    const probeFn = cfg.probeFn || probe;
    const queue = targets.slice();
    const retries = [];
    const results = [];

    const worker = async () => {
        while (queue.length) {
            if (shouldStop && shouldStop()) return;
            const t = queue.shift();
            const state = await probeFn(t.host, t.port, cfg.timeoutMs);
            if (state === 'open') {
                const r = { ...t, reachable: true, state };
                results.push(r);
                onResult(r);
            } else {
                // One failure is not a verdict: a device can be mid-reload,
                // or a link can flap. Queue it for a second look.
                retries.push({ ...t, firstState: state });
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(cfg.concurrency, Math.max(targets.length, 1)) }, worker));

    if (retries.length && !(shouldStop && shouldStop())) {
        if (cfg.retryDelayMs) {
            await new Promise((r) => {
                const t = setTimeout(r, cfg.retryDelayMs);
                if (t.unref) t.unref();
            });
        }
        const retryQueue = retries.slice();
        const retryWorker = async () => {
            while (retryQueue.length) {
                if (shouldStop && shouldStop()) return;
                const t = retryQueue.shift();
                const state = await probeFn(t.host, t.port, cfg.timeoutMs);
                const r = { nodeId: t.nodeId, host: t.host, port: t.port, reachable: state === 'open', state };
                results.push(r);
                onResult(r);
            }
        };
        await Promise.all(Array.from({ length: Math.min(cfg.concurrency, retries.length) }, retryWorker));
    }

    return results;
}

module.exports = { run, probe, DEFAULTS };
