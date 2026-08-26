'use strict';
// Dialing OUT through a proxy: SOCKS5 (RFC 1928) or HTTP CONNECT. The app
// can already SERVE a SOCKS proxy over -D; this is the other direction -
// corporate egress where 22 and 23 only leave the building through a
// proxy. No credentials in v1: the common egress for raw TCP is
// unauthenticated, and a proxy password would otherwise end up stored
// beside the session in plain text.
//
// The subtle part is the byte AFTER the handshake: SSH servers talk FIRST
// (the version banner), and a fast server's banner can share a TCP segment
// with the proxy's success reply. Anything read past the reply belongs to
// the tunneled protocol and is pushed back into the socket before the
// caller ever sees it - dropping it cost nothing visible except an SSH
// handshake that hangs forever, which is the worst kind of bug.

const net = require('net');

function parseProxy(str) {
    const m = /^(socks5|http):\/\/(\[[0-9a-fA-F:]+\]|[^:/\s]+):(\d{1,5})\/?$/
        .exec(String(str || '').trim());
    if (!m) {
        throw new Error(`not a usable proxy address: "${str}" - ` +
            'expected socks5://host:port or http://host:port');
    }
    const port = Number(m[3]);
    if (!port || port > 65535) throw new Error(`not a usable proxy port: ${m[3]}`);
    return { kind: m[1], host: m[2].replace(/^\[|\]$/g, ''), port };
}

// What the SOCKS reply codes mean to a person holding a console cable.
const SOCKS_REP = {
    1: 'the proxy failed internally',
    2: 'the proxy ruleset does not allow this connection',
    3: 'the network is unreachable from the proxy',
    4: 'the host is unreachable from the proxy',
    5: 'the target refused the connection',
    6: 'TTL expired at the proxy',
    7: 'the proxy does not support CONNECT',
    8: 'the proxy does not support this address type',
};

function socksAddress(host) {
    if (net.isIPv4(host)) {
        return Buffer.from([1, ...host.split('.').map(Number)]);
    }
    if (net.isIPv6(host)) {
        const b = Buffer.alloc(17);
        b[0] = 4;
        // Expand :: and write the eight groups.
        const parts = host.split('::');
        const head = parts[0] ? parts[0].split(':') : [];
        const tail = parts[1] !== undefined ? (parts[1] ? parts[1].split(':') : []) : [];
        const groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
        groups.forEach((g, i) => b.writeUInt16BE(parseInt(g || '0', 16), 1 + i * 2));
        return b;
    }
    // Hostnames go as domains, so DNS happens AT the proxy - resolving here
    // would leak lookups onto the local network and break split-horizon.
    const name = Buffer.from(String(host), 'utf8');
    if (name.length > 255) throw new Error('hostname too long for SOCKS');
    return Buffer.concat([Buffer.from([3, name.length]), name]);
}

