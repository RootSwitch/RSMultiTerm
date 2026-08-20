'use strict';
// CSV import tests. The behaviors that matter: match by name so a changed
// IP updates rather than duplicates, blank cells leave fields alone, nothing
// is ever deleted, and the preview is honest about what Apply will do.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../main/store');
const sessions = require('../main/session-store');
const csv = require('../main/csv-import');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-csv-'));
store.init(dir);
sessions.init();

const lineOf = (p, name) => p.rows.find((r) => r.name === name);
const changeOf = (row, field) => (row.changes || []).find((c) => c.field === field);

try {
    // Estate: Site A / Core with two switches.
    const site = sessions.upsert({ type: 'folder', name: 'Site A', defaults: {} });
    const core = sessions.upsert({ type: 'folder', name: 'Core', parentId: site.id, defaults: {} });
    const sw1 = sessions.upsert({
        type: 'session', name: 'core-sw-01', parentId: core.id,
        host: '192.0.2.10', notes: 'existing note', tags: ['core'],
    });
    sessions.upsert({
        type: 'session', name: 'core-sw-02', parentId: core.id, host: '192.0.2.11',
    });

    // 1. Preview: an IP change updates by name, a new device adds, an
    // identical row is a no-op, and nothing is deleted for absent devices.
    const p1 = csv.plan([
        'name,host,port,profile,folder',
        'core-sw-01,192.0.2.20,,,Core',            // moved IP
        'core-sw-02,192.0.2.11,,,Core',            // unchanged
        'core-sw-09,192.0.2.19,2022,AD Account,Core/Row 3',   // new, new subfolder
    ].join('\n'), site.id);

    assert.strictEqual(lineOf(p1, 'core-sw-01').action, 'update');
    assert.deepStrictEqual(changeOf(lineOf(p1, 'core-sw-01'), 'host'),
        { field: 'host', from: '192.0.2.10', to: '192.0.2.20' });
    assert.strictEqual(lineOf(p1, 'core-sw-02').action, 'no change');
    assert.strictEqual(lineOf(p1, 'core-sw-09').action, 'add');
    assert.strictEqual(p1.newFolders.length, 1, 'one folder planned');
    assert.strictEqual(p1.newFolders[0].name, 'Row 3');

    // Preview alone must not touch the tree.
    assert.strictEqual(sessions.get(sw1.id).host, '192.0.2.10', 'dry run writes nothing');

    // 2. Apply only the accepted lines.
    const res = csv.apply(p1, p1.rows.map((r) => r.line), site.id);
    assert.strictEqual(res.added, 1);
    assert.strictEqual(res.updated, 1);
    assert.strictEqual(sessions.get(sw1.id).host, '192.0.2.20', 'IP updated in place');
    const all = Object.values(sessions.nodes());
    assert.strictEqual(all.filter((n) => n.name === 'core-sw-01').length, 1,
        'name match updates instead of duplicating');
    const added = all.find((n) => n.name === 'core-sw-09');
    assert.ok(added && added.port === 2022 && added.credentialProfile === 'AD Account');
    const row3 = all.find((n) => n.type === 'folder' && n.name === 'Row 3');
    assert.ok(row3 && row3.parentId === core.id, 'subfolder created under Core');
    assert.strictEqual(added.parentId, row3.id, 'device landed in its folder');

    // 3. Blank cells leave existing values alone.
    const p2 = csv.plan('name,host,notes\ncore-sw-01,192.0.2.30,\n', site.id);
    csv.apply(p2, [2], site.id);
    const after = sessions.get(sw1.id);
    assert.strictEqual(after.host, '192.0.2.30');
    assert.strictEqual(after.notes, 'existing note', 'blank cell must not wipe a field');
    assert.deepStrictEqual(after.tags, ['core'], 'untouched columns survive');

    // 4. Rename detection: no name match, exactly one host match.
    const p3 = csv.plan('name,host\ncore-sw-01-new,192.0.2.30\n', site.id);
    const rn = lineOf(p3, 'core-sw-01-new');
    assert.strictEqual(rn.action, 'rename?');
    assert.strictEqual(rn.nodeId, sw1.id);
    // Not accepting it leaves everything alone...
    csv.apply(p3, [], site.id);
    assert.strictEqual(sessions.get(sw1.id).name, 'core-sw-01');
    // ...accepting renames rather than adding a second device.
    csv.apply(p3, [2], site.id);
    assert.strictEqual(sessions.get(sw1.id).name, 'core-sw-01-new');
    assert.strictEqual(Object.values(sessions.nodes())
        .filter((n) => n.host === '192.0.2.30').length, 1, 'rename did not duplicate');

    // 5. Bad rows are reported per line, and never block the good ones.
    const p4 = csv.plan([
        'name,host,port,transport',
        ',192.0.2.50,,',                     // no name
        'bad-port,192.0.2.51,99999,',        // out of range
        'bad-transport,192.0.2.52,,carrier', // unknown transport
        'dup,192.0.2.53,,',
        'dup,192.0.2.54,,',                  // duplicate name in-file
        'good-one,192.0.2.55,,ssh',
    ].join('\n'), site.id);
    assert.strictEqual(p4.counts.error, 4, `expected 4 errors, got ${JSON.stringify(p4.counts)}`);
    assert.ok(/no name/.test(p4.rows[0].error));
    assert.ok(/invalid port/.test(lineOf(p4, 'bad-port').error));
    assert.ok(/unknown transport/.test(lineOf(p4, 'bad-transport').error));
    assert.strictEqual(lineOf(p4, 'good-one').action, 'add');

    // 6. Quoted fields: commas inside tags and notes, doubled quotes.
    const p5 = csv.plan(
        'name,host,tags,notes\n' +
        'quoted-sw,192.0.2.60,"hq,core","he said ""reload"" at 2am"\n', site.id);
    const q = lineOf(p5, 'quoted-sw');
    assert.deepStrictEqual(changeOf(q, 'tags').to, ['hq', 'core']);
    assert.strictEqual(changeOf(q, 'notes').to, 'he said "reload" at 2am');

    // 7. Unknown columns warn but do not fail.
    const p6 = csv.plan('name,host,rack,serial_number\nrack-sw,192.0.2.61,R12,FOC1234\n', site.id);
    assert.deepStrictEqual(p6.unknownColumns.sort(), ['rack', 'serial_number']);
    assert.strictEqual(lineOf(p6, 'rack-sw').action, 'add');

    // 8. A header without name/host is refused outright.
    assert.throws(() => csv.plan('device,ip\nfoo,192.0.2.1\n', site.id), /header row/);
    assert.throws(() => csv.plan('', site.id), /empty/);

    // 9. Export round-trips: exported text re-imports as all "no change".
    csv.apply(p5, [2], site.id);
    csv.apply(p6, [2], site.id);
    const text = csv.exportFolder(site.id);
    const back = csv.plan(text, site.id);
    const changed = back.rows.filter((r) => r.action !== 'no change');
    assert.strictEqual(changed.length, 0,
        `export/import round trip should be clean, got ${JSON.stringify(changed.map((c) => [c.name, c.action, c.changes]))}`);

    // 10. Formula-guard fields must export. A note starting with '-' or
    // '=' used to hit a const reassignment in toCsvField and fail the whole
    // export with a TypeError; the guard now prefixes Excel's text marker.
    sessions.upsert({
        type: 'session', name: 'guard-sw', parentId: core.id,
        host: '192.0.2.30', notes: '- check config @0800',
    });
    const guarded = csv.exportFolder(site.id);
    assert.ok(guarded.includes("'- check config @0800"),
        'a formula-leading note must export with a leading apostrophe');

    console.log('ok - csv import (10 scenarios: match-by-name, blanks, rename, errors, round trip, formula guard)');
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
