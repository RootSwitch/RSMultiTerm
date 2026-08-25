'use strict';
// Port forwarding: local (-L), dynamic SOCKS (-D) and remote (-R), each
// riding an SSH connection from the shared hop pool.
//
// The pool is the whole point of putting tunnels here. A tunnel to a device
// behind the same bastion your sessions use SHARES that bastion connection:
// one authentication, one TCP session, however many tunnels and terminals
// ride it. That is also the lockout protection - a tunnel is not a second
// AD attempt - and it means closing the last consumer tears the gateway
// down on its own through the existing refcounting.
//
// A tunnel's chain is [...jumpChain, endpoint]: the endpoint is just the
// last hop, so "tunnel through a bastion to a device" and "tunnel straight
// to a box" are the same code path.

const net = require('net');
const hopPool = require('./hop-pool');

const tunnels = new Map();   // id -> record

// SOCKS5, enough of it: no auth, CONNECT only, IPv4 / IPv6 / domain. UDP
// associate and BIND are refused - a browser or an RDP client wants CONNECT
// and nothing else.
const SOCKS_VER = 0x05;
const CMD_CONNECT = 0x01;
const ATYP = { IPV4: 0x01, DOMAIN: 0x03, IPV6: 0x04 };

function socksHandshake(sock, onTarget) {
    let stage = 'greeting';
    let buf = Buffer.alloc(0);

    const refuse = (code) => {
        // Reply with the failure code, then hang up. The client may already
        // be gone (port scanners hang up first); a refusal must never throw.
        try {
            sock.end(Buffer.from([SOCKS_VER, code, 0x00, ATYP.IPV4, 0, 0, 0, 0, 0, 0]));
        } catch (_) { sock.destroy(); }
    };

    sock.on('data', function onData(chunk) {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
            if (stage === 'greeting') {
                if (buf.length < 2) return;
                const nMethods = buf[1];
                if (buf.length < 2 + nMethods) return;
                if (buf[0] !== SOCKS_VER) { sock.destroy(); return; }
                buf = buf.subarray(2 + nMethods);
                // 0x00 = no authentication. The listener is bound to
                // loopback, so the OS is the access control.
                sock.write(Buffer.from([SOCKS_VER, 0x00]));
                stage = 'request';
                continue;
            }
            if (stage === 'request') {
                if (buf.length < 4) return;
                if (buf[0] !== SOCKS_VER) { sock.destroy(); return; }
                const cmd = buf[1];
                const atyp = buf[3];
                let host;
                let offset;
                if (atyp === ATYP.IPV4) {
                    if (buf.length < 10) return;
                    host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
                    offset = 8;
                } else if (atyp === ATYP.DOMAIN) {
                    const len = buf[4];
                    if (buf.length < 5 + len + 2) return;
                    host = buf.subarray(5, 5 + len).toString('utf8');
                    offset = 5 + len;
                } else if (atyp === ATYP.IPV6) {
                    if (buf.length < 22) return;
                    const parts = [];
                    for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16));
                    host = parts.join(':');
                    offset = 20;
                } else {
                    refuse(0x08);   // address type not supported
                    return;
                }
                const port = buf.readUInt16BE(offset);
                buf = buf.subarray(offset + 2);
                if (cmd !== CMD_CONNECT) { refuse(0x07); return; }
                stage = 'done';
                // pause() before dropping the listener: removing it leaves
                // the socket FLOWING, and data emitted with no listener is
                // gone. A client that pipelines its payload in a separate
                // packet - without waiting for the reply - lost those bytes
                // during the SSH channel-open round trip, corrupting the
                // connection undetectably. bridge()'s pipe() resumes.
                sock.pause();
                sock.removeListener('data', onData);
                onTarget(host, port, (ok) => {
                    if (!ok) return refuse(0x05);
                    sock.write(Buffer.from([SOCKS_VER, 0x00, 0x00, ATYP.IPV4, 0, 0, 0, 0, 0, 0]));
                    // Anything the client pipelined behind the request.
                    if (buf.length) sock.unshift(buf);
                });
                return;
            }
            return;
        }
    });
}

// Pipe a local socket to an ssh2 channel, counting bytes for the UI. Both
// ends close each other: a browser tab closing must free the channel, and
// the far side hanging up must free the socket.
function bridge(rec, sock, channel) {
    rec.conns++;
    rec.active++;
    sock.on('error', () => sock.destroy());
    channel.on('error', () => sock.destroy());
    sock.on('data', (d) => { rec.bytesUp += d.length; });
    channel.on('data', (d) => { rec.bytesDown += d.length; });
    sock.on('close', () => {
        rec.active = Math.max(0, rec.active - 1);
        if (channel.close) channel.close();
    });
    channel.on('close', () => sock.destroy());
    sock.pipe(channel).pipe(sock);
}

