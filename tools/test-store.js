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

    console.log('ok - store + session tree (10 scenarios incl. logging tri-state, BOM tolerance)');
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
