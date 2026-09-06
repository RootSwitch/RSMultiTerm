'use strict';
// The emulated text log: what the terminal SHOWED, line by line.
//
// Two kinds of evidence. The fixtures in tools/fixtures/ are real bytes -
// bash 5.3 readline under a pty (typos corrected, a command Ctrl-U'd, a
// wrapped line edited, a heredoc typed and then pasted, a \r progress bar,
// nano, a whiptail dialog, clear) and a real apt-get reinstall on Ubuntu
// 24.04 with needrestart. The old stripper logged a corrected typo as
// "echo hxlloello", a pasted heredoc twice with "EOFcat <<EOF" gluing the
// copies, and needrestart's progress bar as one 12,725-character line.
//
// The oracle is deliberately a DIFFERENT reading of the same bytes: a plain
// terminal fed the whole stream at once and dumped afterwards. It has no
// markers, no flushing, no erase handling, so it cannot share a bug with
// the streaming logger - it can only agree with it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Terminal } = require('@xterm/headless');
const { ScreenLog, ALT_NOTE } = require('../engine/screen-log');

const FIX = path.join(__dirname, 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/;

// Bytes through the logger as the engine would feed it.
async function run(buf, opts = {}) {
    const lines = [];
    const log = new ScreenLog({
        cols: opts.cols || 80, rows: opts.rows || 24,
        idleMs: opts.idleMs === undefined ? 0 : opts.idleMs,
        onLine: (t) => lines.push(t),
    });
    if (opts.split) {
        for (let i = 0; i < buf.length; i += opts.split) log.write(buf.subarray(i, i + opts.split));
    } else {
        log.write(buf);
    }
    await log.close();
    return lines;
}

// The independent reading: the whole stream, then the buffer, wrapped rows
// joined the same way.
async function oracle(buf, cols = 80, rows = 24) {
    const t = new Terminal({ cols, rows, scrollback: 100000, allowProposedApi: true });
    await new Promise((r) => t.write(buf, r));
    const b = t.buffer.normal;
    const out = [];
    let i = 0;
    while (i < b.length) {
        let j = i + 1;
        while (j < b.length && b.getLine(j).isWrapped) j++;
        let text = '';
        for (let k = i; k < j; k++) text += b.getLine(k).translateToString(k === j - 1);
        out.push(text);
        i = j;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    t.dispose();
    return out;
}

(async () => {
    const readline = fs.readFileSync(path.join(FIX, 'bash-readline.bin'));
    const offsets = JSON.parse(fs.readFileSync(path.join(FIX, 'bash-readline.offsets.json'), 'utf8'));
    const apt = fs.readFileSync(path.join(FIX, 'apt-reinstall.bin'));

    // 1. Chunk boundaries cannot matter. The 1-byte feed puts a boundary
    // inside every escape and every multi-byte UTF-8 character.
    const whole = await run(readline);
    assert.deepStrictEqual(await run(readline, { split: 7 }), whole, '7-byte chunks must log identically');
    assert.deepStrictEqual(await run(readline, { split: 1 }), whole, 'byte-by-byte must log identically');
    const count = (needle) => whole.filter((l) => l === needle).length;
    const has = (needle) => whole.some((l) => l.includes(needle));

    // 2. A corrected typo logs corrected; the erased characters are gone.
    assert.strictEqual(count('user@host:~$ echo hello'), 2, 'the plain echo and the corrected one');
    assert.ok(!has('hxllo'), 'backspaced characters must not survive (stripper: "echo hxlloello")');
    assert.strictEqual(count('user@host:~$ ls'), 1, 'the corrected ls');
    assert.ok(!has('lss'), 'a typo fixed at the end of the line must not survive');

    // 3. A completed-then-abandoned command (Ctrl-U) never ran and is not logged.
    assert.ok(!has('ls notes.md'), 'a line cleared with Ctrl-U must not be logged as if it ran');

    // 4. A 105-character command wrapped over two rows, edited at the
    // front, with the edit applied - not the original glued to its redraw.
    // Readline does not redraw the line, it DIFFS it: cursor up, the one
    // inserted X, then an explicit CR LF down to the next row for the one
    // character that overflowed. An explicit newline onto an auto-wrapped
    // row un-marks the wrap in xterm, so the screen - and therefore the log
    // - breaks the line there. Either form is accepted; the content is what
    // matters. The unedited OUTPUT line wraps by auto-margin and stays one.
    const iEdit = whole.findIndex((l) => l.startsWith('user@host:~$ echo X'));
    assert.ok(iEdit !== -1, 'the edited command is logged');
    const edited = whole[iEdit].length >= 119 ? whole[iEdit] : whole[iEdit] + whole[iEdit + 1];
    assert.strictEqual(edited, 'user@host:~$ echo X' + 'a'.repeat(100), 'the edited command, edit applied');
    assert.strictEqual(count('X' + 'a'.repeat(100)), 1, 'its output, one line');
    assert.ok(!has('Xecho'), 'the redraw must not be concatenated onto the original');

    // 5. A pasted heredoc appears once. Readline redraws the pasted block
    // with cursor-up moves; the stripper logged both copies as
    // "...EOFcat <<EOF...".
    assert.ok(!has('EOFcat'), 'a pasted heredoc must not be logged twice');
    assert.strictEqual(count('user@host:~$ cat <<EOF'), 2, 'typed once, pasted once');
    assert.strictEqual(count('line one'), 3, 'typed heredoc output, pasted display, pasted output');
    assert.ok(!has('pasted-becho'), 'a two-command paste must not be glued to its redraw');
    assert.strictEqual(count('echo pasted-b'), 1);

    // 6. A \r progress bar logs its final frame only.
    assert.strictEqual(count('progress 5/5'), 1);
    assert.ok(!has('progress 1/5'), 'overwritten frames must not survive');

    // 7. Full-screen programs: one note each, in place, none of the paint.
    assert.strictEqual(count(ALT_NOTE), 2, 'nano and whiptail: one note each');
    assert.ok(!has('GNU nano') && !has('Write Out') && !has('<Ok>'), 'no alternate-screen paint in the log');
    const iNano = whole.indexOf('user@host:~$ nano notes.md');
    assert.ok(iNano !== -1 && whole[iNano + 1] === ALT_NOTE,
        'the note sits right after the command that started the program');
    assert.ok(whole[iNano + 2].startsWith('user@host:~$ '),
        'and the prompt after the program exits is not lost');

    // 8. Ctrl-C.
    assert.strictEqual(count('user@host:~$ sleep 50^C'), 1);

    // 9. `clear` (ESC[2J ESC[3J) wipes the screen AND its scrollback; the log
    // keeps everything. Pin it against the oracle both ways: up to the
    // clear the log is the screen history, after it the log ends with
    // exactly what the screen shows.
    const beforeClear = readline.subarray(0, offsets['13-clear'][0]);
    const history = (await oracle(beforeClear)).slice(0, -1);     // last line is the bare prompt that then gets 'clear' typed on it
    const logged = whole.filter((l) => l !== ALT_NOTE);
    assert.deepStrictEqual(logged.slice(0, history.length), history,
        'up to the clear, the log is the screen history');
    const after = await oracle(readline);
    assert.ok(!after.some((l) => l.includes('progress 5/5')), 'sanity: the screen itself lost pre-clear history');
    assert.deepStrictEqual(logged.slice(-after.length), after, 'after the clear, the log is what the screen shows');
    assert.ok(has('progress 5/5'), 'the log keeps what clear wiped');

    // 10. UTF-8 and colour: text survives, escapes do not.
    assert.ok(has('up ┌─┐ café'), 'UTF-8 box drawing and accents survive; the colour escapes do not');

    // 11. Never a control byte.
    for (const l of whole) assert.ok(!CONTROL.test(l), 'control byte in the log: ' + JSON.stringify(l));

    // 12. Real apt: identical to the independent reading, and the bars are lines.
    const aptLog = (await run(apt)).filter((l) => l !== ALT_NOTE);
    assert.deepStrictEqual(aptLog, await oracle(apt), 'the apt session must match the screen history exactly');
    const scan = aptLog.find((l) => l.startsWith('Scanning processes'));
    assert.ok(scan && scan.length < 100, `needrestart's bar is one short line, got ${scan && scan.length}`);
    assert.ok(Math.max(...aptLog.map((l) => l.length)) <= 200, 'no line longer than a couple of screen rows');
    assert.ok(aptLog.some((l) => l.startsWith('Reading package lists... Done')), 'apt CR frames resolve to their final text');
    assert.ok(!aptLog.some((l) => /0%.*0%/.test(l)), 'no frames glued together');

    // 13. Scrollback trimming. 3000 lines through a 3-row screen with a
    // 1000-line scrollback: every line once, in order - the marker follows
    // its row as older ones are trimmed.
    let s = '';
    for (let i = 1; i <= 3000; i++) s += 'L' + i + '\r\n';
    const many = await run(Buffer.from(s), { rows: 3 });
    assert.strictEqual(many.length, 3000);
    assert.strictEqual(many[0], 'L1');
    assert.strictEqual(many[1499], 'L1500');
    assert.strictEqual(many[2999], 'L3000');
    assert.deepStrictEqual(await run(Buffer.from(s), { rows: 3, split: 1 }), many, 'byte-split too');

    // 14. An idle commit, then the app clears scrollback (ESC[3J): nothing
    // twice, nothing lost.
    {
        const lines = [];
        const log = new ScreenLog({ cols: 20, rows: 2, idleMs: 20, onLine: (t) => lines.push(t) });
        log.write(Buffer.from('a\r\nb\r\nc'));
        await sleep(100);
        assert.deepStrictEqual(lines, ['a', 'b'], 'idle commits everything above the line being edited, not that line');
        log.write(Buffer.from('\x1b[3J'));
        log.write(Buffer.from('\r\nd\r\ne'));
        await log.close();
        assert.deepStrictEqual(lines, ['a', 'b', 'c', 'd', 'e']);
    }

    // 15. Erase-display writes the screen first, in both spellings - and
    // readline's partial erase-below must NOT commit the line being edited.
    assert.deepStrictEqual(await run(Buffer.from('one\r\ntwo\r\nthree\x1b[H\x1b[2J\x1b[3Jfour'), { rows: 5 }),
        ['one', 'two', 'three', 'four'], 'ESC[2J');
    assert.deepStrictEqual(await run(Buffer.from('one\r\ntwo\x1b[H\x1b[Jthree'), { rows: 5 }),
        ['one', 'two', 'three'], 'ESC[H ESC[J');
    assert.deepStrictEqual(await run(Buffer.from('prompt$ abc\x1b[J\x08\x1b[K\r\n'), { rows: 5 }),
        ['prompt$ ab'], 'a partial erase mid-line must not freeze the line being edited');
    assert.deepStrictEqual(await run(Buffer.from('one\r\ntwo\x1bcthree'), { rows: 5 }),
        ['one', 'two', 'three'], 'a full reset (ESC c) writes the screen first');
    // A bare ESC[2J with a FULL scrollback, then more scrolling: the erase
    // disposes the pointer's marker, and the next scrolls trim at the cap -
    // the canary on the last scrollback line carries that shift.
    {
        let s2 = '';
        for (let i = 1; i <= 1200; i++) s2 += 'P' + i + '\r\n';
        const out = await run(Buffer.from(s2 + 'top\x1b[H\x1b[2Jafter1\r\nafter2\r\nafter3\r\nafter4'), { rows: 3 });
        assert.strictEqual(out.length, 1200 + 1 + 4, 'every line once through erase and trims');
        assert.deepStrictEqual(out.slice(-5), ['top', 'after1', 'after2', 'after3', 'after4']);
        assert.strictEqual(out[0], 'P1');
        assert.strictEqual(out[1199], 'P1200');
    }

    // 16. Soft-wrapped rows join into one line.
    assert.deepStrictEqual(await run(Buffer.from('abcdefghijKLMNO\r\nnext'), { cols: 10, rows: 3 }),
        ['abcdefghijKLMNO', 'next']);

    // 17. The full-screen note lands in order, and the prompt after is kept.
    assert.deepStrictEqual(await run(Buffer.from('cmd\r\n\x1b[?1049hHIDDEN\x1b[?1049lback\r\n'), { rows: 5 }),
        ['cmd', ALT_NOTE, 'back']);

    // 18. Resize: rows shrink, columns grow (reflow joins a wrapped line) -
    // each line once.
    {
        const lines = [];
        const log = new ScreenLog({ cols: 10, rows: 4, idleMs: 0, onLine: (t) => lines.push(t) });
        log.write(Buffer.from('abcdefghijKL\r\nsecond\r\n'));
        log.resize(20, 2);
        log.write(Buffer.from('third'));
        await log.close();
        assert.deepStrictEqual(lines, ['abcdefghijKL', 'second', 'third']);
    }

    // 19. close() waits for everything already written to be parsed.
    {
        const lines = [];
        const log = new ScreenLog({ rows: 3, idleMs: 0, onLine: (t) => lines.push(t) });
        log.write(Buffer.from('x\r\n'.repeat(5000)));
        await log.close();
        assert.strictEqual(lines.length, 5000);
        log.write(Buffer.from('late\r\n'));
        assert.strictEqual(lines.length, 5000, 'a write after close is ignored');
    }

    // 20. Hostile bytes - raw C1 controls, UTF-8-encoded C1, an OSC, a
    // two-byte ESC - never a control byte out, by any spelling.
    const hostile = Buffer.concat([
        Buffer.from('red \x9b31mtext\x9b0m done\r\n', 'latin1'),
        Buffer.from('x\xc2\x9b31my\r\n', 'latin1'),
        Buffer.from('\x1b]0;title\x07after\r\n'),
        Buffer.from('a\x1bMb\r\n'),
        Buffer.from([0xff, 0xfe, 0x41, 0x0d, 0x0a]),
    ]);
    for (const l of await run(hostile)) assert.ok(!CONTROL.test(l), 'control byte in the log: ' + JSON.stringify(l));

    // 21. close() twice: both callers wait for the same final flush, and the
    // tail is written once. The engine closes a logger from the transport's
    // close event AND from session.close(); a second call that resolved
    // early would let the engine exit mid-flush.
    {
        const lines = [];
        const log = new ScreenLog({ rows: 3, idleMs: 0, onLine: (t) => lines.push(t) });
        log.write(Buffer.from('x\r\n'.repeat(2000) + 'tail'));
        const a = log.close();
        const b = log.close();
        assert.strictEqual(a, b, 'one completion for both callers');
        await b;
        assert.strictEqual(lines.length, 2001, 'everything, including the cursor row, once');
        assert.strictEqual(lines[2000], 'tail');
    }

    console.log('ok - screen log (real readline + apt fixtures vs an independent reading, chunk-split, ' +
        'trim tracking, 3J, clear, wrap join, alt-screen note, resize, close x2, hostile bytes)');
})().catch((e) => { console.error('FAIL -', e.stack || e.message); process.exit(1); });
