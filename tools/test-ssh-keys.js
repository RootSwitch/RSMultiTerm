'use strict';
// SSH key authentication, from "what is this file" through to a real
// handshake against a server that checks the signature.
//
// Two halves:
//   1. Inspection - the verdicts the profile editor shows before anyone
//      tries to connect. Wrong verdicts here are worse than none: telling
//      someone a .ppk is fine means their first connection fails with an
//      ssh2 parser error they cannot act on.
//   2. The wire - a key actually authenticates, an encrypted key needs its
//      passphrase, and a WRONG passphrase fails as a LOCAL key problem
//      rather than as an authentication failure. That last one matters:
//      auth failures halt the credential profile (the AD-lockout guard),
//      and a typo in a local passphrase must never do that.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server, utils } = require('ssh2');
const { SshTransport } = require('../engine/transports/ssh');
const sshKeys = require('../main/ssh-keys');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-keys-'));

// Keys are generated rather than committed: a private key in a repo is a
// bad habit even when it is a test one. PKCS#1 PEM because that is a format
// Node can write and ssh2 can read; the OpenSSH format users actually have
// is exercised by inspect() the same way.
function writeKey(name, passphrase) {
    const enc = { type: 'pkcs1', format: 'pem' };
    if (passphrase) { enc.cipher = 'aes-256-cbc'; enc.passphrase = passphrase; }
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: enc,
        publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    const file = path.join(dir, name);
    fs.writeFileSync(file, privateKey);
    return file;
}

const plainKey = writeKey('id_plain', null);
const lockedKey = writeKey('id_locked', 'lab-passphrase');

// --- 1. inspection --------------------------------------------------------

const plain = sshKeys.inspect(plainKey);
assert.ok(plain.ok, `a valid key must inspect ok, got ${plain.reason}`);
assert.strictEqual(plain.encrypted, false, 'an unencrypted key must not report a passphrase');
assert.strictEqual(plain.type, 'ssh-rsa', 'the key type is shown so the picker is readable');

const locked = sshKeys.inspect(lockedKey);
assert.ok(locked.ok, 'an encrypted key is usable - it just needs a passphrase');
assert.strictEqual(locked.encrypted, true, 'an encrypted key must be reported as encrypted');

// The two files people pick by mistake, both with a fixable explanation.
const ppk = path.join(dir, 'session.ppk');
fs.writeFileSync(ppk, 'PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n');
const ppkInfo = sshKeys.inspect(ppk);
assert.ok(!ppkInfo.ok && /PuTTYgen/.test(ppkInfo.reason),
    'a .ppk must be named as such and point at the conversion, not fail as a parse error');

