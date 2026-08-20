'use strict';
// Workspace snapshots. The load-bearing property is the first one: a
// snapshot is written to disk and survives restarts, so a quick-connect
// password must never reach it. The app's whole credential story is "the
// password is in memory and nowhere else"; a layout file that quietly
// carried one would undo that without anyone noticing.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../main/store');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-ws-'));
store.init(dir);
const workspace = require('../main/workspace');

const file = path.join(dir, 'workspace.json');
const onDisk = () => fs.readFileSync(file, 'utf8');

try {
    workspace.init();
    assert.strictEqual(workspace.get(), null, 'a fresh install has no workspace');

    // 1. A quick-connect recipe is saved WITHOUT its password.
    workspace.save([{
        title: 'core-sw-01',
        focusedIndex: 0,
        panes: [{
            recipe: { args: { host: '192.0.2.10', username: 'nettest', password: 'hunter2', transport: 'ssh' } },
            title: 'nettest@192.0.2.10',
            transport: 'ssh',
        }],
    }], 0);

    const raw = onDisk();
    assert.ok(!raw.includes('hunter2'), 'a password must never reach the workspace file');
    assert.ok(raw.includes('192.0.2.10'), 'the host is kept - that is the point of a recipe');
    const saved = workspace.get();
    assert.strictEqual(saved.tabs[0].panes[0].recipe.args.username, 'nettest',
        'the username is not a secret and is kept');
    assert.ok(!('password' in saved.tabs[0].panes[0].recipe.args),
        'the password key is gone entirely, not merely blanked');

    // 2. Saved-session panes keep only their node id: an edited host or
    // profile is picked up on the next connect, exactly like a reconnect.
    workspace.save([{
        title: 'Lab',
        focusedIndex: 1,
        panes: [
            { recipe: { nodeId: 'n1' }, title: 'core-sw-01', transport: 'ssh' },
            { recipe: { nodeId: 'n2' }, title: 'dist-sw-02', transport: 'telnet' },
        ],
    }], 0);
    const two = workspace.get();
    assert.strictEqual(two.tabs[0].panes.length, 2);
    assert.deepStrictEqual(two.tabs[0].panes[0].recipe, { nodeId: 'n1' });
    assert.strictEqual(two.tabs[0].focusedIndex, 1, 'focus position survives');

    // 3. Unrecognized recipe shapes are dropped, not stored. A pane that
    // cannot be redialed is dead weight, and an arbitrary object from the
    // renderer has no business being persisted verbatim.
    const r = workspace.save([{
        title: 'mixed',
        focusedIndex: 0,
        panes: [
            { recipe: { nodeId: 'ok' }, title: 'good', transport: 'ssh' },
            { recipe: { somethingElse: true }, title: 'bad', transport: 'ssh' },
            { recipe: null, title: 'worse', transport: 'ssh' },
        ],
    }], 0);
    assert.strictEqual(r.panes, 1, 'only the recognizable recipe is kept');
    assert.strictEqual(workspace.get().tabs[0].panes.length, 1);

    // 4. Scrollback is capped, so a pane that has seen a flood does not
    // become a multi-megabyte snapshot.
    workspace.save([{
        title: 'flood',
        focusedIndex: 0,
        panes: [{
            recipe: { nodeId: 'n1' }, title: 'x', transport: 'ssh',
            scrollback: 'y'.repeat(5 * 1024 * 1024),
        }],
    }], 0);
    assert.ok(workspace.get().tabs[0].panes[0].scrollback.length <= 2 * 1024 * 1024,
        'scrollback is capped');

    // 5. Empty layouts clear rather than leaving a stale picture behind.
    workspace.save([], 0);
    assert.strictEqual(workspace.get(), null, 'closing every pane clears the workspace');
    assert.strictEqual(JSON.parse(onDisk()), null, 'and the file says so');

    // 6. Tabs whose panes all dropped out do not leave empty tabs behind.
    workspace.save([
        { title: 'gone', focusedIndex: 0, panes: [{ recipe: { nope: 1 }, title: 'x' }] },
        { title: 'kept', focusedIndex: 0, panes: [{ recipe: { nodeId: 'n9' }, title: 'y' }] },
    ], 0);
    const kept = workspace.get();
    assert.strictEqual(kept.tabs.length, 1, 'an emptied tab is not persisted');
    assert.strictEqual(kept.tabs[0].title, 'kept');

    // 7. Scrollback survives the cheap saves. The renderer only serializes
    // buffers on the way out; every layout change saves without them. If
    // those saves dropped the scrollback, restoring a workspace and then
    // crashing would silently empty the scrollback still on screen.
    const pane = (over = {}) => ({
        recipe: { nodeId: 'n1' }, title: 'core-sw-01', transport: 'ssh', ...over,
    });
    workspace.save([{ title: 'T', focusedIndex: 0, panes: [pane({ scrollback: 'REAL OUTPUT' })] }], 0);
    workspace.save([{ title: 'T', focusedIndex: 0, panes: [pane()] }], 0);   // cheap save
    assert.strictEqual(workspace.get().tabs[0].panes[0].scrollback, 'REAL OUTPUT',
        'a scrollback-free save must not discard the stored scrollback');

    // ...but a pane that is genuinely a different target does not inherit
    // someone else's scrollback.
    workspace.save([{ title: 'T', focusedIndex: 0, panes: [pane({ recipe: { nodeId: 'n2' } })] }], 0);
    assert.strictEqual(workspace.get().tabs[0].panes[0].scrollback, null,
        'scrollback is carried by pane identity, not by position');

    // A fresh snapshot replaces the carried one rather than being ignored.
    workspace.save([{ title: 'T', focusedIndex: 0, panes: [pane({ scrollback: 'NEWER' })] }], 0);
    workspace.save([{ title: 'T', focusedIndex: 0, panes: [pane()] }], 0);
    assert.strictEqual(workspace.get().tabs[0].panes[0].scrollback, 'NEWER');

    // 8. A reload sees what the previous run wrote.
    delete require.cache[require.resolve('../main/workspace')];
    const reloaded = require('../main/workspace');
    reloaded.init();
    assert.strictEqual(reloaded.get().tabs[0].panes[0].scrollback, 'NEWER',
        'the snapshot survives a restart');

    console.log('ok - workspace (8 scenarios: password stripping, recipes, caps, ' +
        'scrollback carry-forward, clearing, reload)');
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
