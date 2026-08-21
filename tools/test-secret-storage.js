'use strict';
// Which OS facilities are good enough to store a password in.
//
// The case this exists for is Linux without a keyring. Chromium's
// safeStorage falls back to a `basic_text` backend that "encrypts" with a
// hardcoded key, and isEncryptionAvailable() STILL answers true. An app
// that trusts that answer offers to remember a password, writes it
// reversible-by-anyone, and tells the user it is encrypted - three wrongs
// from one true. So basic_text must classify as no storage at all, and the
// app falls back to prompt mode, which is memory-only and honest.
//
// classifyBackend is pure so every combination is checkable here rather
// than by uninstalling gnome-keyring from a real machine.

const assert = require('assert');
const { classifyBackend } = require('../main/secrets');

// --- Windows and macOS: the platform answer is the whole answer ----------
const win = classifyBackend('win32', true, null);
assert.strictEqual(win.available, true, 'DPAPI is real storage');
assert.strictEqual(win.secure, true);
assert.match(win.label, /Windows/, 'the label names what protects the secret');

const mac = classifyBackend('darwin', true, null);
assert.strictEqual(mac.available, true);
assert.match(mac.label, /Keychain/);

// --- Linux: the backend decides ------------------------------------------
for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    const linux = classifyBackend('linux', true, backend);
    assert.strictEqual(linux.available, true, `${backend} is a real keyring`);
    assert.strictEqual(linux.secure, true);
    assert.ok(linux.label && !/Windows/.test(linux.label),
        `${backend} must not be labelled as Windows storage`);
}
assert.match(classifyBackend('linux', true, 'kwallet6').label, /KWallet/,
    'KWallet is named, since that is what will prompt the user');

// THE ONE THAT MATTERS: available:true from the OS, but the backend is the
// hardcoded-key fallback. This must come back unavailable.
const plain = classifyBackend('linux', true, 'basic_text');
assert.strictEqual(plain.available, false,
    'basic_text must NOT be treated as somewhere a password can be stored - ' +
    'it encrypts with a hardcoded key while the OS reports encryption available');
assert.strictEqual(plain.secure, false);
assert.ok(plain.why && /keyring/i.test(plain.why),
    'the refusal must explain itself - the user can install a keyring');

// An unknown backend is refused for the same reason: unproven is untrusted.
assert.strictEqual(classifyBackend('linux', true, 'unknown').available, false);
assert.strictEqual(classifyBackend('linux', true, null).available, false);

// --- No encryption at all -------------------------------------------------
for (const platform of ['win32', 'darwin', 'linux']) {
    const none = classifyBackend(platform, false, null);
    assert.strictEqual(none.available, false, `${platform}: unavailable stays unavailable`);
    assert.ok(none.why, 'and says why, so the UI can explain the missing option');
}

// --- Every verdict is shaped the same, so the UI can read it blind -------
for (const v of [win, mac, plain, classifyBackend('linux', true, 'gnome_libsecret')]) {
    assert.ok(typeof v.available === 'boolean' && typeof v.secure === 'boolean',
        'available/secure are booleans');
    assert.ok(typeof v.label === 'string' && v.label.length,
        'there is always a label to put in a sentence');
}

console.log('ok - secret storage (dpapi/keychain/keyring accepted, ' +
    'Linux basic_text refused despite the OS saying encryption is available)');
