'use strict';
// Healthcheck tests. Two layers, deliberately:
//   - probe() against real sockets, because "what counts as reachable" must
//     be true of actual TCP, not of a mock.
//   - the sweep (retry, concurrency cap, cancel) against an injected probe,
//     because those behaviors can only be provoked from real sockets by
//     waiting out timeouts, which makes a test slow and flaky rather than
//     conclusive.

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const hc = require('../engine/healthcheck');
const store = require('../main/store');
const health = require('../main/health');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-health-'));
store.init(dir);
health.init();

// RFC 5737 documentation address: routed nowhere, so a connect hangs until
// our timeout instead of being refused.
const BLACKHOLE = '192.0.2.1';

function listen() {
    return new Promise((resolve) => {
        const srv = net.createServer((s) => s.destroy());
        srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
}
function freePort() {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}
// Scripted probe: per nodeId, the states to return in order (last repeats).
function scriptedProbe(script, log) {
    const counts = new Map();
    return (host, port) => {
        const key = `${host}:${port}`;
        const n = counts.get(key) || 0;
        counts.set(key, n + 1);
        if (log) log.push({ key, attempt: n + 1 });
        const states = script[key] || ['open'];
        return Promise.resolve(states[Math.min(n, states.length - 1)]);
    };
}

(async () => {
    const srv = await listen();
    const openPort = srv.address().port;
    const closedPort = await freePort();

    try {
        // --- real sockets -------------------------------------------------
        // 1. A listening port is 'open'. An unused one is 'refused' - a
        // distinct state, because something answered at that address even
        // though the service is not there.
        assert.strictEqual(await hc.probe('127.0.0.1', openPort, 2000), 'open');
        assert.strictEqual(await hc.probe('127.0.0.1', closedPort, 2000), 'refused');

        // 2. An unroutable address times out instead of hanging forever.
        const started = Date.now();
        const state = await hc.probe(BLACKHOLE, 22, 700);
        const elapsed = Date.now() - started;
        assert.ok(state === 'timeout' || state === 'error',
            `expected timeout/error for a black hole, got ${state}`);
        assert.ok(elapsed < 4000, `timeout took ${elapsed}ms - the cap is not honored`);

        // 3. Reachability over a real sweep. Only an open port counts as
        // reachable: the question is "can I still get a session here", and a
        // refused port answers no - but it is reported as 'refused' rather
        // than silence, because that distinguishes a reassigned address from
        // a decommissioned device.
        const real = await hc.run([
            { nodeId: 'a', host: '127.0.0.1', port: openPort },
            { nodeId: 'b', host: '127.0.0.1', port: closedPort },
        ], { timeoutMs: 600, retryDelayMs: 0 }, () => {});
        const realById = Object.fromEntries(real.map((r) => [r.nodeId, r]));
        assert.strictEqual(realById.a.reachable, true);
        assert.strictEqual(realById.b.reachable, false, 'a refused port is not a usable session');
        assert.strictEqual(realById.b.state, 'refused', 'refused is reported distinctly');

        // --- scripted sweep behavior --------------------------------------
        // 4. The retry is load-bearing: a device that is down for the first
        // probe and up for the second must end up reachable. Without a retry
        // the mid-reload switch this protects gets condemned.
        const attempts = [];
        const flap = await hc.run(
            [{ nodeId: 'flap', host: '10.0.0.1', port: 22 }],
            {
                retryDelayMs: 0,
                probeFn: scriptedProbe({ '10.0.0.1:22': ['timeout', 'open'] }, attempts),
            }, () => {});
        assert.strictEqual(flap.length, 1, 'a retried device reports once, not twice');
        assert.strictEqual(flap[0].reachable, true,
            'a device that recovers before the retry must not be marked unreachable');
        assert.strictEqual(attempts.length, 2, 'exactly one retry, not a loop');

        // 5. Still failing on the retry means unreachable, reported once.
        const seen = [];
        const dead = await hc.run(
            [{ nodeId: 'dead', host: '10.0.0.2', port: 22 }],
            { retryDelayMs: 0, probeFn: scriptedProbe({ '10.0.0.2:22': ['timeout'] }) },
            (r) => seen.push(r));
        assert.strictEqual(dead.length, 1);
        assert.strictEqual(dead[0].reachable, false);
        assert.strictEqual(seen.length, 1, 'progress fires once per device, not once per attempt');

        // 6. Concurrency is capped: with a cap of 2, no more than 2 probes
        // are ever in flight.
        let inFlight = 0, peak = 0;
        const slowProbe = () => new Promise((resolve) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            setTimeout(() => { inFlight--; resolve('open'); }, 20);
        });
        await hc.run(
            Array.from({ length: 12 }, (_, i) => ({ nodeId: `s${i}`, host: `10.1.0.${i}`, port: 22 })),
            { concurrency: 2, retryDelayMs: 0, probeFn: slowProbe }, () => {});
        assert.strictEqual(peak, 2, `cap of 2 exceeded: ${peak} probes in flight`);

        // 7. Cancellation stops the sweep part way.
        let stop = false;
        const done = [];
        await hc.run(
            Array.from({ length: 30 }, (_, i) => ({ nodeId: `m${i}`, host: `10.2.0.${i}`, port: 22 })),
            {
                concurrency: 2, retryDelayMs: 0,
                probeFn: () => new Promise((r) => {
                    if (done.length >= 6) stop = true;
                    setTimeout(() => r('open'), 5);
                }),
            },
            (r) => done.push(r), () => stop);
        assert.ok(done.length < 30, `cancel should cut the sweep short, saw ${done.length}`);

        // --- history --------------------------------------------------------
        // 8. Failures accumulate a streak, a success clears it, and only
        // devices that have actually failed count as prune candidates.
        health.record('a', true, 'open');
        health.record('b', false, 'timeout');
        health.record('b', false, 'refused');
        health.flush();
        assert.strictEqual(health.get('b').lastState, 'refused',
            'the last probe state is kept, so the tree can tell refused from silent');
        assert.strictEqual(health.get('b').streak, 2, 'consecutive failures accumulate');
        assert.strictEqual(health.get('a').streak, 0);
        assert.deepStrictEqual(health.staleNodeIds(14), ['b'],
            'never-answered devices with failures are prune candidates');
        health.record('b', true, 'open');
        health.flush();
        assert.strictEqual(health.get('b').streak, 0, 'one success resets the streak');
        assert.deepStrictEqual(health.staleNodeIds(14), [], 'a recovered device is not stale');

        // 9. History survives a reload; forget() clears it.
        health.init();
        assert.ok(health.get('a'), 'history persisted');
        health.forget(['a', 'b']);
        health.init();
        assert.strictEqual(health.get('a'), null, 'forget removes history');

        console.log('ok - healthcheck (probe states, retry, cap, cancel, history)');
    } finally {
        srv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error('FAIL -', err.stack || err.message); process.exit(1); });
