'use strict';
// The fictional-estate switch shared by every fixture server (SSH, telnet).
// One line-oriented shell: echo, backspace, canned commands, flood generator.
// Servers hand it a writable stream-ish object; it stays transport-blind.

const SHOW_VERSION = [
    'RSNet IOS Software, C9300 Software (CAT9K_IOSXE), Version 17.9.4a',
    'Technical Support: https://support.example.com',
    'Copyright (c) 2026 Example Networks',
    '',
    '{name} uptime is 41 weeks, 3 days, 2 hours, 11 minutes',
    'System image file is "flash:cat9k_iosxe.17.09.04a.SPA.bin"',
    '',
    'cisco C9300-48P (X86) processor with 1300K bytes of memory.',
    'Base Ethernet MAC Address : 00:00:5e:00:53:01',
    '',
].join('\r\n');

const SHOW_INT_STATUS = [
    'Port      Name               Status       Vlan       Duplex  Speed Type',
    'Gi1/0/1   uplink-core        connected    trunk        full     1G 1000BaseT',
    'Gi1/0/2   ap-floor2          connected    120          full     1G 1000BaseT',
    'Gi1/0/3                      notconnect   1            auto   auto 1000BaseT',
    'Gi1/0/4   cam-lobby          err-disabled 130          auto   auto 1000BaseT',
    'Gi1/0/5   printer-hr         disabled     110          auto   auto 1000BaseT',
    'Gi1/0/6   legacy-scanner     connected    110          half   100M 100BaseTX',
    'Te1/1/1   uplink-dc          connected    trunk        full    10G 10GBase-LR SM',
    'Te1/1/2   uplink-idf2        connected    trunk        full    10G 10GBase-SR MM',
    'Twe1/1/3  core-mesh          connected    trunk        full    25G 25GBase-SR MM',
    '',
].join('\r\n');

const SHOW_IP_ARP = [
    'Protocol  Address          Age (min)  Hardware Addr   Type   Interface',
    'Internet  192.0.2.1                5  0000.5e00.5301  ARPA   Vlan120',
    'Internet  192.0.2.10               -  0000.5e00.5302  ARPA   GigabitEthernet1/0/1',
    'Internet  198.51.100.7            12  0000.5e00.5307  ARPA   TenGigabitEthernet1/1/1',
    'Internet  203.0.113.42           201  0000.5e00.53aa  ARPA   Loopback0',
    '',
    'IPv6 neighbor: 2001:db8:0:1::7 lladdr 00:00:5e:00:53:07 Port-channel10',
    '',
].join('\r\n');

// stream needs write(str) -> bool, once('drain', cb), end(). name appears in
// the prompt so multi-session tests can tell panes apart at a glance.
function attachShell(stream, opts = {}) {
    const name = opts.name || 'core-sw-01';
    // What the CLIENT told us the window is. `size` prints it so a test
    // can compare the shell's view against the terminal's actual
    // geometry - a disagreement is what corrupts wrapped-line redraws.
    const winSize = opts.winSize || { cols: 0, rows: 0, ptyCols: 0, ptyRows: 0, resizes: 0 };
    let line = '';

    // OSC 133 semantic marks, like a shell with integration installed:
    // A prompt-start, B prompt-end, C output-begins, D;exit done. Real IOS
    // emits nothing of the sort, but the fixture doubles as the test bed
    // for the app's prompt-navigation and copy-last-output features, and a
    // terminal that ignores them sees the same bytes minus the marks.
    const OSC = (s) => `\x1b]133;${s}\x07`;
    const prompt = () => OSC('A') + `${name}#` + OSC('B');
    const done = (code) => OSC(`D;${code}`) + prompt();

    // Opt-in bracketed paste, the way a Linux shell (bash 5.1+) behaves:
    // announce DECSET 2004 so the terminal wraps pastes, and strip the
    // markers from input. Real network gear never does this, so it is
    // off unless the server asks for it - but with it on, the paste
    // pipeline is testable end to end.
    const bracketed = !!opts.bracketed;
    stream.write(`\r\n${name} line vty 0\r\n\r\n` + (bracketed ? '\x1b[?2004h' : '') + prompt());

    const onData = (data) => {
        let text = data.toString('utf8');
        if (bracketed) {
            text = text.split('\x1b[200~').join('').split('\x1b[201~').join('');
        }
        for (const ch of text) {
            if (ch === '\r') {
                stream.write('\r\n' + OSC('C'));
                runCommand(line.trim());
                line = '';
            } else if (ch === '\x7f' || ch === '\b') {
                if (line.length) {
                    line = line.slice(0, -1);
                    stream.write('\b \b');
                }
            } else if (ch >= ' ') {
                line += ch;
                stream.write(ch);   // echo, like a real vty
            }
        }
    };

    function runCommand(cmd) {
        if (cmd === '') {
            stream.write(done(0));
        } else if (cmd === 'show version') {
            stream.write(SHOW_VERSION.replaceAll('{name}', name) + done(0));
        } else if (cmd === 'show int status' || cmd === 'show interfaces status') {
            stream.write(SHOW_INT_STATUS + done(0));
        } else if (cmd === 'show ip arp' || cmd === 'show arp') {
            stream.write(SHOW_IP_ARP + done(0));
        } else if (cmd.startsWith('flood')) {
            flood(stream, Math.min(Number(cmd.split(/\s+/)[1]) || 50, 500), done(0));
        } else if (cmd === 'size') {
            stream.write(`cols=${winSize.cols} rows=${winSize.rows} ` +
                `pty=${winSize.ptyCols}x${winSize.ptyRows} resizes=${winSize.resizes}\r\n` + done(0));
        } else if (cmd === 'exit' || cmd === 'quit' || cmd === 'logout') {
            stream.write('Connection closed.\r\n');
            stream.end();
        } else {
            stream.write(`% Invalid input detected at '^' marker.\r\n\r\n` + done(1));
        }
    }

    return onData;
}

// Write N MB as fast as the stream accepts, honoring backpressure locally.
// Lines are numbered (gap detection) and written in ~32 KB blocks: per-line
// writes would benchmark the fixture's packet overhead instead of the app.
// `prompt` is the full done-marker + prompt string from the shell.
function flood(stream, mb, prompt) {
    const total = mb * 1024 * 1024;
    let written = 0;
    let n = 0;
    const pad = 'x'.repeat(96);
    const writeSome = () => {
        while (written < total) {
            const lines = [];
            let blockLen = 0;
            while (blockLen < 32 * 1024 && written + blockLen < total) {
                const line = `${String(n++).padStart(10, '0')} ${pad}\r\n`;
                lines.push(line);
                blockLen += line.length;
            }
            written += blockLen;
            if (!stream.write(lines.join(''))) {
                stream.once('drain', writeSome);
                return;
            }
        }
        stream.write(`flood done: ${written} bytes, ${n} lines\r\n${prompt}`);
    };
    writeSome();
}

module.exports = { attachShell };
