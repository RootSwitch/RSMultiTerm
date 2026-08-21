'use strict';
// Credential profiles and the only module that ever touches a plaintext
// secret.
//
// Three ways to authenticate, chosen per profile:
//
//   key    - an SSH private key file. The default when this machine has a
//            key, because for a lab full of Linux boxes it is both safer
//            and less typing than a password nobody rotates. An encrypted
//            key needs its passphrase, which follows the same two storage
//            modes below.
//   agent  - a running SSH agent (Windows OpenSSH, Pageant, or whatever
//            SSH_AUTH_SOCK points at) holds the key and this app never
//            sees it. Nothing to store at all.
//   password - the original path, and still the right one for network gear
//            with local accounts or TACACS.
//
// Two storage modes for the secret a password or an encrypted key needs:
//
//   dpapi  - password encrypted with Electron safeStorage. The name is
//            historical (and is the value on disk, so it stays): what
//            actually protects the secret depends on the OS - Windows
//            DPAPI, the macOS Keychain, or a Linux keyring. Home-lab mode.
//   prompt - nothing persisted. First connect prompts; the plaintext lives in
//            an in-memory map until the app closes or an auth failure clears
//            it. Work mode for daily-rotating AD passwords.
//
// profiles.json is local-only, never exported, never synced - the shareable
// world refers to profiles by NAME only ("AD Account"). No rs: channel
// returns a secret to the renderer; plaintext travels exactly one hop,
// main -> engine, inside a connect message.

// Lazy so plain-node tests can exercise prompt-mode logic; dpapi mode simply
// reports unavailable outside Electron.
let safeStorage = null;
try { safeStorage = require('electron').safeStorage; } catch (_) { /* tests */ }
const store = require('./store');
const sshKeys = require('./ssh-keys');

let profiles = [];                 // [{name, username, authMethod, storage, secretDpapi, keyPath, keyPassphraseDpapi}]
const promptCache = new Map();     // profileName -> password (memory only)
const passphraseCache = new Map(); // profileName -> key passphrase (memory only)
// Profiles whose prompt answer should be SAVED - once it works. Committing
// on successful connect rather than on submit means a typo can never be
// stored, and a stored password is by definition one that opened a device.
const pendingSave = new Set();     // profileName
const listeners = [];

function init() {
    const data = store.loadCritical('profiles', { schema: 1, profiles: [] });
    profiles = data.profiles;
}

function onChange(fn) { listeners.push(fn); }
function persist() {
    store.save('profiles', { schema: 1, profiles });
    for (const fn of listeners) fn();
}

// What safeStorage would actually do here, and whether that is good enough
// to store a password in.
//
// This exists because of one Linux behaviour that is quietly dangerous:
// when no keyring (gnome-keyring/libsecret, KWallet) is available, Chromium
// falls back to a `basic_text` backend that "encrypts" with a HARDCODED
// key - and isEncryptionAvailable() still answers true. Trusting that
// answer on Linux means the app cheerfully offers to remember a password,
// stores it as reversible-by-anyone, and says it is encrypted. So the
// backend is inspected, basic_text is treated as no storage at all, and the
// app falls back to prompt mode - which is memory-only and honest.
//
// Split out as a pure function so every combination is testable without an
// OS keyring to poke at; storageInfo() below supplies the real values.
function classifyBackend(platform, available, backend) {
    if (!available) {
        return { available: false, secure: false, backend: backend || null,
            label: 'OS encryption',
            why: 'the OS reports no encryption service' };
    }
    if (platform === 'win32') {
        return { available: true, secure: true, backend: 'dpapi',
            label: 'your Windows sign-in', why: null };
    }
    if (platform === 'darwin') {
        return { available: true, secure: true, backend: 'keychain',
            label: 'your macOS Keychain', why: null };
    }
    // Linux and anything else: the backend decides.
    if (backend === 'basic_text' || backend === 'unknown' || !backend) {
        return { available: false, secure: false, backend: backend || null,
            label: 'a system keyring',
            why: 'no keyring is available (gnome-keyring or KWallet), and the ' +
                 'fallback would store secrets with a hardcoded key' };
    }
    const named = backend.startsWith('kwallet') ? 'KWallet' : 'your login keyring';
    return { available: true, secure: true, backend, label: named, why: null };
}

