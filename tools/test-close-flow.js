'use strict';
// Window-close sequencing, and the SFTP listing metadata.
//
// The close handler is re-entrant: taking the final workspace snapshot
// means cancelling the close, saving, then closing again - which runs the
// handler a second time. That re-entry once asked "N sessions still
// connected" TWICE for a single close, which is what this pins.

const assert = require('assert');
const { nextStep } = require('../main/close-flow');
const { formatMode, ownerGroup } = require('../engine/sftp');

// --- close flow -------------------------------------------------------------

// Drive a whole close the way main.js does, counting the questions asked.
function runClose({ liveCount, answer = 'close', quitting = false, smoke = false }) {
    let confirmed = false;
    let snapshotTaken = false;
    let prompts = 0;
    let snapshots = 0;
    let closed = false;
    let cancelled = false;

    // Bounded: a sequencing bug that loops forever should fail the test,
    // not hang it.
    for (let i = 0; i < 10; i++) {
        const step = nextStep({ quitting, smoke, liveCount, confirmed, snapshotTaken });
        if (step === 'allow') { closed = true; break; }
        if (step === 'confirm') {
            prompts++;
            if (answer !== 'close') { cancelled = true; break; }
            confirmed = true;
            continue;
        }
        // 'snapshot': cancel the close, save, then close again - the
        // re-entry that made this worth extracting.
        snapshots++;
        snapshotTaken = true;
        continue;
    }
    return { prompts, snapshots, closed, cancelled };
}

// 1. Live sessions: exactly ONE question and ONE snapshot, then it closes.
{
    const r = runClose({ liveCount: 2 });
    assert.strictEqual(r.prompts, 1,
        `closing with live sessions must ask exactly once, asked ${r.prompts}`);
    assert.strictEqual(r.snapshots, 1, 'exactly one final snapshot');
    assert.ok(r.closed, 'the window closes after confirming');
}

// 2. Same for one session, and for a big grid - the count in the message
// changes, the number of questions does not.
for (const n of [1, 6, 30]) {
    const r = runClose({ liveCount: n });
    assert.strictEqual(r.prompts, 1, `${n} sessions must still ask exactly once`);
}

// 3. Declining keeps the window open, and takes no snapshot.
{
    const r = runClose({ liveCount: 3, answer: 'keep' });
    assert.strictEqual(r.prompts, 1);
    assert.ok(r.cancelled && !r.closed, 'Keep working must cancel the close');
    assert.strictEqual(r.snapshots, 0, 'a cancelled close must not snapshot');
}

// 4. No live sessions: no question at all, but still a snapshot - the
// layout is worth restoring even when nothing was connected.
{
    const r = runClose({ liveCount: 0 });
    assert.strictEqual(r.prompts, 0, 'nothing connected, nothing to warn about');
    assert.strictEqual(r.snapshots, 1);
    assert.ok(r.closed);
}

// 5. A quit already under way, and smoke runs, close without ceremony.
for (const flags of [{ quitting: true }, { smoke: true }]) {
    const r = runClose({ liveCount: 5, ...flags });
    assert.strictEqual(r.prompts, 0, `${JSON.stringify(flags)} must not prompt`);
    assert.strictEqual(r.snapshots, 0);
    assert.ok(r.closed);
}

// --- SFTP listing metadata --------------------------------------------------

// 6. POSIX mode rendering, including the special bits - `-rwsr-xr-x` on a
// binary is exactly the kind of thing this column exists to surface.
const M = {
    dir755: 0o040755, file644: 0o100644, file600: 0o100600,
    link777: 0o120777, setuid: 0o104755, setgid: 0o102755,
    sticky: 0o041777, setuidNoX: 0o104644, stickyNoX: 0o041666,
};
assert.strictEqual(formatMode(M.dir755), 'drwxr-xr-x');
assert.strictEqual(formatMode(M.file644), '-rw-r--r--');
assert.strictEqual(formatMode(M.file600), '-rw-------');
assert.strictEqual(formatMode(M.link777), 'lrwxrwxrwx');
assert.strictEqual(formatMode(M.setuid), '-rwsr-xr-x', 'setuid with execute is lowercase s');
assert.strictEqual(formatMode(M.setgid), '-rwxr-sr-x', 'setgid with execute is lowercase s');
assert.strictEqual(formatMode(M.sticky), 'drwxrwxrwt', 'sticky /tmp-style directory');
assert.strictEqual(formatMode(M.setuidNoX), '-rwSr--r--', 'setuid WITHOUT execute is capital S');
assert.strictEqual(formatMode(M.stickyNoX), 'drw-rw-rwT', 'sticky without execute is capital T');
assert.strictEqual(formatMode(undefined), '', 'a missing mode renders as nothing, not garbage');

// 7. Owner/group come from the server's ls -l line when it has one, and
// fall back to the numeric ids when it does not - never invented.
{
    const attrs = { uid: 0, gid: 10 };
    const long = '-rw-r--r--    1 root     wheel        1234 Jan  1 12:00 startup-config';
    assert.deepStrictEqual(ownerGroup(long, attrs), { owner: 'root', group: 'wheel' });

    // SELinux/ACL marker after the mode (the '.' or '+' ls prints).
    const acl = '-rw-r--r--.   1 admin    netops       4096 Feb  2 09:30 running-config';
    assert.deepStrictEqual(ownerGroup(acl, attrs), { owner: 'admin', group: 'netops' });

    // A directory line.
    const dir = 'drwxr-xr-x    2 nettest  nettest      4096 Mar  3 08:00 configs';
    assert.deepStrictEqual(ownerGroup(dir, attrs), { owner: 'nettest', group: 'nettest' });

    // No longname, or one this does not recognise: use the numbers.
    assert.deepStrictEqual(ownerGroup(undefined, attrs), { owner: '0', group: '10' });
    assert.deepStrictEqual(ownerGroup('some other format entirely', attrs),
        { owner: '0', group: '10' });
    // Neither names nor numbers: empty, not 'undefined'.
    assert.deepStrictEqual(ownerGroup(undefined, {}), { owner: '', group: '' });
}

console.log('ok - close flow (one prompt per close) + sftp metadata (posix modes, owner/group)');
