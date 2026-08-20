'use strict';
// Engine entry - runs as an Electron utilityProcess forked by main. Hosts
// every connection so a native-module crash or a flood of terminal data never
// touches the main process event loop. Talks to main over process.parentPort;
// talks to each renderer pane directly over a per-session MessagePort that
// main hands us at connect time.

const crypto = require('crypto');
const { Session } = require('./session');

const sessions = new Map();          // sessionId -> Session
const pendingPorts = new Map();      // sessionId -> port (port can arrive first)

const send = (msg) => process.parentPort.postMessage(msg);

// Sessions announce their own death ('closed') when the REMOTE side hangs
// up, and the renderer deliberately keeps dead panes around (scrollback,
// R to reconnect) - reconnecting then mints a fresh sessionId, so no
// 'disconnect' ever arrives for the old one. Reap on the announcement; the
// 'disconnect' case below remains for renderer-initiated closes and
// tolerates finding nothing.
const sendAndReap = (msg) => {
    if (msg && msg.t === 'closed' && sessions.has(msg.sessionId)) {
        sessions.delete(msg.sessionId);
        require('./sftp').drop(msg.sessionId);
    }
    send(msg);
};

// Host key checks round-trip to main, which owns the TOFU store and the user
// dialog. The engine only hashes and waits.
const hostkeyWaiters = new Map();    // checkId -> resolve(bool)
let nextCheckId = 1;

function verifyHostkey(host, port, keyBlob) {
    return new Promise((resolve) => {
        const checkId = nextCheckId++;
        hostkeyWaiters.set(checkId, resolve);
        send({
            t: 'hostkey-check', checkId, host, port,
            fingerprint: 'SHA256:' + crypto.createHash('sha256')
                .update(keyBlob).digest('base64').replace(/=+$/, ''),
        });
        // A vanished main process must not park the connect forever.
        setTimeout(() => {
            if (hostkeyWaiters.delete(checkId)) resolve(false);
        }, 120 * 1000).unref();
    });
}

const helpers = { verifyHostkey };

// Per-run cancellation flags. One global boolean had two bugs: starting a
// second sweep un-cancelled a first one that was just stopped, and stop
// could not tell runs apart. Stop still means "stop every running sweep" -
// that is what the button says - but a new start no longer revives anything.
const healthRuns = new Map();   // runId -> {stopped: bool}

process.parentPort.on('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
        case 'port': {
            const port = e.ports[0];
            const s = sessions.get(m.sessionId);
            if (s) s.attachPort(port);
            else pendingPorts.set(m.sessionId, port);
            break;
        }
        case 'connect': {
            let s;
            try {
                s = new Session(m.sessionId, m.descriptor, sendAndReap, helpers);
            } catch (err) {
                send({ t: 'connect-failed', sessionId: m.sessionId, message: err.message });
                break;
            }
            sessions.set(m.sessionId, s);
            const port = pendingPorts.get(m.sessionId);
            if (port) { s.attachPort(port); pendingPorts.delete(m.sessionId); }
            s.connect(m.auth, m.authByProfile);
            break;
        }
        case 'hostkey-answer': {
            const resolve = hostkeyWaiters.get(m.checkId);
            if (resolve) { hostkeyWaiters.delete(m.checkId); resolve(!!m.accept); }
            break;
        }
        case 'write': {
            const s = sessions.get(m.sessionId);
            if (s) s.transport.write(m.data);
            break;
        }
        case 'disconnect': {
            const s = sessions.get(m.sessionId);
            if (s) { s.close(); sessions.delete(m.sessionId); }
            // The cached SFTP channel and mode verdict die with the session;
            // without this the maps grow for the life of the engine process.
            require('./sftp').drop(m.sessionId);
            break;
        }
        case 'key-install': {
            const ki = sessions.get(m.sessionId);
            if (!ki) {
                send({ t: 'key-install-result', reqId: m.reqId, ok: false, error: 'session not found' });
                break;
            }
            require('./key-install').install(ki, m.publicLine).then(
                (result) => send({ t: 'key-install-result', reqId: m.reqId, ok: true, result }),
                (err) => send({ t: 'key-install-result', reqId: m.reqId, ok: false, error: err.message }));
            break;
        }
        case 'sftp': {
            const s = sessions.get(m.sessionId);
            if (!s) {
                send({ t: 'sftp-result', reqId: m.reqId, ok: false, error: 'session not found' });
                break;
            }
            require('./sftp').run(s, m.req, (p) => {
                send({ t: 'sftp-progress', sessionId: m.sessionId, reqId: m.reqId, bytes: p.bytes, total: p.total });
            }).then(
                (result) => send({ t: 'sftp-result', reqId: m.reqId, ok: true, result }),
                (err) => send({ t: 'sftp-result', reqId: m.reqId, ok: false, error: err.message }));
            break;
        }
        case 'tunnel-open': {
            const tun = require('./tunnels');
            // Tunnel hops authenticate exactly like session hops, through
            // the same pool - so a tunnel behind a bastion rides the
            // connection the terminals already authenticated.
            const helpers2 = {
                verifyHostkey,
                authFor: (name) => (m.authByProfile || {})[name] || null,
            };
            tun.open(m.spec, helpers2, send).then(
                (st) => send({ t: 'tunnel-result', reqId: m.reqId, ok: true, result: st }),
                (err) => send({ t: 'tunnel-result', reqId: m.reqId, ok: false, error: err.message }));
            break;
        }
        case 'tunnel-close': {
            const tun = require('./tunnels');
            send({ t: 'tunnel-result', reqId: m.reqId, ok: true, result: tun.close(m.id) });
            break;
        }
        case 'tunnel-list': {
            const tun = require('./tunnels');
            send({ t: 'tunnel-result', reqId: m.reqId, ok: true, result: tun.list() });
            break;
        }
        case 'healthcheck': {
            const hc = require('./healthcheck');
            const ctl = { stopped: false };
            healthRuns.set(m.runId, ctl);
            hc.run(m.targets, m.opts,
                (r) => send({ t: 'health-result', runId: m.runId, ...r }),
                () => ctl.stopped)
                .then((results) => send({ t: 'health-done', runId: m.runId, count: results.length }))
                .catch((err) => send({ t: 'health-done', runId: m.runId, error: err.message }))
                .finally(() => healthRuns.delete(m.runId));
            break;
        }
        case 'healthcheck-stop':
            for (const ctl of healthRuns.values()) ctl.stopped = true;
            break;
        case 'list-serial': {
            require('./transports/serial').listPorts()
                .then((ports) => send({ t: 'serial-ports', reqId: m.reqId, ports }))
                .catch((err) => send({ t: 'serial-ports', reqId: m.reqId, ports: [], error: err.message }));
            break;
        }
        case 'shutdown': {
            // Close everything deliberately (flushes logs once logging
            // lands), then exit so main never has to SIGKILL us.
            require('./tunnels').closeAll();
            Promise.allSettled([...sessions.values()].map((s) => s.close()))
                .then(() => process.exit(0));
            break;
        }
    }
});

send({ t: 'engine-ready', pid: process.pid });
