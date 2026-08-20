'use strict';
// Paste payload construction. The regression pinned here: unbracketed
// multiline paste leaves unread lines in the kernel tty queue, and sudo
// flushes that queue on purpose - so "sudo x / then y / then z" ran x and
// silently discarded y and z. With the remote's bracketed-paste mode
// honored, the block travels wrapped and readline keeps it out of reach.

const assert = require('assert');
const paste = require('../public/paste.js');

const BP_ON = { modes: { bracketedPasteMode: true } };
const BP_OFF = { modes: { bracketedPasteMode: false } };

// 1. Newline normalization: CRLF, LF and CR all become \r.
assert.strictEqual(paste.body('a\r\nb\nc\rd'), 'a\rb\rc\rd');
assert.strictEqual(paste.body('a\n'), 'a\r', 'a trailing newline survives as a trailing CR');
assert.strictEqual(paste.body('a'), 'a', 'no newline, no CR invented');

// 2. Mode off: exactly the bytes the app always sent - network gear that
// never heard of DECSET 2004 must see no change at all.
assert.strictEqual(paste.forTerm(BP_OFF, 'cmd1\ncmd2'), 'cmd1\rcmd2');
assert.strictEqual(paste.forTerm(null, 'cmd1\ncmd2'), 'cmd1\rcmd2', 'no term = legacy bytes');
assert.strictEqual(paste.forTerm({}, 'x'), 'x', 'term without modes = legacy bytes');

// 3. Mode on: wrapped, so the whole block lands in readline's buffer where
// a TCSAFLUSH cannot discard it and nothing executes until Enter.
assert.strictEqual(
    paste.forTerm(BP_ON, 'sudo systemctl stop x\nsudo tar -xzf y\nsudo z --tls'),
    '\x1b[200~sudo systemctl stop x\rsudo tar -xzf y\rsudo z --tls\x1b[201~');

// 4. Paste injection: content carrying the end-bracket must not be able to
// close the paste early and run the remainder as keystrokes.
const evil = paste.forTerm(BP_ON, 'benign\x1b[201~\rrm -rf /\n');
assert.strictEqual(evil.indexOf('\x1b[201~'), evil.length - '\x1b[201~'.length,
    'the only end-bracket is the final one');
assert.ok(evil.includes('rm -rf /'), 'the content itself is preserved (inert inside the bracket)');

// 5. Snippet sends execute: same payload plus one accept-line OUTSIDE the
// bracket. Inside it would be content; outside it is Enter.
assert.strictEqual(paste.execForTerm(BP_ON, 'wr mem'), '\x1b[200~wr mem\x1b[201~\r');
assert.strictEqual(paste.execForTerm(BP_OFF, 'wr mem'), 'wr mem\r');

console.log('ok - paste payloads (normalization, bracketed wrap, injection guard, exec)');