// spec: {id, kind:'local'|'dynamic'|'remote', chain:[hops...],
//        bindHost, bindPort, destHost, destPort}
// chain is [...jumpChain, endpoint]; the endpoint hop is where the tunnel
// terminates and from which the far side dials.
async function open(spec, helpers, onEvent) {
    if (tunnels.has(spec.id)) throw new Error('tunnel already open');
    const rec = {
        id: spec.id, spec, handle: null, server: null,
        conns: 0, active: 0, bytesUp: 0, bytesDown: 0,
        state: 'opening',
        unhook: null,   // removes this tunnel's listeners from the client
        onTcp: null,
    };
    tunnels.set(spec.id, rec);

    const fail = (err) => {
        rec.state = 'error';
        if (rec.unhook) rec.unhook();
        if (rec.handle) { rec.handle.release(); rec.handle = null; }
        if (rec.server) { try { rec.server.close(); } catch (_) { /* not listening */ } }
        tunnels.delete(spec.id);
        onEvent({ t: 'tunnel-state', id: spec.id, state: 'error', detail: err.message });
        throw err;
    };

    try {
        rec.handle = await hopPool.acquire(spec.chain, helpers);
    } catch (err) {
        return fail(err);
    }
    const client = rec.handle.client;

    // The gateway dying takes its tunnels with it; say so rather than
    // leaving a listener that accepts into a dead connection. The handlers
    // are NAMED and unhooked when the tunnel closes: this client is a
    // shared pooled connection, and anonymous listeners survived close(),
    // so every open/close cycle on a long-lived bastion grew the listener
    // list - and for -R, a stale 'tcp connection' handler would also
    // double-accept if the same port was ever forwarded again.
    const onClientClose = () => {
        if (rec.unhook) rec.unhook();
        if (!tunnels.has(spec.id)) return;
        rec.state = 'closed';
        if (rec.server) { try { rec.server.close(); } catch (_) { /* fine */ } }
        tunnels.delete(spec.id);
        onEvent({ t: 'tunnel-state', id: spec.id, state: 'closed', detail: 'the SSH connection closed' });
    };
    client.on('close', onClientClose);
    rec.unhook = () => {
        rec.unhook = null;
        client.removeListener('close', onClientClose);
        if (rec.onTcp) client.removeListener('tcp connection', rec.onTcp);
    };

    if (spec.kind === 'remote') {
        // -R: the SERVER listens; incoming channels are dialed locally.
        await new Promise((resolve, reject) => {
            client.forwardIn(spec.bindHost || '127.0.0.1', spec.bindPort, (err, actualPort) => {
                if (err) return reject(err);
                rec.boundPort = actualPort || spec.bindPort;
                resolve();
            });
        }).catch(fail);

        rec.onTcp = (info, accept) => {
            if (info.destPort !== (rec.boundPort || spec.bindPort)) return;
            const channel = accept();
            // Same rule as the accept path above: first listener before any
            // async work, or a channel error while the local dial is in
            // flight is an uncaught throw.
            channel.on('error', () => { try { channel.close(); } catch (_) { /* gone */ } });
            const out = net.connect(spec.destPort, spec.destHost);
            out.on('connect', () => bridge(rec, out, channel));
            out.on('error', () => channel.close());
        };
        client.on('tcp connection', rec.onTcp);
    } else {
        // -L and -D both listen locally; they differ only in where the
        // destination comes from (fixed vs. per-connection SOCKS request).
        const server = net.createServer();
        rec.server = server;
        server.on('connection', (sock) => {
            // The error listener goes on BEFORE any async work. bridge()
            // attaches one too, but only after the forwardOut round trip -
            // and a client that resets in that window (a closed browser
            // tab, a port scanner) emits 'error' with no listener, which
            // throws, and an uncaught throw here takes the whole engine
            // down: every session, tunnel and transfer at once.
            sock.on('error', () => sock.destroy());
            if (spec.kind === 'local') {
                client.forwardOut('127.0.0.1', 0, spec.destHost, spec.destPort, (err, channel) => {
                    if (err) { sock.destroy(); return; }
                    bridge(rec, sock, channel);
                });
                return;
            }
            socksHandshake(sock, (host, port, reply) => {
                client.forwardOut('127.0.0.1', 0, host, port, (err, channel) => {
                    if (err) { reply(false); return; }
                    reply(true);
                    bridge(rec, sock, channel);
                });
            });
        });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            // Loopback by default: a tunnel listening on 0.0.0.0 turns this
            // machine into an open relay onto the management network, which
            // is a decision worth typing out rather than defaulting into.
            server.listen(spec.bindPort, spec.bindHost || '127.0.0.1', () => {
                rec.boundPort = server.address().port;
                resolve();
            });
        }).catch(fail);
    }

    rec.state = 'open';
    onEvent({ t: 'tunnel-state', id: spec.id, state: 'open', boundPort: rec.boundPort });
    return status(spec.id);
}

function close(id) {
    const rec = tunnels.get(id);
    if (!rec) return { closed: false };
    if (rec.unhook) rec.unhook();
    if (rec.server) { try { rec.server.close(); } catch (_) { /* not listening */ } }
    if (rec.spec.kind === 'remote' && rec.handle) {
        try { rec.handle.client.unforwardIn(rec.spec.bindHost || '127.0.0.1', rec.boundPort); } catch (_) { /* gone */ }
    }
    if (rec.handle) { rec.handle.release(); rec.handle = null; }
    tunnels.delete(id);
    return { closed: true };
}

function status(id) {
    const rec = tunnels.get(id);
    if (!rec) return null;
    return {
        id: rec.id, kind: rec.spec.kind, state: rec.state,
        bindHost: rec.spec.bindHost || '127.0.0.1',
        bindPort: rec.boundPort || rec.spec.bindPort,
        destHost: rec.spec.destHost, destPort: rec.spec.destPort,
        conns: rec.conns, active: rec.active,
        bytesUp: rec.bytesUp, bytesDown: rec.bytesDown,
    };
}

function list() {
    return [...tunnels.keys()].map(status).filter(Boolean);
}

function closeAll() {
    for (const id of [...tunnels.keys()]) close(id);
}

module.exports = { open, close, status, list, closeAll };
