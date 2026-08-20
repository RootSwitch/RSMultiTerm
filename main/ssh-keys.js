'use strict';
// SSH key material: finding keys, telling the user what a key IS before
// they try to connect with it, and locating a running agent.
//
// The engine already knew how to authenticate with a key file - the UI
// never offered one, so the path was unreachable. Everything here exists to
// make choosing a key a two-click job with honest errors, because the
// alternative (type a path, connect, read a stack trace from ssh2) is how
// key auth gets abandoned in favour of typing passwords forever.
//
// Parsing is delegated to ssh2's own parseKey rather than hand-read
// headers: it is the code that will actually consume the key at connect
// time, so its verdict is the one that matters. A key this says is fine and
// ssh2 then rejects would be the worst of both worlds.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { utils } = require('ssh2');
const { devOnlyHook } = require('./dev-hooks');

// A private key is a few KB. Anything vastly larger is not a key, and
// reading it to find that out is how you page in a DVD image by accident.
const MAX_KEY_BYTES = 512 * 1024;

function sshDir() {
    // RSMT_SSH_DIR points discovery at a throwaway directory so the tests
    // never have to write a private key into a real ~/.ssh. Dev-only, like
    // every other hook: a packaged build ignores it.
    return devOnlyHook('RSMT_SSH_DIR') || path.join(os.homedir(), '.ssh');
}

// What a file at this path actually is. Never throws: every answer is a
// verdict the UI can show.
//
//   {ok:true,  encrypted:bool, type, comment, path}
//   {ok:false, reason}
function inspect(file) {
    let raw;
    try {
        const st = fs.statSync(file);
        if (!st.isFile()) return { ok: false, reason: 'not a file' };
        if (st.size > MAX_KEY_BYTES) return { ok: false, reason: 'too large to be a private key' };
        raw = fs.readFileSync(file);
    } catch (err) {
        return { ok: false, reason: err.code === 'ENOENT' ? 'no such file' : err.message };
    }

    const head = raw.subarray(0, 64).toString('latin1');

    // PuTTY's own format. ssh2 cannot read it, and the error it gives is
    // unhelpful - so say the useful thing instead, since anyone arriving
    // from PuTTY or MobaXTerm is likely to have exactly this file.
    if (head.startsWith('PuTTY-User-Key-File')) {
        return {
            ok: false,
            reason: 'this is a PuTTY .ppk key, which this app cannot read. ' +
                'Open it in PuTTYgen and use Conversions > Export OpenSSH key.',
        };
    }
    if (head.includes('ssh-rsa ') || head.includes('ssh-ed25519 ') ||
        head.includes('ecdsa-sha2-')) {
        return {
            ok: false,
            reason: 'this is the PUBLIC half (.pub). Choose the file without the .pub extension.',
        };
    }

    const parsed = utils.parseKey(raw);
    if (parsed instanceof Error) {
        // parseKey reports an encrypted key as an error, which is not a
        // problem with the key - it is the passphrase prompt, later.
        if (/encrypted/i.test(parsed.message)) {
            return { ok: true, encrypted: true, type: null, comment: null, path: file };
        }
        return { ok: false, reason: parsed.message };
    }
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    return {
        ok: true,
        encrypted: false,
        type: key.type || null,
        comment: key.comment || null,
        path: file,
    };
}

// Whether a passphrase actually opens a key. Used before saving one, so a
// typo is caught here rather than as a failed connection later.
function verifyPassphrase(file, passphrase) {
    let raw;
    try {
        raw = fs.readFileSync(file);
    } catch (err) {
        return { ok: false, reason: err.message };
    }
    const parsed = utils.parseKey(raw, passphrase);
    if (parsed instanceof Error) {
        return {
            ok: false,
            reason: /bad passphrase|decrypt|integrity/i.test(parsed.message)
                ? 'that passphrase does not open this key' : parsed.message,
        };
    }
    return { ok: true };
}

// Everything in ~/.ssh that parses as a private key. Names are not trusted
// (id_* is a convention, not a rule); the parser decides.
function discover() {
    const dir = sshDir();
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch (_) {
        return [];
    }
    const out = [];
    for (const name of names.sort()) {
        // Skip the files known not to be keys before reading them.
        if (name.endsWith('.pub') || name === 'known_hosts' || name === 'known_hosts.old' ||
            name === 'config' || name === 'authorized_keys') continue;
        const info = inspect(path.join(dir, name));
        if (info.ok) out.push({ ...info, name });
    }
    return out;
}

// Where a running agent can be reached, or null. Checked in the order that
// respects an explicit choice first:
//
//   SSH_AUTH_SOCK   - set deliberately, including by Git Bash or WSL
//   OpenSSH agent   - the service shipped with Windows 10/11
//   Pageant         - PuTTY's agent, which ssh2 speaks by name
//
// Pageant cannot be probed without poking at window handles, so it is only
// ever reported when nothing better is present, and connecting is what
// finally proves it: an agent that is not there fails the method and the
// next one is tried.
const OPENSSH_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

function agentStatus() {
    if (process.env.SSH_AUTH_SOCK) {
        return { available: true, kind: 'env', target: process.env.SSH_AUTH_SOCK,
            detail: 'SSH_AUTH_SOCK is set' };
    }
    if (process.platform === 'win32') {
        try {
            if (fs.existsSync(OPENSSH_PIPE)) {
                return { available: true, kind: 'openssh', target: OPENSSH_PIPE,
                    detail: 'the Windows OpenSSH agent is running' };
            }
        } catch (_) { /* pipe namespace unavailable */ }
        return { available: false, kind: 'pageant', target: 'pageant',
            detail: 'no OpenSSH agent found - Pageant will be tried if you pick agent auth' };
    }
    return { available: false, kind: null, target: null, detail: 'no agent found' };
}

// The string handed to ssh2 as its `agent` option.
function agentTarget() {
    const st = agentStatus();
    return st.target;
}

// The authorized_keys line for a private key. The .pub beside it wins
// when present - ssh-keygen wrote it with the right comment - else the
// line is derived from the private key (which needs the passphrase if the
// key is encrypted).
function publicLineFor(keyPath, passphrase) {
    try {
        const pub = fs.readFileSync(keyPath + '.pub', 'utf8').trim();
        if (pub && !pub.includes('\n') && /^(ssh-|ecdsa-)/.test(pub)) {
            return { ok: true, line: pub };
        }
    } catch (_) { /* no .pub - derive below */ }
    let raw;
    try {
        raw = fs.readFileSync(keyPath);
    } catch (err) {
        return { ok: false, reason: err.message };
    }
    const parsed = utils.parseKey(raw, passphrase || undefined);
    if (parsed instanceof Error) {
        return {
            ok: false,
            reason: /encrypted|passphrase|decrypt|integrity/i.test(parsed.message)
                ? 'this key is encrypted and has no .pub file beside it - its passphrase is ' +
                  'needed once to derive the public half'
                : parsed.message,
        };
    }
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    const blob = Buffer.from(key.getPublicSSH()).toString('base64');
    return { ok: true, line: `${key.type} ${blob} ${key.comment || 'rsmultiterm'}` };
}

module.exports = { inspect, verifyPassphrase, discover, agentStatus, agentTarget, sshDir,
    publicLineFor };