function storageInfo() {
    let available = false;
    try { available = !!safeStorage && safeStorage.isEncryptionAvailable(); } catch (_) { /* no electron */ }
    let backend = null;
    if (available && process.platform !== 'win32' && process.platform !== 'darwin') {
        // Linux only; the call does not exist elsewhere.
        try { backend = safeStorage.getSelectedStorageBackend(); } catch (_) { backend = 'unknown'; }
    }
    return classifyBackend(process.platform, available, backend);
}

// The single gate every store/read path asks. False means "keep it in
// memory instead", which is a supported mode rather than a failure.
function secretStorageAvailable() {
    return storageInfo().available;
}

function byName(name) {
    return profiles.find((p) => p.name === name) || null;
}

// Renderer-facing view: never includes secret material, only whether it exists.
function list() {
    return profiles.map((p) => ({
        name: p.name,
        username: p.username,
        authMethod: p.authMethod || 'password',
        storage: p.storage,
        keyPath: p.keyPath || null,
        hasSecret: !!p.secretDpapi,
        hasKeyPassphrase: !!p.keyPassphraseDpapi,
        cached: promptCache.has(p.name),
    }));
}

// password arrives only when the user typed one into the profile editor; an
// empty/undefined password keeps whatever is stored.
function upsert(input) {
    if (!input.name || !input.name.trim()) throw new Error('profile name required');
    const name = input.name.trim();
    let p = byName(name);
    if (!p) {
        p = { name, username: '', authMethod: 'password', storage: 'prompt', secretDpapi: null, keyPath: null, keyPassphraseDpapi: null };
        profiles.push(p);
    }
    p.username = input.username !== undefined ? input.username : p.username;
    p.authMethod = input.authMethod || p.authMethod;
    p.storage = input.storage || p.storage;
    p.keyPath = input.keyPath !== undefined ? input.keyPath : p.keyPath;

    // Switching away from key auth drops the passphrase with it: a stored
    // secret for a key this profile no longer uses is nothing but risk.
    if (p.authMethod !== 'key' && p.authMethod !== 'keyfile') {
        p.keyPassphraseDpapi = null;
    }
    if (input.clearKeyPassphrase) p.keyPassphraseDpapi = null;

    if (p.storage === 'dpapi') {
        if (input.clearPassword) {
            // The explicit "forget it" path. A blank password field means
            // "keep what is stored" (the editor shows '(unchanged)'), so
            // clearing needs its own flag, never a magic empty string.
            p.secretDpapi = null;
        } else if (input.password) {
            if (!secretStorageAvailable()) throw new Error(storageInfo().why + ' - use prompt mode instead');
            p.secretDpapi = safeStorage.encryptString(input.password).toString('base64');
        }
    } else {
        p.secretDpapi = null;   // switching to prompt mode forgets the stored secret
    }
    if (input.keyPassphrase) {
        if (!secretStorageAvailable()) throw new Error(storageInfo().why + ' - use prompt mode instead');
        p.keyPassphraseDpapi = safeStorage.encryptString(input.keyPassphrase).toString('base64');
    }
    persist();
    return list().find((x) => x.name === name);
}

function removeProfile(name) {
    profiles = profiles.filter((p) => p.name !== name);
    promptCache.delete(name);
    persist();
}

