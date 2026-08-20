'use strict';
// House style rule: no em/en dashes or curly quotes in tracked files (use
// " - " and straight quotes). Scans everything git tracks; exits non-zero
// listing offenders. Run: node tools/charcheck.js
//
// The banned set is built from code points so this file contains none of the
// characters it bans, and the binary guard is a constructed NUL rather than a
// literal one. The first version had both as literals: the embedded NUL made
// this the one tracked file matching its own binary guard, so the checker
// skipped itself - silently - and its seven offending lines never counted.
// Skipped files are now logged for the same reason: that silence is what hid it.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BANNED = [
    [0x2014, 'em dash'], [0x2013, 'en dash'],
    [0x201C, 'curly quote'], [0x201D, 'curly quote'],
    [0x2018, 'curly quote'], [0x2019, 'curly quote']
];
const NAMES = new Map(BANNED.map(([cp, name]) => [String.fromCodePoint(cp), name]));
const BAD = new RegExp('[' + BANNED.map(([cp]) => String.fromCodePoint(cp)).join('') + ']');
const NUL = String.fromCharCode(0);

let files;
try {
    files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch (_) {
    console.error('charcheck: not a git checkout - nothing to scan');
    process.exit(0);
}

let bad = 0;
const skipped = [];
for (const rel of files) {
    // Vendored third-party files are not house prose; their upstream style
    // must not be able to fail our test chain.
    if (rel.startsWith('public/vendor/')) continue;
    const file = path.join(ROOT, rel);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    if (text.includes(NUL)) { skipped.push(rel); continue; } // binary
    const lines = text.split('\n');
    for (let n = 0; n < lines.length; n++) {
        const m = BAD.exec(lines[n]);
        if (m) {
            console.error(`${rel}:${n + 1}: ${NAMES.get(m[0])} (U+${m[0].codePointAt(0).toString(16).toUpperCase()})`);
            bad++;
        }
    }
}

if (skipped.length) console.log(`charcheck: skipped as binary: ${skipped.join(', ')}`);
if (bad > 0) {
    console.error(`charcheck: ${bad} offending line${bad === 1 ? '' : 's'} - use " - " and straight quotes`);
    process.exit(1);
}
console.log(`ok - charcheck clean (${files.length - skipped.length} of ${files.length} tracked files)`);
