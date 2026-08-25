'use strict';
// Recursive folder download: the path rules, the walk, and the fetch.
//
// The interesting half is adversarial. A directory listing is written by the
// device, and in a recursive download every component of it steers a local
// path - so a server answering with '..', 'C:evil', 'sneaky. ' or a symlink
// pointing at '/' is trying to write outside the folder the user picked, or
// to make the walk run forever. Each of those gets its own case here, and
// each is planted-defect verified.
//
// The sftp client is a stand-in rather than a real server: what is under
// test is the walking, the naming and the pooling, not ssh2's wire code,
// which test-sftp-race and test-scp already exercise against real sockets.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tree = require('../engine/sftp-tree');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-tree-'));
const dest = path.join(box, 'dest');
fs.mkdirSync(dest);

const DIR = 0x4000, LINK = 0xA000, FILE = 0x8000;
const entry = (name, kind, size = 0) => ({ filename: name, attrs: { mode: kind | 0o644, size } });

// A fake remote tree. Keys are directory paths; values are their listings.
function fakeSftp(layout, opts = {}) {
    const reads = [];
    return {
        reads,
        readdir(dir, cb) {
            const key = dir.replace(/\/+$/, '') || '/';
            if (opts.failOn && opts.failOn === key) {
                return setImmediate(() => cb(new Error('permission denied')));
            }
            const list = layout[key];
            if (!list) return setImmediate(() => cb(new Error(`no such directory: ${key}`)));
            setImmediate(() => cb(null, list));
        },
        fastGet(remote, local, _o, cb) {
            reads.push(remote);
            if (opts.failFile && remote === opts.failFile) {
                // Half-written, exactly as a real interrupted transfer
                // leaves it - the cleanup is what is being tested. `local`
                // is the module's temp name; writing there proves the
                // cleanup deletes the right file and only that file.
                fs.writeFileSync(local, 'PARTIAL');
                return setImmediate(() => cb(new Error('connection reset')));
            }
            // Deliver local-write failures through the callback the way
            // the real fastGet does - a missing parent directory is an
            // error result, not a crash.
            setImmediate(() => {
                try { fs.writeFileSync(local, `body of ${remote}`); } catch (e) { return cb(e); }
                cb(null);
            });
        },
    };
}

