'use strict';
// Session logging: what actually lands on disk.
//
// Written when per-line timestamps stopped being the default. The reason
// they stopped is worth stating, because it is the property this file
// pins: a log with a date on every line is hostile to the tool you read
// logs with. Searching a folder of them for a date, a time, or anything
// that looks like one matches every line of every file - and searching
// logs is what logs are for. The session's start time lives in the
// filename and in a one-line header instead, which costs a search
// nothing.
//
// The other half is the raw-mode promise: raw logs are the exact bytes
// the device sent, for replaying escape-sequence problems. A header line
// this app invented is not one of those bytes, so raw files never get one.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SessionLogger } = require('../engine/logger');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-log-'));
const read = (p) => fs.readFileSync(p, 'utf8');

// The logger writes into {dir}/{yyyy-MM-dd}/, one file per session.
function onlyFile(dir, ext) {
    const day = fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    assert.strictEqual(day.length, 1, 'exactly one date folder');
    const files = fs.readdirSync(path.join(dir, day[0]))
        .filter((f) => (ext === '.raw.log' ? f.endsWith('.raw.log') : f.endsWith('.log') && !f.endsWith('.raw.log')));
    assert.strictEqual(files.length, 1, `exactly one ${ext} file, got ${files.join(', ')}`);
    return path.join(dir, day[0], files[0]);
}

(async () => {
    // 1. Text mode, timestamps OFF (the default since 1.0.3). Every line is
    // exactly what the device said, so a search for 'startup-config' finds
    // the line and nothing else.
    {
        const dir = path.join(box, 'plain');
        const log = new SessionLogger({ dir, sessionName: 'core-sw-01',
            host: '10.50.1.7', mode: 'text', timestamps: false });
        log.write(Buffer.from('show version\r\n'));
        log.write(Buffer.from('Cisco IOS Software\r\n'));
        await log.close();

        const body = read(onlyFile(dir, '.log'));
        const lines = body.split('\n').filter(Boolean);
        assert.ok(lines[0].startsWith('--- RSMultiTerm log:'),
            'the file says what it is on line one');
        assert.ok(lines[0].includes('core-sw-01') && lines[0].includes('10.50.1.7'),
            'the header names the session and the host');
        assert.ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(lines[0]),
            'the header carries the start time - the part per-line stamps were for');
        assert.deepStrictEqual(lines.slice(1), ['show version', 'Cisco IOS Software']);
        // The property that made this the default: exactly ONE line in the
        // file mentions a date, however many lines the device sent.
        const dated = lines.filter((l) => /\d{4}-\d{2}-\d{2}/.test(l));
        assert.strictEqual(dated.length, 1,
            'only the header may carry a date - one stamped line per FILE, not per line');
    }

    // 2. Text mode, timestamps ON. Still available, and still exactly what
    // it says: a stamp at the start of every completed line.
    {
        const dir = path.join(box, 'stamped');
        const log = new SessionLogger({ dir, sessionName: 'core-sw-01',
            host: '10.50.1.7', mode: 'text', timestamps: true });
        log.write(Buffer.from('one\r\ntwo\r\n'));
        await log.close();

        const lines = read(onlyFile(dir, '.log')).split('\n').filter(Boolean);
        assert.ok(lines[0].startsWith('--- RSMultiTerm log:'), 'header still first');
        for (const l of lines.slice(1)) {
            assert.ok(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /.test(l),
                `a stamped line must start with its stamp: ${JSON.stringify(l)}`);
        }
        assert.ok(lines[1].endsWith('one') && lines[2].endsWith('two'));
    }

    // 3. Raw mode is byte-exact. No header, no stamps, no stripping - it
    // exists so an escape-sequence problem can be replayed, and anything
    // this app adds to it breaks that.
    {
        const dir = path.join(box, 'raw');
        const bytes = Buffer.from('\x1b[31mred\x1b[0m\r\n');
        const log = new SessionLogger({ dir, sessionName: 'sw', host: 'h',
            mode: 'raw', timestamps: true });
        log.write(bytes);
        await log.close();

        const body = fs.readFileSync(onlyFile(dir, '.raw.log'));
        assert.deepStrictEqual(body, bytes,
            'a raw log is the exact bytes received - no header, no stamps');
    }

    // 4. Rotation keeps the file self-describing: the next part says which
    // part it is and when it started, so a split log is not anonymous.
    {
        const dir = path.join(box, 'rotate');
        const log = new SessionLogger({ dir, sessionName: 'sw', host: 'h',
            mode: 'text', timestamps: false, rotateBytes: 200 });
        for (let i = 0; i < 40; i++) log.write(Buffer.from(`line ${i} padding padding\r\n`));
        await log.close();

        const day = fs.readdirSync(dir)[0];
        const files = fs.readdirSync(path.join(dir, day)).sort();
        assert.ok(files.length > 1, 'the size threshold rolled the file');
        const part2 = files.find((f) => f.includes('part2'));
        assert.ok(part2, 'the rolled file is named partN');
        const head = read(path.join(dir, day, part2)).split('\n')[0];
        assert.ok(head.startsWith('--- RSMultiTerm log:') && head.includes('part 2'),
            'a rolled part says which part it is');
    }

    console.log('ok - session logging (header not per-line stamps by default, ' +
        'stamps when asked, raw stays byte-exact, rotated parts self-describe)');
})().then(
    () => { fs.rmSync(box, { recursive: true, force: true }); },
    (err) => {
        fs.rmSync(box, { recursive: true, force: true });
        console.error('FAIL -', err.stack || err.message);
        process.exit(1);
    },
);
