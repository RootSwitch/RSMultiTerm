'use strict';
// SCP end-to-end against the fixture device, which speaks the real rcp
// protocol over an exec channel. Covers the fallback path for gear that has
// `ip scp server enable` but no SFTP subsystem.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('ssh2');

const scp = require('../engine/scp');

const PORT = 2299;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-scp-'));

function connect() {
    return new Promise((resolve, reject) => {
        const c = new Client();
        c.on('ready', () => resolve(c));
        c.on('error', reject);
        c.connect({
            host: '127.0.0.1', port: PORT,
            username: 'nettest', password: 'nettest',
            readyTimeout: 8000,
        });
    });
}

(async () => {
    // Fixture in no-SFTP mode: SCP is the only way in, like the gear this
    // path exists for.
    const server = spawn(process.execPath, [path.join(__dirname, 'test-ssh-server.js'), String(PORT), 'scp-sw-01'], {
        env: { ...process.env, RSMT_FIXTURE_NO_SFTP: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const sftpRoot = await new Promise((resolve, reject) => {
        let buf = '';
        server.stdout.on('data', (d) => {
            buf += d.toString();
            const m = /sftp root (.+)$/m.exec(buf);
            if (m) resolve(m[1].trim());
        });
        server.stderr.on('data', (d) => reject(new Error(d.toString())));
        setTimeout(() => reject(new Error('fixture did not start')), 8000);
    });

    let client;
    try {
        client = await connect();

        // 1. The SFTP subsystem is genuinely refused, so this device really
        // does need the fallback.
        const sftpWorks = await new Promise((resolve) => {
            client.sftp((err) => resolve(!err));
        });
        assert.strictEqual(sftpWorks, false, 'fixture should refuse SFTP in this mode');

        // 2. probe() recognises that SCP is available.
        assert.strictEqual(await scp.probe(client), true, 'SCP should be detected');

        // 3. Download a known file and verify byte-for-byte.
        const localDown = path.join(work, 'startup-config');
        const progress = [];
        const res = await scp.download(client, '/configs/startup-config', localDown,
            (p) => progress.push(p));
        const expected = fs.readFileSync(path.join(sftpRoot, 'configs', 'startup-config'));
        assert.deepStrictEqual(fs.readFileSync(localDown), expected, 'downloaded bytes must match');
        assert.strictEqual(res.bytes, expected.length);
        assert.ok(progress.length >= 1, 'progress is reported');

        // 4. A binary file of a realistic size round-trips intact - text
        // mangling is the classic SCP implementation bug.
        const blob = crypto.randomBytes(300 * 1024);
        const localUp = path.join(work, 'image.bin');
        fs.writeFileSync(localUp, blob);
        await scp.upload(client, localUp, '/image.bin');
        assert.deepStrictEqual(fs.readFileSync(path.join(sftpRoot, 'image.bin')), blob,
            'uploaded binary must be unchanged');

        // 5. Round trip back down.
        const localBack = path.join(work, 'image-back.bin');
        await scp.download(client, '/image.bin', localBack);
        assert.deepStrictEqual(fs.readFileSync(localBack), blob, 'round trip must be lossless');

        // 6. A missing file surfaces the device's own message, not a generic
        // failure - "No such file" is what tells someone they typed flash:
        // instead of bootflash:.
        let msg = '';
        try {
            await scp.download(client, '/nope.txt', path.join(work, 'nope.txt'));
            assert.fail('expected a rejection');
        } catch (err) {
            msg = err.message;
        }
        assert.ok(/No such file/i.test(msg), `expected the device's message, got: ${msg}`);
        assert.ok(!fs.existsSync(path.join(work, 'nope.txt')),
            'a failed download must not leave a stub file behind');

        console.log('ok - scp fallback (probe, download, binary upload, round trip, error text)');
    } finally {
        if (client) client.end();
        server.kill();
        fs.rmSync(work, { recursive: true, force: true });
    }
})().catch((err) => { console.error('FAIL -', err.stack || err.message); process.exit(1); });