(async () => {
    // 1. Component naming. Each of these is a real thing a hostile or
    // merely broken server can put in a listing.
    assert.strictEqual(tree.safeComponent('config.txt'), 'config.txt');
    assert.strictEqual(tree.safeComponent('..'), null, "'..' must never be a folder name");
    assert.strictEqual(tree.safeComponent('.'), null);
    assert.strictEqual(tree.safeComponent(''), null);
    assert.strictEqual(tree.safeComponent('C:evil'), null, 'a drive or NTFS stream name must be refused');
    assert.strictEqual(tree.safeComponent('.. '), null,
        "'.. ' becomes '..' once Win32 strips the trailing space");
    assert.strictEqual(tree.safeComponent('evil.exe. '), 'evil.exe',
        'trailing dots and spaces are stripped, not used to smuggle a second name');
    assert.strictEqual(tree.safeComponent('a/b'), 'b', 'a separator in a name cannot make a subfolder');
    assert.strictEqual(tree.safeComponent('a\\b'), 'b', 'nor a Windows separator');
    // Windows device names resolve to the device, extension or not: a
    // remote file called 'nul' would "download" into nothingness and be
    // counted a success.
    for (const dev of ['con', 'NUL', 'aux', 'com1', 'lpt9', 'con.txt', 'Nul.cfg']) {
        assert.strictEqual(tree.safeComponent(dev), null, `'${dev}' is a reserved device name`);
    }
    assert.strictEqual(tree.safeComponent('console.txt'), 'console.txt',
        'reserved-name matching must not eat ordinary names that merely start the same');
    assert.strictEqual(tree.safeComponent('common1.cfg'), 'common1.cfg');
    // Characters Win32 refuses. A directory named 'a|b' used to reach
    // mkdirSync, which threw and lost the whole batch.
    for (const bad of ['a|b', 'a<b', 'a>b', 'a?b', 'a*b', 'a"b', 'a\u0007b']) {
        assert.strictEqual(tree.safeComponent(bad), null, `'${bad}' cannot be written on Windows`);
    }

    // 2. The join is contained even if a component slips through.
    assert.strictEqual(tree.localFor(dest, ['sub', 'file.txt']),
        path.resolve(dest, 'sub', 'file.txt'));
    assert.strictEqual(tree.localFor(dest, ['..', 'escape.txt']), null);
    assert.strictEqual(tree.localFor(dest, ['ok', '..', '..', 'escape.txt']), null);

    // 3. A walk of an ordinary tree finds every file at every level.
    const layout = {
        '/etc/app': [entry('a.conf', FILE, 10), entry('sub', DIR), entry('link', LINK)],
        '/etc/app/sub': [entry('b.conf', FILE, 20), entry('deep', DIR)],
        '/etc/app/sub/deep': [entry('c.conf', FILE, 30)],
    };
    const notes = [];
    const walked = await tree.walk(fakeSftp(layout), '/etc/app', dest, (n) => notes.push(n));
    assert.deepStrictEqual(walked.files.map((f) => f.remote).sort(),
        ['/etc/app/a.conf', '/etc/app/sub/b.conf', '/etc/app/sub/deep/c.conf']);
    assert.strictEqual(walked.dirs.length, 2, 'sub and sub/deep');
    assert.strictEqual(walked.skipped.links, 1, 'the symlink is skipped and counted, not followed');

    // 4. A symlink loop must not hang the walk. Following '/etc/app/self'
    // back to '/etc/app' is the classic way a recursive copy never ends.
    const loop = {
        '/loop': [entry('self', LINK), entry('real', FILE, 1)],
    };
    const looped = await tree.walk(fakeSftp(loop), '/loop', dest, () => {});
    assert.strictEqual(looped.files.length, 1);
    assert.strictEqual(looped.skipped.links, 1);

    // 5. A listing that tries to escape is refused, and nothing outside the
    // destination is even proposed.
    const evil = {
        '/evil': [entry('..', DIR), entry('C:sneaky', FILE, 1), entry('fine.txt', FILE, 1)],
    };
    const dodged = await tree.walk(fakeSftp(evil), '/evil', dest, () => {});
    assert.deepStrictEqual(dodged.files.map((f) => f.remote), ['/evil/fine.txt']);
    assert.strictEqual(dodged.skipped.unsafe, 2, "'..' and 'C:sneaky' must both be refused");
    for (const f of dodged.files) {
        assert.ok(path.resolve(f.local).startsWith(path.resolve(dest) + path.sep),
            `${f.local} is outside the chosen folder`);
    }

    // 5b. Distinct remote names that collide on one LOCAL path: README vs
    // readme on a case-insensitive filesystem, and 'a' vs 'a. ' after the
    // trailing-dot trim. With six concurrent fetches, two transfers held
    // the same file open and interleaved - and both counted as successes.
    // First name wins; the rest are skipped and counted.
    const clash = {
        '/clash': [entry('README', FILE, 5), entry('readme', FILE, 5),
            entry('a', FILE, 1), entry('a. ', FILE, 1), entry('ok.txt', FILE, 1)],
    };
    const clashNotes = [];
    const c = await tree.walk(fakeSftp(clash), '/clash', dest, (n) => clashNotes.push(n));
    assert.deepStrictEqual(c.files.map((f) => f.remote).sort(),
        ['/clash/README', '/clash/a', '/clash/ok.txt'],
        'one winner per local path - the case twin and the dot twin are skipped');
    assert.strictEqual(c.skipped.unsafe, 2, 'both collisions counted');
    assert.ok(clashNotes.some((n) => /collides/.test(n)), 'collisions are said out loud');

    // 5c. Breadth is bounded. A server answering every readdir with fresh
    // subdirectories used to grow the queue and the mkdir list without
    // limit - and once a cap IS hit, the walk stops instead of continuing
    // to pull listings for a result it already knows is truncated.
    const bomb = { '/bomb': [] };
    for (let i = 0; i < 600; i++) bomb['/bomb'].push(entry(`d${i}`, DIR));
    for (let i = 0; i < 600; i++) {
        bomb[`/bomb/d${i}`] = [];
        for (let j = 0; j < 60; j++) bomb[`/bomb/d${i}`].push(entry(`s${j}`, DIR));
        for (let j = 0; j < 60; j++) bomb[`/bomb/d${i}/s${j}`] = [entry('x', DIR)];
    }
    const bombSftp = fakeSftp(bomb);
    let reads = 0;
    const countingSftp = {
        readdir(dir, cb) { reads++; return bombSftp.readdir(dir, cb); },
        fastGet: bombSftp.fastGet,
    };
    const bombed = await tree.walk(countingSftp, '/bomb', dest, () => {});
    assert.ok(bombed.truncated, 'a breadth bomb must report itself as truncated');
    assert.ok(bombed.dirs.length <= tree.MAX_DIRS,
        `dirs must stay under the cap, got ${bombed.dirs.length}`);
    // The queue itself is capped by MAX_DIRS, so the discriminating bound
    // is much tighter than the dir count: with the early exit the walk
    // stops within the listing that hit the cap (~150 reads here); without
    // it, everything already queued still gets read (~5000).
    assert.ok(reads < tree.MAX_DIRS / 4,
        `the walk must stop READING once truncated - ${reads} readdirs`);

    // 6. An unreadable directory is reported and the rest of the tree still
    // downloads - a permission-denied subfolder must not lose the config
    // that sits beside it.
    const partial = {
        '/p': [entry('open', DIR), entry('shut', DIR), entry('top.txt', FILE, 1)],
        '/p/open': [entry('in.txt', FILE, 1)],
        '/p/shut': [],
    };
    const notes2 = [];
    const w2 = await tree.walk(fakeSftp(partial, { failOn: '/p/shut' }), '/p', dest, (n) => notes2.push(n));
    assert.strictEqual(w2.files.length, 2);
    assert.ok(notes2.some((n) => /permission denied/.test(n)), 'the unreadable folder must be reported');

    // 7. End to end: the files land, with their content and their shape.
    // The destination is NOT pre-created - the panel passes <picked
    // folder>/<remote name>, which never exists on a first download, and
    // this test's own mkdirSync here is what hid that failure in the
    // version that shipped.
    const out = path.join(box, 'out');
    const sftp = fakeSftp(layout);
    const result = await tree.downloadTree(sftp, { path: '/etc/app', local: out }, () => {});
    assert.strictEqual(result.files, 3);
    assert.strictEqual(result.skippedLinks, 1);
    assert.strictEqual(fs.readFileSync(path.join(out, 'a.conf'), 'utf8'), 'body of /etc/app/a.conf');
    assert.strictEqual(fs.readFileSync(path.join(out, 'sub', 'deep', 'c.conf'), 'utf8'),
        'body of /etc/app/sub/deep/c.conf');
    assert.ok(!fs.existsSync(path.join(out, 'link')), 'a symlink must not have been fetched');

    // 8. Files are fetched CONCURRENTLY. This is the whole point of moving
    // the loop into the engine: 167 small files one-at-a-time is the minute
    // MobaXterm takes. Proven by holding every callback until enough of
    // them have arrived at once - a serial implementation deadlocks here
    // and the test times out rather than passing quietly.
    const many = { '/many': Array.from({ length: 30 }, (_, i) => entry(`f${i}.txt`, FILE, 1)) };
    const out2 = path.join(box, 'out2');
    let inFlight = 0, peak = 0;
    const waiters = [];
    const slow = {
        readdir: fakeSftp(many).readdir,
        fastGet(remote, local, _o, cb) {
            inFlight++;
            peak = Math.max(peak, inFlight);
            const finish = () => {
                fs.writeFileSync(local, 'x');
                inFlight--;
                cb(null);
            };
            // Release only once several are waiting together; if the
            // implementation is serial, the second never arrives.
            waiters.push(finish);
            if (waiters.length >= 3) while (waiters.length) setImmediate(waiters.shift());
        },
    };
    // A serial implementation never releases the batch, so it would hang
    // here rather than fail. A hang reads as a stuck build; race it against
    // a deadline so it says what is wrong instead.
    // The timer must NOT be unref'd: a serial implementation leaves nothing
    // else pending, so an unref'd deadline lets the loop empty and node
    // exits 0 having tested nothing. It is cleared on the way out instead.
    let deadline;
    const r2 = await Promise.race([
        tree.downloadTree(slow, { path: '/many', local: out2 }, () => {}),
        new Promise((_, rej) => { deadline = setTimeout(() => rej(new Error(
            `transfers are serial: ${inFlight} in flight, peak ${peak}, expected at least 3 at once`
        )), 5000); }),
    ]).finally(() => clearTimeout(deadline));
    assert.strictEqual(r2.files, 30);
    assert.ok(peak >= 3, `expected several transfers in flight at once, saw ${peak}`);

    // 9. A failed file leaves nothing behind - and takes nothing with it.
    // The transfer works on <name>.part and renames on success, so a
    // failure deletes only what THIS run wrote. The old cleanup unlinked
    // the FINAL name, which deleted a pre-existing good file when the
    // remote open failed before a byte moved.
    const out3 = path.join(box, 'out3');
    fs.mkdirSync(path.join(out3, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(out3, 'sub', 'b.conf'), 'YESTERDAYS GOOD BACKUP');
    const flaky = fakeSftp(layout, { failFile: '/etc/app/sub/b.conf' });
    const r3 = await tree.downloadTree(flaky, { path: '/etc/app', local: out3 }, () => {});
    assert.strictEqual(r3.failureCount, 1);
    assert.strictEqual(r3.files, 2, 'the other two still arrive');
    assert.strictEqual(fs.readFileSync(path.join(out3, 'sub', 'b.conf'), 'utf8'),
        'YESTERDAYS GOOD BACKUP',
        'a failed download must not delete the pre-existing file it was replacing');
    assert.ok(!fs.existsSync(path.join(out3, 'sub', 'b.conf.part')),
        'the temp file must be cleaned up');

    // 9b. A directory that cannot be created locally loses its subtree,
    // not the batch. 'blocker' exists as a FILE locally, so its mkdir
    // fails; top.txt beside it must still arrive, with the failure noted.
    const out5 = path.join(box, 'out5');
    fs.mkdirSync(out5, { recursive: true });
    fs.writeFileSync(path.join(out5, 'blocker'), 'i am a file');
    const blocked = {
        '/blk': [entry('blocker', DIR), entry('top.txt', FILE, 1)],
        '/blk/blocker': [entry('inner.txt', FILE, 1)],
    };
    const rb = await tree.downloadTree(fakeSftp(blocked), { path: '/blk', local: out5 }, () => {});
    assert.ok(fs.existsSync(path.join(out5, 'top.txt')), 'the rest of the batch still arrives');
    assert.strictEqual(fs.readFileSync(path.join(out5, 'blocker'), 'utf8'), 'i am a file',
        'the blocking file is untouched');
    assert.strictEqual(rb.failureCount, 1, 'the file under the failed directory is a counted failure');

    // 9c. engine/sftp.js transfer() has the same discipline, both
    // directions, driven through a stub sftp channel.
    const sftpMod = require('../engine/sftp');
    const calls = [];
    const stubChan = (opts2 = {}) => ({
        fastGet(remote, local, _o, cb) {
            calls.push(['get', local]);
            if (opts2.failGet) return setImmediate(() => cb(new Error('remote open failed')));
            fs.writeFileSync(local, 'FRESH');
            setImmediate(() => cb(null));
        },
        fastPut(local, remote, _o, cb) {
            calls.push(['put', remote]);
            setImmediate(() => cb(opts2.failPut ? new Error('link dropped') : null));
        },
        rename(from, to, cb) { calls.push(['rename', from, to]); setImmediate(() => cb(null)); },
        unlink(p, cb) { calls.push(['unlink', p]); setImmediate(() => cb(null)); },
    });
    // Download failure preserves the pre-existing local file...
    const keep = path.join(box, 'keep.cfg');
    fs.writeFileSync(keep, 'DO NOT DELETE');
    await assert.rejects(() => sftpMod.transfer(stubChan({ failGet: true }), 'get',
        { path: '/r/keep.cfg', local: keep }, () => {}), /remote open failed/);
    assert.strictEqual(fs.readFileSync(keep, 'utf8'), 'DO NOT DELETE',
        'a failed download must never delete the file it was going to replace');
    // ...success replaces it via the temp name.
    await sftpMod.transfer(stubChan(), 'get', { path: '/r/keep.cfg', local: keep }, () => {});
    assert.strictEqual(fs.readFileSync(keep, 'utf8'), 'FRESH');
    assert.ok(!fs.existsSync(keep + '.part'), 'no temp file left behind');
    // Upload goes to a temp remote name and renames into place - fastPut
    // opening the FINAL name with 'w' is how a dropped link left a
    // truncated remote config that looked complete.
    calls.length = 0;
    const up = path.join(box, 'up.cfg');
    fs.writeFileSync(up, 'config');
    await sftpMod.transfer(stubChan(), 'put', { local: up, path: '/flash/run.cfg' }, () => {});
    assert.strictEqual(calls[0][0], 'put');
    assert.strictEqual(calls[0][1], '/flash/run.cfg.part',
        'the upload must write to a temp remote name, never straight onto the target');
    assert.deepStrictEqual(calls[calls.length - 1], ['rename', '/flash/run.cfg.part', '/flash/run.cfg']);
    // A failed upload cleans its temp and never touched the target.
    calls.length = 0;
    await assert.rejects(() => sftpMod.transfer(stubChan({ failPut: true }), 'put',
        { local: up, path: '/flash/run.cfg' }, () => {}), /link dropped/);
    assert.ok(calls.some((c) => c[0] === 'unlink' && c[1] === '/flash/run.cfg.part'),
        'the partial remote temp is removed');
    assert.ok(!calls.some((c) => c[0] === 'rename'), 'nothing is moved onto the target on failure');

    // 10. Progress reports a file count, and a phase the panel can read.
    const out4 = path.join(box, 'out4');
    const seen = [];
    await tree.downloadTree(fakeSftp(layout), { path: '/etc/app', local: out4 }, (p) => seen.push(p));
    assert.ok(seen.some((p) => p.phase === 'scanning'), 'the walk must announce itself');
    const last = seen[seen.length - 1];
    assert.strictEqual(last.phase, 'downloading');
    assert.strictEqual(last.files, 3);
    assert.strictEqual(last.total, 3, 'the total is known up front because the walk finishes first');

    console.log('ok - sftp folder download (walk, traversal/symlink/reserved-name/collision ' +
        'refusals, breadth caps, first-use creation, concurrency, .part discipline both ways)');
})().then(
    () => { fs.rmSync(box, { recursive: true, force: true }); },
    (err) => { fs.rmSync(box, { recursive: true, force: true }); console.error(err); process.exit(1); },
);
