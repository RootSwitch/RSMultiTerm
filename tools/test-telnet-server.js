'use strict';
// Telnet fixture server: negotiates like real network gear (WILL ECHO,
// WILL SGA, DO NAWS), strips inbound IAC sequences, then runs the shared
// fake-device shell.
//
//   node tools/test-telnet-server.js [port] [deviceName]

const net = require('net');
const { attachShell } = require('./fake-device');

const PORT = Number(process.argv[2]) || 2323;
const NAME = process.argv[3] || 'core-sw-01';

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const OPT_ECHO = 1, OPT_SGA = 3, OPT_NAWS = 31;

net.createServer((sock) => {
    sock.setNoDelay(true);
    sock.write(Buffer.from([IAC, WILL, OPT_ECHO, IAC, WILL, OPT_SGA, IAC, DO, OPT_NAWS]));

    // Server-side IAC stripper: enough of a state machine to swallow client
    // replies and NAWS reports so they never reach the shell as input.
    let state = 0;   // 0 data, 1 iac, 2 negotiate, 3 sb, 4 sb-iac
    const shellWrite = attachShell(sock, { name: NAME });
    sock.on('data', (buf) => {
        const clean = [];
        for (const b of buf) {
            if (state === 0) { if (b === IAC) state = 1; else clean.push(b); }
            else if (state === 1) {
                if (b === IAC) { clean.push(IAC); state = 0; }
                else if (b === SB) state = 3;
                else if (b === WILL || b === WONT || b === DO || b === DONT) state = 2;
                else state = 0;
            }
            else if (state === 2) state = 0;
            else if (state === 3) { if (b === IAC) state = 4; }
            else if (state === 4) { if (b === SE) state = 0; else if (b === IAC) state = 3; else state = 3; }
        }
        if (clean.length) shellWrite(Buffer.from(clean));
    });
    sock.on('error', () => { /* client went away; fine */ });
}).listen(PORT, '127.0.0.1', () => {
    console.log(`test-telnet-server (${NAME}) listening on 127.0.0.1:${PORT}`);
});
