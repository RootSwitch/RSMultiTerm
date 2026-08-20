'use strict';
// MobaXTerm parser test against a synthetic .mxtsessions in both encodings
// Moba actually writes (ANSI and UTF-16LE with BOM). Fictional estate only.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../main/store');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-moba-'));
store.init(dir);
const moba = require('../main/moba-import');

const CONTENT = [
    '[Bookmarks]',
    'SubRep=',
    'ImgNum=41',
    'core-sw-01=#109#0%192.0.2.10%22%netadmin%%-1%-1%%%%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%-1%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%1%-1%0#0# #-1',
    'edge-fw-01=#109#0%198.51.100.1%2222%secops%%-1%-1%%%%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%-1%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%1%-1%0#0# #-1',
    'old-hub=#98#1%203.0.113.20%23%%%-1%-1%%%%%0%0%0#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%-1%_Std_Colors_0_%80%24%0%1%-1%<none>%%0#0# #-1',
    'jump-desktop=#91#4%192.0.2.200%3389%corp\\jdoe%%-1%-1%%%%%0%0%0#MobaFont%10#0# #-1',
    '',
    '[Bookmarks_1]',
    'SubRep=Site A\\Core',
    'ImgNum=41',
    'core-sw-02=#109#0%192.0.2.11%22%netadmin%%-1%-1#MobaFont%10#0# #-1',
    '',
].join('\r\n');

function checkReport(report, label) {
    assert.strictEqual(report.sessions.length, 4, `${label}: 4 terminal sessions`);
    assert.strictEqual(report.skipped.length, 1, `${label}: RDP skipped`);
    assert.strictEqual(report.skipped[0].type, 'RDP');
    const core1 = report.sessions.find((s) => s.name === 'core-sw-01');
    assert.deepStrictEqual(
        { host: core1.host, port: core1.port, username: core1.username, transport: core1.transport, folder: core1.folder },
        { host: '192.0.2.10', port: 22, username: 'netadmin', transport: 'ssh', folder: '' });
    const fw = report.sessions.find((s) => s.name === 'edge-fw-01');
    assert.strictEqual(fw.port, 2222, `${label}: nonstandard port kept`);
    const hub = report.sessions.find((s) => s.name === 'old-hub');
    assert.strictEqual(hub.transport, 'telnet');
    assert.strictEqual(hub.username, '', `${label}: telnet has no username`);
    const sw2 = report.sessions.find((s) => s.name === 'core-sw-02');
    assert.strictEqual(sw2.folder, 'Site A/Core', `${label}: nested folder path`);
    assert.deepStrictEqual(report.usernames, { netadmin: 2, secops: 1 }, `${label}: username tally`);
}

try {
    // ANSI encoding.
    const ansiPath = path.join(dir, 'ansi.mxtsessions');
    fs.writeFileSync(ansiPath, CONTENT, 'latin1');
    checkReport(moba.parse(ansiPath), 'ansi');

    // UTF-16LE with BOM.
    const utfPath = path.join(dir, 'utf16.mxtsessions');
    fs.writeFileSync(utfPath, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(CONTENT, 'utf16le')]));
    checkReport(moba.parse(utfPath), 'utf16');

    // Node conversion: usernames map to profiles, folders materialize.
    const report = moba.parse(ansiPath);
    const nodes = moba.toNodes(report, { netadmin: 'AD Account', secops: 'Privileged AD Account' }, 'Imported');
    const all = Object.values(nodes);
    const sessions = all.filter((n) => n.type === 'session');
    assert.strictEqual(sessions.length, 4);
    assert.ok(sessions.every((n) => !('username' in n)), 'no usernames in nodes');
    assert.strictEqual(sessions.find((n) => n.name === 'core-sw-01').credentialProfile, 'AD Account');
    assert.strictEqual(sessions.find((n) => n.name === 'edge-fw-01').credentialProfile, 'Privileged AD Account');
    assert.strictEqual(sessions.find((n) => n.name === 'core-sw-01').port, null, 'default port normalized to inherit');
    const coreFolder = all.find((n) => n.type === 'folder' && n.name === 'Core');
    assert.ok(coreFolder, 'nested folder created');
    const siteA = all.find((n) => n.type === 'folder' && n.name === 'Site A');
    assert.strictEqual(coreFolder.parentId, siteA.id);

    console.log('ok - mobaxterm import (both encodings, wizard mapping, folder tree)');
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