// Resolve auth material for the engine. Returns null when the profile is
// prompt-mode with nothing cached - the caller runs the prompt flow first.
function getAuth(name) {
    const p = byName(name);
    if (!p) return { missing: true, name };
    const auth = { username: p.username, profileName: p.name };

    // The agent holds the key and does the signing; this app never handles
    // key material at all, so there is nothing to unlock and nothing to
    // prompt for.
    if (p.authMethod === 'agent') {
        auth.agent = sshKeys.agentTarget();
        return auth;
    }

    // 'keyfile' is the original spelling and still accepted from older
    // profiles.json files.
    if (p.authMethod === 'key' || p.authMethod === 'keyfile') {
        auth.keyPath = p.keyPath;
        if (p.keyPassphraseDpapi && secretStorageAvailable()) {
            auth.keyPassphrase = safeStorage.decryptString(Buffer.from(p.keyPassphraseDpapi, 'base64'));
            return auth;
        }
        if (passphraseCache.has(p.name)) {
            auth.keyPassphrase = passphraseCache.get(p.name);
            return auth;
        }
        // An encrypted key with no passphrase to hand needs the prompt -
        // and only then. Dialling without one fails at the KEY, before any
        // network attempt, which would look like a refused login.
        const info = sshKeys.inspect(p.keyPath || '');
        if (info.ok && info.encrypted) return null;
        return auth;
    }
    if (p.storage === 'dpapi' && p.secretDpapi) {
        if (!secretStorageAvailable()) return null;
        auth.password = safeStorage.decryptString(Buffer.from(p.secretDpapi, 'base64'));
        return auth;
    }
    if (promptCache.has(p.name)) {
        auth.password = promptCache.get(p.name);
        return auth;
    }
    return null;   // needs a prompt
}

// The answer to a prompt. Which cache it lands in depends on what was
// asked for: a key passphrase is not a password and must never be tried
// against a device as one.
function promptResult(name, password, remember) {
    const p = byName(name);
    if (remember && secretStorageAvailable()) pendingSave.add(name);
    if (p && (p.authMethod === 'key' || p.authMethod === 'keyfile')) {
        passphraseCache.set(name, password);
        return;
    }
    promptCache.set(name, password);
}

// The connect that used this profile succeeded: if the prompt asked to be
// remembered, encrypt what is in the memory cache and keep it. For a
// password profile this also flips storage to dpapi, so the profile editor
// and the prompt agree about what will happen next time.
function commitSaved(name) {
    if (!pendingSave.has(name)) return;
    pendingSave.delete(name);
    const p = byName(name);
    if (!p || !secretStorageAvailable()) return;
    if (p.authMethod === 'key' || p.authMethod === 'keyfile') {
        const pass = passphraseCache.get(name);
        if (pass) p.keyPassphraseDpapi = safeStorage.encryptString(pass).toString('base64');
    } else {
        const pw = promptCache.get(name);
        if (pw === undefined) return;
        p.storage = 'dpapi';
        p.secretDpapi = safeStorage.encryptString(pw).toString('base64');
    }
    persist();
}

// What a profile will ask for, so the dialog can say the true thing.
// 'passphrase' failures are local (the key does not decrypt) and cost no
// backend attempt, which is why they never trip the lockout guard.
function promptKind(name) {
    const p = byName(name);
    if (p && (p.authMethod === 'key' || p.authMethod === 'keyfile')) {
        return { kind: 'passphrase', keyPath: p.keyPath || null };
    }
    return { kind: 'password', keyPath: null };
}

// Fill in a username the user supplied at connect time. Persisted, unlike
// the password: it is not a secret, and the whole point of profiles is that
// each person names theirs once.
function setUsername(name, username) {
    const p = byName(name);
    if (!p || !username) return;
    p.username = username;
    persist();
}

// Called on auth failure: a wrong cached password must not be retried against
// the next device - that is the AD lockout machine.
function clearCached(name) {
    promptCache.delete(name);
    passphraseCache.delete(name);
    // A failed answer must never be saved by a later success of something
    // else - remembering was asked for THIS password, which was wrong.
    pendingSave.delete(name);
}

// The stored (or session-cached) passphrase for a key FILE, whatever
// profile carries it. Used when deriving the public half of an encrypted
// key for install-on-device; returns null when nothing is stored.
function passphraseForKey(keyPath) {
    if (!keyPath) return null;
    for (const p of profiles) {
        if (p.keyPath !== keyPath) continue;
        if (p.keyPassphraseDpapi && secretStorageAvailable()) {
            return safeStorage.decryptString(Buffer.from(p.keyPassphraseDpapi, 'base64'));
        }
        if (passphraseCache.has(p.name)) return passphraseCache.get(p.name);
    }
    return null;
}

module.exports = {
    init, onChange, list, upsert, removeProfile, passphraseForKey,
    storageInfo, classifyBackend,
    getAuth, promptResult, promptKind, commitSaved, setUsername, clearCached, secretStorageAvailable, byName,
};
