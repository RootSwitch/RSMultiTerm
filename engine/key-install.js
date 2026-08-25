'use strict';
// Install a public key on the connected device: ssh-copy-id, minus twenty
// years of shell-quoting scars, because the key travels on STDIN and never
// through a command line.
//
// Three steps, all over the session's EXISTING connection (no second login,
// which is the point - you are connected with a password right now):
//
//   1. read ~/.ssh/authorized_keys (a missing file reads as empty)
//   2. if the key is already there - including behind an options prefix
//      like command="..." - report that and stop
//   3. append via a POSIX-sh snippet (umask 077 so a fresh dir/file is
//      born 0700/0600, the modes sshd insists on), then READ BACK and
//      confirm the line is present
//
// The read-back is the honest part: "the command exited 0" is not the same
// claim as "the key is in the file on the far end".
//
// Network gear without a POSIX shell fails step 1 with its own error text,
// which is exactly the message worth showing - IOS keys are configured
// through the device's own CLI, not authorized_keys.

const READ_CMD = 'cat "$HOME/.ssh/authorized_keys" 2>/dev/null || true';
const INSTALL_CMD =
    'umask 077; mkdir -p "$HOME/.ssh" && ' +
    '{ [ ! -s "$HOME/.ssh/authorized_keys" ] || ' +
    '[ -z "$(tail -c1 "$HOME/.ssh/authorized_keys")" ] || ' +
    'echo >> "$HOME/.ssh/authorized_keys"; } && ' +
    'cat >> "$HOME/.ssh/authorized_keys" && ' +
    'chmod 700 "$HOME/.ssh" && chmod 600 "$HOME/.ssh/authorized_keys"';

function execCollect(client, command, stdinData, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
        const timer = setTimeout(() =>
            done(reject, new Error('the device did not answer in time')), timeoutMs || 15000);
        client.exec(command, (err, stream) => {
            if (err) return done(reject, err);
            let out = '';
            let errText = '';
            stream.on('data', (d) => { out += d.toString('utf8'); });
            stream.stderr.on('data', (d) => { errText += d.toString('utf8'); });
            stream.on('close', (code) => done(resolve, {
                code: code === undefined || code === null ? 0 : code, out, err: errText,
            }));
            stream.on('error', (e) => done(reject, e));
            stream.end(stdinData === undefined ? '' : stdinData);
        });
    });
}

// publicLine: 'ssh-ed25519 AAAA... comment'. Matching for dedup uses only
// type + blob: comments differ between machines, and an options prefix
// (from="", command="") must not hide an already-installed key.
async function install(session, publicLine) {
    const client = session.transport && session.transport._client;
    if (!client) throw new Error('keys can only be installed over an SSH session');
    const line = String(publicLine || '').trim();
    // authorized_keys is line-oriented: an interior newline turns one
    // "key" into two lines, the second being whatever the blob smuggled.
    // Today the key comes from this user's own file picker; if a key ever
    // arrives from a shared store, this is the difference between a bad
    // key and an injected one.
    if (/[\r\n]/.test(line)) {
        throw new Error('that does not look like a public key line - it has more than one line');
    }
    const parts = line.split(/\s+/);
    if (parts.length < 2 || !/^(ssh-|ecdsa-)/.test(parts[0])) {
        throw new Error('that does not look like a public key line');
    }
    const keyId = parts.slice(0, 2).join(' ');

    const before = await execCollect(client, READ_CMD);
    if (before.code !== 0) {
        throw new Error('this device does not look like it has a POSIX shell' +
            (before.err ? ` - it said: ${before.err.trim().slice(0, 200)}` : '') +
            '. Network gear configures SSH keys through its own CLI instead.');
    }
    if (before.out.includes(keyId)) return { alreadyInstalled: true };

    const res = await execCollect(client, INSTALL_CMD, line + '\n');
    if (res.code !== 0) {
        throw new Error('install failed' +
            (res.err ? `: ${res.err.trim().slice(0, 200)}` : ` (exit ${res.code})`));
    }

    const after = await execCollect(client, READ_CMD);
    if (!after.out.includes(keyId)) {
        throw new Error('the append ran but the key did not appear in ' +
            'authorized_keys - the device may restrict exec commands');
    }
    return { installed: true };
}

module.exports = { install, READ_CMD, INSTALL_CMD };