// Connect through `proxyStr` to host:port. Resolves with a net.Socket that
// is ready for the tunneled protocol's first byte, in either direction.
function dial(proxyStr, host, port, timeoutMs) {
    const proxy = parseProxy(proxyStr);
    // The host reaches here from a session's `host` field, which travels in
    // the team file's SESSION_FIELDS and is never shape-checked on the way
    // in. HTTP CONNECT interpolates it into a request LINE, so a name
    // carrying CR/LF would split that request and let the file add headers
    // (or a second request) to whatever the proxy is asked for. SOCKS5 is
    // immune - it length-prefixes the name - but the check belongs on both
    // paths, because the next protocol added here will be textual again.
    const clean = String(host == null ? '' : host);
    if (!clean || /[\s\u0000-\u001f\u007f]/.test(clean)) {
        return Promise.reject(new Error(`not a usable host name: ${JSON.stringify(clean)}`));
    }
    host = clean;
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
        return Promise.reject(new Error(`not a usable port: ${port}`));
    }
    port = p;
    return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        let done = false;
        const sock = net.connect({ host: proxy.host, port: proxy.port });
        sock.setNoDelay(true);

        const deadline = setTimeout(() => {
            fail(new Error(`the proxy at ${proxy.host}:${proxy.port} did not finish in time`));
        }, timeoutMs || 15000);

        function fail(err) {
            if (done) return;
            done = true;
            clearTimeout(deadline);
            sock.destroy();
            reject(err);
        }

        function succeed(leftover) {
            if (done) return;
            done = true;
            clearTimeout(deadline);
            sock.removeListener('readable', onReadable);
            sock.removeListener('error', onError);
            sock.setTimeout(0);
            // The tunneled protocol's first bytes, if the server was fast.
            if (leftover && leftover.length) sock.unshift(leftover);
            resolve(sock);
        }

        const onError = (err) =>
            fail(new Error(`proxy ${proxy.host}:${proxy.port}: ${err.message}`));
        sock.on('error', onError);
        sock.on('close', () => fail(new Error(
            `the proxy at ${proxy.host}:${proxy.port} closed the connection mid-handshake`)));

        // 'readable' rather than 'data': the socket stays in paused mode,
        // so the handover to the real protocol owner (ssh2, the telnet
        // negotiator) starts flowing only when THEY attach.
        let step;
        const onReadable = () => {
            const chunk = sock.read();
            if (!chunk) return;
            buf = Buffer.concat([buf, chunk]);
            if (buf.length > 64 * 1024) return fail(new Error('the proxy is talking too much'));
            try { step(); } catch (err) { fail(err); }
        };
        sock.on('readable', onReadable);

        if (proxy.kind === 'socks5') {
            let phase = 'method';
            step = () => {
                if (phase === 'method') {
                    if (buf.length < 2) return;
                    if (buf[0] !== 5) throw new Error('that is not a SOCKS5 proxy');
                    if (buf[1] === 0xFF) {
                        throw new Error('the proxy requires authentication, ' +
                            'which this app does not send');
                    }
                    if (buf[1] !== 0) throw new Error('the proxy picked an auth method this app does not speak');
                    buf = buf.slice(2);
                    phase = 'reply';
                    sock.write(Buffer.concat([
                        Buffer.from([5, 1, 0]), socksAddress(host),
                        (() => { const p = Buffer.alloc(2); p.writeUInt16BE(port); return p; })(),
                    ]));
                }
                if (phase === 'reply') {
                    if (buf.length < 4) return;
                    const rep = buf[1];
                    // An address type outside 1/3/4 used to fall through to
                    // alen = 0, which silently misparses the rest of the
                    // reply instead of saying the proxy is speaking
                    // something this does not understand.
                    if (buf[3] !== 1 && buf[3] !== 3 && buf[3] !== 4) {
                        throw new Error(`SOCKS: the proxy replied with address type ${buf[3]}, ` +
                            'which this app does not understand');
                    }
                    const alen = buf[3] === 1 ? 4 : buf[3] === 4 ? 16
                        : (buf.length < 5 ? null : 1 + buf[4]);
                    if (alen === null) return;
                    const total = 4 + alen + 2;
                    if (buf.length < total) return;
                    if (rep !== 0) {
                        throw new Error(`SOCKS: ${SOCKS_REP[rep] || `reply code ${rep}`}`);
                    }
                    succeed(buf.slice(total));
                }
            };
            sock.on('connect', () => sock.write(Buffer.from([5, 1, 0])));
        } else {
            step = () => {
                const end = buf.indexOf('\r\n\r\n');
                if (end === -1) {
                    if (buf.length > 16 * 1024) throw new Error('the proxy reply never ended');
                    return;
                }
                const head = buf.slice(0, end).toString('latin1');
                const m = /^HTTP\/1\.[01] (\d{3})([^\r\n]*)/.exec(head);
                if (!m) throw new Error('that is not an HTTP proxy');
                if (m[1] !== '200') {
                    throw new Error(`the proxy refused CONNECT: ${m[1]}${m[2] || ''}`);
                }
                succeed(buf.slice(end + 4));
            };
            sock.on('connect', () => {
                const target = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
                sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
            });
        }
    });
}

module.exports = { dial, parseProxy };