const pub = path.join(dir, 'id_plain.pub');
fs.writeFileSync(pub, 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC user@host\n');
const pubInfo = sshKeys.inspect(pub);
assert.ok(!pubInfo.ok && /PUBLIC half/.test(pubInfo.reason),
    'picking the .pub file must say so - it is the single most common mistake');

assert.ok(!sshKeys.inspect(path.join(dir, 'nope')).ok, 'a missing file is not a key');

// Passphrase verification, so a typo is caught while saving the profile.
assert.ok(sshKeys.verifyPassphrase(lockedKey, 'lab-passphrase').ok, 'the right passphrase opens the key');
const wrong = sshKeys.verifyPassphrase(lockedKey, 'not-it');
assert.ok(!wrong.ok && /does not open/.test(wrong.reason), 'a wrong passphrase is reported plainly');

// Discovery reads a directory of mixed files and returns only real keys.
// (sshKeys.discover reads ~/.ssh; the same filter is exercised here through
// inspect, which is the part that decides.)
const discoverable = fs.readdirSync(dir)
    .filter((n) => !n.endsWith('.pub') && !n.endsWith('.ppk'))
    .filter((n) => sshKeys.inspect(path.join(dir, n)).ok);
assert.deepStrictEqual(discoverable.sort(), ['id_locked', 'id_plain'],
    'discovery must keep the keys and drop everything else');

// --- 2. the wire ----------------------------------------------------------

const { privateKey: hostPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const hostKey = hostPriv.export({ type: 'pkcs1', format: 'pem' });

// A server that accepts exactly one public key and verifies the signature,
// so "it connected" means the app really signed with the private key.
function startServer(allowedPrivatePem, counts) {
    const allowed = utils.parseKey(allowedPrivatePem, 'lab-passphrase') instanceof Error
        ? utils.parseKey(allowedPrivatePem)
        : utils.parseKey(allowedPrivatePem, 'lab-passphrase');
    const allowedSSH = allowed.getPublicSSH();
    return new Promise((resolve) => {
        const server = new Server({ hostKeys: [hostKey] }, (client) => {
            client.on('error', () => { /* the test asserts the client side */ });
            client.on('authentication', (ctx) => {
                if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
                counts.publickey++;
                const offered = ctx.key.data;
                if (ctx.key.algo !== allowed.type || !offered.equals(allowedSSH)) return ctx.reject();
                // No signature yet: this is the "would you take this key"
                // probe that precedes the real attempt.
                if (!ctx.signature) return ctx.accept();
                if (allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) return ctx.accept();
                return ctx.reject();
            });
            client.on('ready', () => {
                client.on('session', (accept) => {
                    const session = accept();
                    session.on('pty', (a) => a && a());
                    session.on('shell', (a) => {
                        const stream = a();
                        stream.write('key-auth-ok\r\n');
                    });
                });
            });
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function connect(port, auth) {
    const t = new SshTransport();
    const seen = [];
    t.on('status', (s) => seen.push(s));
    t.on('close', () => { /* expected on the failure paths below */ });
    // Accept-all on purpose: the transport now fails CLOSED without a
    // verifier, and these scenarios are about auth, not host keys.
    return t.connect({ host: '127.0.0.1', port, timeoutMs: 5000 }, auth,
        { verifyHostkey: () => Promise.resolve(true) }).then(
        () => ({ ok: true, transport: t, seen }),
        (err) => ({ ok: false, err, seen }));
}

(async () => {
    const counts = { publickey: 0 };
    const server = await startServer(fs.readFileSync(plainKey), counts);
    const port = server.address().port;
    try {
        // 1. An unencrypted key authenticates.
        const good = await connect(port, { username: 'lab', keyPath: plainKey });
        assert.ok(good.ok, `key auth must connect, got ${good.err && good.err.message}`);
        assert.ok(counts.publickey > 0, 'the server must have seen a publickey attempt');
        await good.transport.close();

        // 2. A key the server does not know is refused as an AUTH failure -
        // that one is a real refused login and should halt the profile.
        const otherKey = writeKey('id_other', null);
        const refused = await connect(port, { username: 'lab', keyPath: otherKey });
        assert.ok(!refused.ok, 'an unknown key must not connect');
        assert.strictEqual(refused.err.isAuthFailure, true,
            'a key the server refuses IS an authentication failure');

        // 3. An encrypted key with the WRONG passphrase must fail locally:
        // no signature was ever offered, so this is not a refused login and
        // must not trip the lockout guard.
        const before = counts.publickey;
        const badPass = await connect(port, {
            username: 'lab', keyPath: lockedKey, keyPassphrase: 'not-it',
        });
        assert.ok(!badPass.ok, 'a key that will not decrypt cannot connect');
        assert.strictEqual(badPass.err.isAuthFailure, false,
            'a wrong LOCAL passphrase must not count as an authentication failure - ' +
            'that would halt the profile the way a refused password does');
        assert.ok(/passphrase does not open/.test(badPass.err.message),
            `the error must name the real problem, got: ${badPass.err.message}`);
        assert.strictEqual(counts.publickey, before,
            'a key that will not decrypt must never reach the server');

        // 4. A missing key file is also local, and skips to the next method
        // rather than pretending to be a refusal.
        const missing = await connect(port, { username: 'lab', keyPath: path.join(dir, 'gone') });
        assert.ok(!missing.ok, 'a missing key cannot connect');

        console.log('ok - ssh keys (inspection incl. ppk/pub/encrypted, key auth on the wire, ' +
            'wrong passphrase is local not an auth failure)');
        server.close();
        process.exit(0);
    } catch (err) {
        server.close();
        console.error('FAIL -', err.message);
        process.exit(1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
})();
