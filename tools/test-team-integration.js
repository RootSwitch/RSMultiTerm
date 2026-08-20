'use strict';
// End-to-end team sync integration: two simulated users sharing one team
// file, sequentially re-initing the (singleton) stores to switch identity.
// This is the drift-killer feature; it gets a real workout: publish, sync,
// re-publish, conflict, lock, and the plan/apply race.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../main/store');
const sessionStore = require('../main/session-store');
const settings = require('../main/settings');
const highlights = require('../main/highlights');
const snippets = require('../main/snippets');
const teamSync = require('../main/team-sync');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-team-'));
const dirA = path.join(root, 'userA');
const dirB = path.join(root, 'userB');
const shared = path.join(root, 'share', 'team-sessions.json');
fs.mkdirSync(path.join(root, 'share'), { recursive: true });

const events = [];
function become(dir) {
    store.init(dir);
    settings.init();
    settings.update({ teamSync: { filePath: shared, pollSeconds: 9999 } });
    sessionStore.init();
    highlights.init();
    snippets.init();
    teamSync.init((ch, p) => events.push({ ch, p }));
}

(async () => {
    // --- User A builds a tree and publishes rev 1 -------------------------
    become(dirA);
    const folder = sessionStore.upsert({
        type: 'folder', name: 'Core - HQ',
        defaults: { credentialProfile: 'AD Account' },
    });
    const sw1 = sessionStore.upsert({
        type: 'session', name: 'core-sw-01', parentId: folder.id, host: '192.0.2.10',
    });
    sessionStore.upsert({
        type: 'session', name: 'core-sw-02', parentId: folder.id, host: '192.0.2.11',
    });
    // A home-lab node that must never reach the share.
    sessionStore.upsert({
        type: 'session', name: 'homelab-nas', host: '198.51.100.99', personal: true,
    });

    let r = await teamSync.publish();
    assert.strictEqual(r.rev, 1, 'first publish is rev 1');
    const fileText = fs.readFileSync(shared, 'utf8');
    assert.ok(!fileText.includes('homelab-nas'), 'personal nodes stay home');
    assert.ok(!fileText.includes('password'), 'no secrets in the file');

    // --- User B syncs and gets the tree -----------------------------------
    become(dirB);
    const planB = teamSync.planForUi();
    assert.ok(planB, 'user B sees incoming changes');
    assert.strictEqual(planB.adds.length, 3, 'folder + 2 sessions incoming');
    assert.ok(planB.token, 'plan carries a token for the apply');
    teamSync.applyDecisions({}, planB.token);
    assert.ok(sessionStore.get(sw1.id), 'user B now has core-sw-01');
    assert.strictEqual(sessionStore.get(sw1.id).host, '192.0.2.10');

    // --- User B fixes an IP and publishes rev 2 ---------------------------
    sessionStore.upsert({ ...sessionStore.get(sw1.id), host: '192.0.2.20' });
    r = await teamSync.publish();
    assert.strictEqual(r.rev, 2);

    // --- User A syncs the fix ---------------------------------------------
    become(dirA);
    const planA = teamSync.planForUi();
    assert.ok(planA && planA.changes.length === 1, 'user A sees the IP change');
    assert.deepStrictEqual(planA.changes[0].fields, ['host']);
    teamSync.applyDecisions({}, planA.token);
    assert.strictEqual(sessionStore.get(sw1.id).host, '192.0.2.20', 'drift killed');

    // --- Conflict: both edit the same field --------------------------------
    // B publishes rev 3 with one host; A edits the same host offline.
    become(dirB);
    teamSync.applyDecisions({});   // absorb rev 2 first (no token: trusted accept-all)
    sessionStore.upsert({ ...sessionStore.get(sw1.id), host: '203.0.113.5' });
    r = await teamSync.publish();
    assert.strictEqual(r.rev, 3);

    become(dirA);
    sessionStore.upsert({ ...sessionStore.get(sw1.id), host: '203.0.113.99' });
    const planC = teamSync.planForUi();
    assert.strictEqual(planC.conflicts.length, 1, 'same-field edit is a conflict');
    teamSync.applyDecisions({ conflictTakes: { [sw1.id]: 'mine' } }, planC.token);
    assert.strictEqual(sessionStore.get(sw1.id).host, '203.0.113.99', 'keep mine kept');

    // A publish then carries A's version as rev 4.
    r = await teamSync.publish();
    assert.strictEqual(r.rev, 4);
    const after = JSON.parse(fs.readFileSync(shared, 'utf8'));
    assert.strictEqual(after.nodes[sw1.id].host, '203.0.113.99');

    // --- Apply refuses a plan whose remote moved on -------------------------
    // B reviews a plan; before Apply lands, the share advances (a teammate
    // published). The stale token must be refused, and a fresh plan applies.
    become(dirB);
    const planD = teamSync.planForUi();
    assert.ok(planD && planD.token, 'B has a pending plan');
    const bumped = JSON.parse(fs.readFileSync(shared, 'utf8'));
    bumped.rev += 1;
    bumped.nodes[sw1.id].notes = 'raced you';
    fs.writeFileSync(shared, JSON.stringify(bumped));
    const staleRes = teamSync.applyDecisions({}, planD.token);
    assert.deepStrictEqual(staleRes, { applied: false, stale: true },
        'apply must refuse a plan computed against a superseded file');
    const planE = teamSync.planForUi();
    assert.notStrictEqual(planE.token, planD.token, 'fresh plan, fresh token');
    assert.strictEqual(teamSync.applyDecisions({}, planE.token).applied, true);
    assert.strictEqual(sessionStore.get(sw1.id).notes, 'raced you');

    // --- Publish behind a fresh lock refuses --------------------------------
    fs.writeFileSync(shared + '.lock', JSON.stringify({ host: 'other-pc', at: new Date().toISOString() }));
    await assert.rejects(() => teamSync.publish({ lockWaitMs: 0 }), /locked/,
        'a live lock blocks the publish');
    fs.unlinkSync(shared + '.lock');

    // --- A stale lock is broken by mtime, not by its content ----------------
    // The file says "just now" but its mtime is ancient - a dead writer's
    // lock looks exactly like this after a clock-skewed machine wrote it.
    fs.writeFileSync(shared + '.lock', JSON.stringify({ host: 'dead-pc', at: new Date().toISOString() }));
    const ancient = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(shared + '.lock', ancient, ancient);
    r = await teamSync.publish();
    assert.ok(r.rev >= 6, 'stale lock broken, publish proceeds');

    // --- Snippets travel: adopt-missing-only, edits never overwritten -------
    // B (current identity) adds a snippet and publishes; A syncs and adopts
    // it. A then edits their copy; B's next publish must NOT overwrite it.
    snippets.save(snippets.get().concat([{
        id: 'snip-team-1', name: 'Team snippet', command: 'show clock', notes: '',
    }]));
    r = await teamSync.publish();

    become(dirA);
    const planS = teamSync.planForUi();
    teamSync.applyDecisions({}, planS ? planS.token : undefined);
    const adopted = snippets.get().find((s) => s.id === 'snip-team-1');
    assert.ok(adopted, 'A adopts the teammate snippet on sync');
    assert.strictEqual(adopted.command, 'show clock');

    snippets.save(snippets.get().map((s) =>
        s.id === 'snip-team-1' ? { ...s, command: 'show clock detail' } : s));
    // Simulate B publishing again: rev moves, a node changes (so the apply
    // actually runs), and the remote still carries the OLD snippet command.
    const cur = JSON.parse(fs.readFileSync(shared, 'utf8'));
    cur.rev += 1;
    cur.nodes[sw1.id].notes = 'raced you again';
    fs.writeFileSync(shared, JSON.stringify(cur));
    const planS2 = teamSync.planForUi();
    assert.ok(planS2, 'the simulated republish must produce a plan');
    teamSync.applyDecisions({}, planS2.token);
    assert.strictEqual(snippets.get().find((s) => s.id === 'snip-team-1').command,
        'show clock detail', 'an edited snippet survives later syncs untouched');

    // --- A torn/unparseable lock file is NOT deleted ------------------------
    // Partial writes happen on SMB; garbage content must read as "held",
    // never as "delete it" - that is how two writers end up publishing at
    // once. Fresh mtime + garbage content = wait, then give up.
    fs.writeFileSync(shared + '.lock', 'not json at all {{{');
    await assert.rejects(() => teamSync.publish({ lockWaitMs: 0 }), /locked/,
        'garbage lock content must not be treated as breakable');
    assert.ok(fs.existsSync(shared + '.lock'), 'the torn lock file survives');
    fs.unlinkSync(shared + '.lock');

    console.log('ok - team sync integration (publish, sync, conflict, lock mtime+claim, stale-plan token, privacy)');
})().then(
    () => { fs.rmSync(root, { recursive: true, force: true }); process.exit(0); },
    (err) => {
        fs.rmSync(root, { recursive: true, force: true });
        console.error('FAIL -', err.message);
        process.exit(1);
    });
