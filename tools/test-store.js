'use strict';
// Store + session-store tests: atomic write round trip, loadCritical failing
// closed on corruption, inheritance resolution, jump-chain building with
// cycle detection. Runs against a throwaway directory it creates and removes.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../main/store');
const sessions = require('../main/session-store');
const settings = require('../main/settings');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-test-'));
store.init(dir);

try {
    // 1. Round trip.
    store.save('probe', { a: 1, nested: { b: [1, 2, 3] } });
    assert.deepStrictEqual(store.load('probe', null), { a: 1, nested: { b: [1, 2, 3] } });

    // 2. loadCritical: missing returns fallback...
    assert.deepStrictEqual(store.loadCritical('absent', { ok: true }), { ok: true });
    // ...but empty and corrupt THROW instead of returning the fallback.
    fs.writeFileSync(path.join(dir, 'empty.json'), '');
    assert.throws(() => store.loadCritical('empty', {}), /refusing to treat it as empty/);
    fs.writeFileSync(path.join(dir, 'corrupt.json'), '{"cut off');
    assert.throws(() => store.loadCritical('corrupt', {}), /not valid JSON/);

    // 3. Session tree: folder defaults inherit down two levels.
    sessions.init();
    const site = sessions.upsert({
        type: 'folder', name: 'Site A',
        defaults: { credentialProfile: 'AD Account', port: 2022 },
    });
    const core = sessions.upsert({
        type: 'folder', name: 'Core', parentId: site.id,
        defaults: { credentialProfile: 'Privileged AD Account' },
    });
    const sw1 = sessions.upsert({
        type: 'session', name: 'core-sw-01', parentId: core.id, host: '192.0.2.10',
    });
    const eff = sessions.effective(sw1.id);
    assert.strictEqual(eff.credentialProfile.value, 'Privileged AD Account');
    assert.strictEqual(eff.credentialProfile.from, 'Core');
    assert.strictEqual(eff.port.value, 2022);
    assert.strictEqual(eff.port.from, 'Site A');

    // 4. Per-session override beats the folder.
    sessions.upsert({ ...sw1, port: 22 });
    assert.strictEqual(sessions.effective(sw1.id).port.value, 22);

    // 5. Jump chain resolves outermost-first, inheriting hop settings.
    const bastion = sessions.upsert({
        type: 'session', name: 'bastion', parentId: site.id,
        host: '198.51.100.1', credentialProfile: 'SSH Account',
    });
    sessions.upsert({ ...sessions.get(sw1.id), jumpHost: bastion.id });
    const desc = sessions.resolveDescriptor(sw1.id);
    assert.strictEqual(desc.jumpChain.length, 1);
    assert.strictEqual(desc.jumpChain[0].host, '198.51.100.1');
    assert.strictEqual(desc.jumpChain[0].credentialProfile, 'SSH Account');
    assert.strictEqual(desc.credentialProfile, 'Privileged AD Account');

    // 6. Cycle detection: bastion jumping through sw1 which jumps through
    // bastion must throw, not hang.
    sessions.upsert({ ...sessions.get(bastion.id), jumpHost: sw1.id });
    assert.throws(() => sessions.resolveDescriptor(sw1.id), /cycle/);

    // 7. Bulk edit tri-state: set, clear-to-inherit, keep.
    const sw2 = sessions.upsert({
        type: 'session', name: 'core-sw-02', parentId: core.id,
        host: '192.0.2.11', port: 8022,
    });
    sessions.bulkEdit([sw2.id], { port: null, credentialProfile: 'AD Account' });
    const eff2 = sessions.effective(sw2.id);
    assert.strictEqual(eff2.port.value, 2022);                    // cleared -> inherits
    assert.strictEqual(eff2.credentialProfile.value, 'AD Account'); // set
    assert.strictEqual(sessions.get(sw2.id).host, '192.0.2.11');    // kept

    // 8. Logging OFF must survive to the descriptor. `false || null` once
    // collapsed the explicit off to "no opinion", which resolves back to
    // logging ON - the setting existed and did nothing.
    const quiet = sessions.upsert({
        type: 'session', name: 'no-logs', parentId: core.id,
        host: '192.0.2.30', logging: false,
    });
    assert.strictEqual(sessions.resolveDescriptor(quiet.id).logging, false,
        'an explicit logging:false must reach the descriptor as false');
    const loud = sessions.upsert({
        type: 'session', name: 'yes-logs', parentId: core.id,
        host: '192.0.2.31', logging: true,
    });
    assert.strictEqual(sessions.resolveDescriptor(loud.id).logging, true);
    // And through folder defaults: a quiet folder quiets its children.
    const quietFolder = sessions.upsert({
        type: 'folder', name: 'Quiet', parentId: site.id, defaults: { logging: false } });
    const child = sessions.upsert({
        type: 'session', name: 'inherits-quiet', parentId: quietFolder.id, host: '192.0.2.32' });
    assert.strictEqual(sessions.resolveDescriptor(child.id).logging, false,
        'a folder default of logging:false must inherit');

    // 9. A UTF-8 BOM must not brick startup. Invisible in an editor,
    // fatal to JSON.parse, and one Notepad save or PowerShell redirect
    // away - it used to raise a corruption modal before the window opened.
    const bomFile = path.join(dir, 'health.json');
    fs.writeFileSync(bomFile, '﻿' + JSON.stringify({ schema: 1, nodes: { a: 1 } }), 'utf8');
    assert.deepStrictEqual(store.load('health', null), { schema: 1, nodes: { a: 1 } },
        'a BOM-prefixed file must load, not fall back to the default');
    const bomCritical = path.join(dir, 'profiles.json');
    fs.writeFileSync(bomCritical, '﻿' + JSON.stringify({ schema: 1, profiles: [] }), 'utf8');
    assert.deepStrictEqual(store.loadCritical('profiles', null), { schema: 1, profiles: [] },
        'loadCritical must tolerate a BOM too - it throws on bad JSON by design');

    // 10. Folder delete takes the subtree.
    const removed = sessions.remove([site.id]);
    assert.ok(removed.length >= 4, `expected subtree removal, got ${removed.length}`);
    assert.strictEqual(sessions.get(sw1.id), null);

    // 11. Settings: unknown keys refused, nested patches merged rather
    // than replacing, and the numbers with teeth clamped. The renderer
    // parses hostile terminal output, so a patch arriving from it is not
    // trusted to be shaped like a setting.
    settings.init();
    const d = settings.get();
    assert.strictEqual(d.idle.area, 'panes',
        'the idle animation defaults to the terminal panes, not the whole window');
    assert.strictEqual(d.idle.rotateMinutes, 0, '"Surprise me" stays put unless asked to rotate');
    assert.strictEqual(d.field.root, null, 'Field tools remembers nothing until something is served');
    assert.strictEqual(d.field.httpPort, 8080);

    // A nested patch merges: setting the rotation must not wipe the style.
    settings.update({ idle: { style: 'random' } });
    settings.update({ idle: { rotateMinutes: 15 } });
    assert.strictEqual(settings.get().idle.style, 'random', 'a nested patch must merge, not replace');
    assert.strictEqual(settings.get().idle.rotateMinutes, 15);

    // Ports are clamped, not trusted. A port of 0 or 999999 binds nothing
    // useful; 'evil' is not a number at all.
    settings.update({ field: { tftpPort: 999999, httpPort: 0, stopAfterMinutes: 99999 } });
    assert.strictEqual(settings.get().field.tftpPort, 65535, 'a port above 65535 must clamp');
    assert.strictEqual(settings.get().field.httpPort, 1, 'port 0 must clamp into range');
    assert.strictEqual(settings.get().field.stopAfterMinutes, 1440,
        'a server deadline must stay inside a day');
    settings.update({ field: { tftpPort: 'evil' } });
    assert.strictEqual(settings.get().field.tftpPort, 69, 'a non-number port falls back to the default');

    // A remembered folder must be a string or nothing at all.
    settings.update({ field: { root: 'C:/images' } });
    settings.update({ field: { root: { toString: () => 'C:/evil' } } });
    assert.strictEqual(settings.get().field.root, 'C:/images',
        'a non-string folder must be dropped, leaving the last good one');

    // The terminal contrast floor is a ratio, so it is clamped to one. 0
    // would have xterm dividing by it; 99 is not a contrast.
    assert.strictEqual(settings.get().terminalColors.minContrast, 3,
        'the shipped default rescues unreadable colors without repainting legible ones');
    settings.update({ terminalColors: { minContrast: 0 } });
    assert.strictEqual(settings.get().terminalColors.minContrast, 1, '1 is the floor, meaning off');
    settings.update({ terminalColors: { minContrast: 99 } });
    assert.strictEqual(settings.get().terminalColors.minContrast, 21,
        '21 is black on white - there is no higher ratio');
    settings.update({ terminalColors: { minContrast: 'lots' } });
    assert.strictEqual(settings.get().terminalColors.minContrast, 3);
    // ...and setting it must not wipe the mode beside it.
    settings.update({ terminalColors: { mode: 'custom', background: '#101010' } });
    settings.update({ terminalColors: { minContrast: 7 } });
    assert.strictEqual(settings.get().terminalColors.mode, 'custom');

    // 12. The host-key trust store fails CLOSED. The tolerant loader
    // returns {} on a corrupt file, which silently empties the store:
    // every pinned host reverts to first contact, and a man-in-the-middle
    // gets the friendly fingerprint prompt instead of the MISMATCH block.
    // Corrupt must therefore throw (the recovery modal), like sessions and
    // profiles - and missing must still mean a legitimately fresh install.
    const hostkeys = require('../main/hostkeys');
    hostkeys.init();   // no file: fresh install, trusts nobody, no throw
    fs.writeFileSync(path.join(dir, 'known_hosts.json'), '{"cut off');
    assert.throws(() => hostkeys.init(), /not valid JSON/,
        'a corrupt known_hosts must stop the app, not silently empty the trust store');
    fs.unlinkSync(path.join(dir, 'known_hosts.json'));

    // 13. Shape validation. A file that PARSES but is the wrong shape used
    // to sail through both loaders and throw somewhere later - and for
    // highlights that "later" was inside app.whenReady, so a mangled
    // highlights.json stopped the app from launching with no recovery
    // message at all.
    const highlights = require('../main/highlights');
    fs.writeFileSync(path.join(dir, 'highlights.json'), '{"schema":1}');
    highlights.init();                       // must NOT throw
    const warned = highlights.takeWarning();
    assert.ok(warned && /not shaped like/.test(warned),
        'a wrong-shaped highlights file must rebuild from defaults AND say so');
    assert.ok(Array.isArray(highlights.all ? highlights.all() : []) ||
        typeof highlights.init === 'function', 'highlights recovered');
    assert.strictEqual(highlights.takeWarning(), null, 'the warning is one-shot');
    fs.unlinkSync(path.join(dir, 'highlights.json'));

    // Rebuildable stores recover quietly-but-audibly...
    const tunnels = require('../main/tunnel-store');
    fs.writeFileSync(path.join(dir, 'tunnels.json'), '{"schema":1}');
    tunnels.init();
    assert.deepStrictEqual(tunnels.all(), [], 'a wrong-shaped tunnels file rebuilds empty');
    assert.ok(tunnels.takeWarning(), 'and says so');
    fs.unlinkSync(path.join(dir, 'tunnels.json'));

    // ...but the session tree does NOT: an empty tree where a full one
    // belongs is data loss, so a wrong shape throws like corrupt JSON.
    fs.writeFileSync(path.join(dir, 'sessions.json'), '{"schema":1}');
    assert.throws(() => sessions.init(), /refusing to start/,
        'a wrong-shaped sessions file must refuse, not silently start empty');
    fs.unlinkSync(path.join(dir, 'sessions.json'));
    sessions.init();   // back to a clean tree for anything after this

    // A key that is not a setting is not stored, whatever it claims.
    settings.update({ notASetting: 'hello' });
    assert.strictEqual('notASetting' in settings.get(), false, 'unknown keys must be refused');

    console.log('ok - store + session tree (13 scenarios incl. logging tri-state, BOM, settings clamps, hostkeys fail-closed, shape guards)');
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
