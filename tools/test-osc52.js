'use strict';
// OSC 52 remote-clipboard bridge. The security shape is the whole test:
// a remote program may WRITE the local clipboard (the useful direction,
// gated by a setting and a size cap), and may NEVER read it (the addon's
// report path must hand back nothing, whatever the setting says). These
// are asserted by driving the REAL vendored addon's OSC 52 handler with a
// fake terminal - the same code path a live session takes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Load the vendored UMD addon the way a browser would: it attaches to a
// module-ish global. A tiny shim gives it `window`/`self` and captures the
// exported ClipboardAddon.
const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'vendor', 'xterm', 'addon-clipboard.js'), 'utf8');
const sandbox = { self: {}, window: {} };
sandbox.self = sandbox;
sandbox.window = sandbox;
const factory = new Function('self', 'window', 'module', 'exports',
    `${src}\nreturn (self.ClipboardAddon || (typeof ClipboardAddon !== 'undefined' && ClipboardAddon));`);
const mod = {};
const ClipboardAddonNS = factory(sandbox, sandbox, mod, mod.exports = {});
const ClipboardAddon = ClipboardAddonNS.ClipboardAddon || (mod.exports && mod.exports.ClipboardAddon);
assert.ok(ClipboardAddon, 'the vendored addon must export ClipboardAddon');

// The clipboard the provider writes to, and the setting it reads.
const clip = { text: '__local_secret__' };
let allowWrite = true;
const MAX = 256 * 1024;

const provider = {
    readText() { return Promise.resolve(''); },   // never reveal the clipboard
    writeText(selection, data) {
        if (selection !== 'c') return Promise.resolve();
        if (!allowWrite) return Promise.resolve();
        if (typeof data !== 'string' || !data || data.length > MAX) return Promise.resolve();
        clip.text = data;
        return Promise.resolve();
    },
};

// A fake terminal that records what the addon writes back toward the remote
// (the report path) and exposes the registered OSC 52 handler.
let oscHandler = null;
const remoteReceived = [];
const fakeTerm = {
    parser: {
        registerOscHandler(code, handler) {
            assert.strictEqual(code, 52, 'the addon must claim OSC 52');
            oscHandler = handler;
            return { dispose() {} };
        },
    },
    input(data) { remoteReceived.push(data); },   // bytes headed back to the device
};

const addon = new ClipboardAddon(undefined, provider);
addon.activate(fakeTerm);
assert.ok(oscHandler, 'activate must register the handler');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const feed = async (payload) => { await oscHandler(payload); };

(async () => {
    // 1. A remote WRITE lands on the local clipboard.
    await feed(`c;${b64('show run output')}`);
    assert.strictEqual(clip.text, 'show run output', 'remote write reaches the clipboard');

    // 2. A remote READ ('?') must return NOTHING - the report path is the
    // exfiltration path. Put a secret on the clipboard and confirm the
    // bytes sent back to the device carry an empty payload, not the secret.
    clip.text = 'PASSWORD123';
    remoteReceived.length = 0;
    await feed('c;?');
    assert.strictEqual(remoteReceived.length, 1, 'the report is answered (with empty), not dropped silently');
    const reported = remoteReceived[0];
    assert.ok(!reported.includes(b64('PASSWORD123')),
        'the clipboard contents must NEVER be encoded back to the remote');
    // The payload after "]52;c;" must decode to empty.
    const m = /]52;c;(.*)$/.exec(reported);
    assert.ok(m, `unexpected report shape: ${JSON.stringify(reported)}`);
    assert.strictEqual(Buffer.from(m[1], 'base64').toString('utf8'), '',
        'the reported clipboard is empty');
    assert.strictEqual(clip.text, 'PASSWORD123', 'a read must not disturb the clipboard');

    // 3. Write disabled: the setting is honored.
    allowWrite = false;
    await feed(`c;${b64('should not land')}`);
    assert.strictEqual(clip.text, 'PASSWORD123', 'a disabled write does nothing');
    allowWrite = true;

    // 4. Oversized write is refused (a hostile server cannot shove megabytes
    // onto the clipboard).
    clip.text = 'unchanged';
    await feed(`c;${b64('x'.repeat(MAX + 1))}`);
    assert.strictEqual(clip.text, 'unchanged', 'an oversized write is refused');

    // 5. Primary-selection writes ('p') are ignored - only the real
    // clipboard is ever touched.
    await feed(`p;${b64('primary sel')}`);
    assert.strictEqual(clip.text, 'unchanged', "primary selection ('p') is not touched");

    console.log('ok - osc52 (write lands, read returns nothing, setting + size cap + selection honored)');
})().catch((err) => {
    console.error('FAIL -', err.message);
    process.exit(1);
});
