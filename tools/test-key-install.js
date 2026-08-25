'use strict';
// Key installation (ssh-copy-id) against the fixture server's Linux-home
// emulation. The fixture matches the EXACT exec commands the installer
// sends - a drifted command string fails here instead of silently testing
// a fake - and applies their semantics to a sandbox home directory, so
// every assertion below is about a real file the "device" ended up with.
//
// The gear scenario runs against the same fixture WITHOUT the emulation,
// where exec answers '% Unknown command' + exit 1, which is how a switch
// behaves - the installer must say something useful, not stack-trace.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { SshTransport } = require('../engine/transports/ssh');
const keyInstall = require('../engine/key-install');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-kihome-'));
const akFile = path.join(home, '.ssh', 'authorized_keys');

function startFixture(port, env) {
    const proc = spawn(process.execPath,
        [path.join(__dirname, 'test-ssh-server.js'), String(port), 'ki-box'],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    return new Promise((resolve, reject) => {
        proc.stdout.on('data', (d) => { if (/listening/.test(d.toString())) resolve(proc); });
        proc.stderr.on('data', (d) => reject(new Error(d.toString())));
        setTimeout(() => reject(new Error('fixture did not start')), 8000);
    });
}

function connect(port) {
    const t = new SshTransport();
    t.on('close', () => { /* teardown */ });
    return t.connect({ host: '127.0.0.1', port, timeoutMs: 5000 },
        { username: 'nettest', password: 'nettest' },
        { verifyHostkey: () => Promise.resolve(true) }).then(() => t);
}

// A realistic public line, derived from a really generated key.
function makeKeyLine(comment) {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const der = publicKey.export({ type: 'spki', format: 'der' });
    // Wrap the raw 32 bytes as an OpenSSH public blob by hand: string
    // "ssh-ed25519" + string key.
    const rawKey = der.subarray(der.length - 32);
    const type = Buffer.from('ssh-ed25519');
    const blob = Buffer.concat([
        Buffer.from([0, 0, 0, type.length]), type,
        Buffer.from([0, 0, 0, rawKey.length]), rawKey,
    ]);
    return `ssh-ed25519 ${blob.toString('base64')} ${comment}`;
}

(async () => {
    const linux = await startFixture(2271, { RSMT_FIXTURE_LINUX_HOME: home });
    const gear = await startFixture(2272, {});
    let t = null;
    try {
        const lineA = makeKeyLine('a@test');
        const keyIdA = lineA.split(/\s+/).slice(0, 2).join(' ');

        // 1. Fresh install: file created, key present, exactly once.
        t = await connect(2271);
        const s = { transport: t };
        const r1 = await keyInstall.install(s, lineA);
        assert.deepStrictEqual(r1, { installed: true });
        const ak1 = fs.readFileSync(akFile, 'utf8');
        assert.ok(ak1.includes(keyIdA), 'the key must be in authorized_keys');
        assert.strictEqual(ak1.split(keyIdA).length - 1, 1, 'exactly one copy');
        assert.ok(ak1.endsWith('\n'), 'the file ends with a newline');

        // 2. Installing again: detected, nothing appended.
        const r2 = await keyInstall.install(s, lineA);
        assert.deepStrictEqual(r2, { alreadyInstalled: true });
        assert.strictEqual(fs.readFileSync(akFile, 'utf8'), ak1, 'file untouched');

        // 3. An options-prefixed copy of a key still counts as installed -
        // comments and from=/command= prefixes must not fool the dedup.
        const lineB = makeKeyLine('b@test');
        const keyIdB = lineB.split(/\s+/).slice(0, 2).join(' ');
        fs.appendFileSync(akFile, `command="/bin/true" ${keyIdB} elsewhere\n`);
        const r3 = await keyInstall.install(s, lineB);
        assert.deepStrictEqual(r3, { alreadyInstalled: true });

        // 4. A file WITHOUT a trailing newline gets one before the append -
        // the classic corruption is two keys fused onto one line.
        const lineC = makeKeyLine('c@test');
        fs.writeFileSync(akFile, lineA);   // no trailing newline
        const r4 = await keyInstall.install(s, lineC);
        assert.deepStrictEqual(r4, { installed: true });
        const lines = fs.readFileSync(akFile, 'utf8').trim().split('\n');
        assert.strictEqual(lines.length, 2, `two separate lines, got ${lines.length}`);
        assert.ok(lines[0] === lineA && lines[1] === lineC, 'both keys intact on their own lines');
        await t.close();
        t = null;

        // 5. Network gear: a device that cannot run cat gets a plain answer.
        t = await connect(2272);
        await assert.rejects(
            () => keyInstall.install({ transport: t }, lineA),
            /POSIX shell/,
            'gear must produce the own-CLI explanation, not a stack trace');
        await t.close();
        t = null;

        // 6. Garbage in is refused before anything touches the wire.
        await assert.rejects(() => keyInstall.install({ transport: { _client: {} } }, 'not a key'),
            /does not look like a public key/);

        // authorized_keys is line-oriented: a "key" with an interior newline is
// one bad key plus one injected line. Refused before anything executes.
{
    const { install } = require('../engine/key-install');
    const twoLines = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake key-one\ncommand="evil" ssh-rsa AAAA injected';
    await assert.rejects(() => install({ transport: { _client: {} } }, twoLines),
        /more than one line/, 'an interior newline must be refused as not-a-key-line');
}

console.log('ok - key install (fresh, dedup incl. options prefix, newline join, ' +
            'gear refusal, garbage refusal)');
        process.exit(0);
    } catch (err) {
        console.error('FAIL -', err.message);
        process.exit(1);
    } finally {
        if (t) try { await t.close(); } catch (_) { /* teardown */ }
        linux.kill();
        gear.kill();
        fs.rmSync(home, { recursive: true, force: true });
    }
})();
