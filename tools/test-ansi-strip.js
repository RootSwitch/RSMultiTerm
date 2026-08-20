'use strict';
// ANSI stripper tests. Same discipline as the negotiator tests: every case
// runs whole-buffer AND split at every byte boundary, and both must produce
// identical output - the chunk-split escape sequence is the exact bug a
// per-chunk regex has.

const assert = require('assert');
const { AnsiStripper } = require('../engine/ansi-strip');

function strip(input, splitAt) {
    const buf = Buffer.from(input, 'latin1');
    const s = new AnsiStripper();
    if (splitAt === undefined) return s.feed(buf);
    let out = '';
    for (let i = 0; i < buf.length; i++) out += s.feed(buf.subarray(i, i + 1));
    return out;
}

function caseBoth(input, expected, label) {
    assert.strictEqual(strip(input), expected, `${label} (whole)`);
    assert.strictEqual(strip(input, 1), expected, `${label} (byte-split)`);
}

caseBoth('plain text\r\nline two\r\n', 'plain text\nline two\n', 'plain + CRLF');
caseBoth('\x1b[32mup\x1b[0m and \x1b[31mdown\x1b[0m', 'up and down', 'SGR colors');
caseBoth('\x1b[2J\x1b[H\x1b[?25lcleared', 'cleared', 'clear screen + private modes');
caseBoth('\x1b]0;window title\x07after', 'after', 'OSC title BEL-terminated');
caseBoth('\x1b]0;title\x1b\\after', 'after', 'OSC title ST-terminated');
caseBoth('a\x1bMb', 'ab', 'two-byte ESC sequence');
caseBoth('tab\there', 'tab\there', 'tab preserved');
caseBoth('bell\x07 gone', 'bell gone', 'BEL dropped in text');
caseBoth('\x1bP+q544e\x1b\\dcs gone', 'dcs gone', 'DCS string swallowed');
caseBoth('multi\x1b[38;5;196;48;5;16mparam\x1b[m', 'multiparam', 'long SGR params');

// The killer case: a CSI split exactly at the chunk boundary.
{
    const s = new AnsiStripper();
    let out = s.feed(Buffer.from('status \x1b[3', 'latin1'));
    out += s.feed(Buffer.from('2mup\x1b[0m ok', 'latin1'));
    assert.strictEqual(out, 'status up ok', 'escape split across chunks');
}

// C1 controls are 8-bit escapes: 0x9b is CSI and 0x9d is OSC to a UTF-8
// terminal, so a "stripped" log that carries them executes sequences when
// cat'd. They must strip like their ESC-prefixed twins; the rest of
// 0x7f-0x9f drops like any other control.
caseBoth('red \x9b31mtext\x9b0m done', 'red text done', 'C1 CSI (0x9b) swallowed');
caseBoth('t\x9d0;evil title\x07after', 'tafter', 'C1 OSC (0x9d) swallowed to BEL');
caseBoth('dcs\x90payload\x1b\\x', 'dcsx', 'C1 DCS (0x90) swallowed to ST');
caseBoth('del\x7fete', 'delete', 'DEL dropped');
caseBoth('a\x85b\x8dc', 'abc', 'other C1 controls dropped');

// ESC + intermediates run "ESC, intermediates, final" - charset designations
// (vim emits ESC ( B constantly) and DECALN must not leak their final byte.
caseBoth('vim\x1b(Btext', 'vimtext', 'charset designation ESC ( B swallowed whole');
caseBoth('x\x1b)0y', 'xy', 'ESC ) 0 swallowed whole');
caseBoth('a\x1b#8b', 'ab', 'DECALN ESC # 8 swallowed whole');

// UTF-8: multi-byte text must survive stripping intact - including split
// at every byte boundary (caseBoth), which is where a continuation byte
// used to be misread as an 8-bit C1 control.
caseBoth('caf\xc3\xa9 latte', 'café latte', 'UTF-8 two-byte decoded');
caseBoth('\xe2\x94\x8c\xe2\x94\x80\xe2\x94\x90 box', '┌─┐ box', 'UTF-8 three-byte box drawing');
caseBoth('ok \xf0\x9f\x8e\x89 party', 'ok \u{1f389} party', 'UTF-8 four-byte emoji');
caseBoth('ref \xe2\x80\xbb note', 'ref ※ note', 'continuation byte 0xbb not eaten as C1');
caseBoth('mix \x1b[31m\xe2\x9c\x93\x1b[0m done', 'mix ✓ done', 'UTF-8 inside SGR colors');

// A UTF-8-ENCODED C1 control (c2 9b = U+009B) is still a CSI and must
// strip like the raw 8-bit one - the decode must not become a bypass.
caseBoth('red \xc2\x9b31mtext\xc2\x9b0m done', 'red text done', 'UTF-8-encoded C1 CSI swallowed');
caseBoth('x\xc2\x85y', 'xy', 'UTF-8-encoded C1 NEL dropped');

// Bytes that LOOK like a UTF-8 lead but are not followed by continuations
// (a Latin-1 device): dropped, and the next byte processes normally.
caseBoth('a\xe9x done', 'ax done', 'invalid UTF-8 lead dropped, following text kept');

console.log('ok - ansi stripper (27 cases incl. C1, ESC-intermediate and UTF-8, whole and byte-split)');
