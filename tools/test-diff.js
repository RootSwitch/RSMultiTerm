'use strict';
// Diff engine tests: the algorithm, the normalization options, and the
// prompt heuristic that pre-fills the panes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'diff-engine.js'), 'utf8'), sandbox);
const D = sandbox.window.DiffEngine;

const types = (r) => r.rows.map((x) => x.type).join(',');

// 1. Identical input is entirely 'same'.
{
    const text = 'line one\nline two\nline three';
    const r = D.diff(text, text);
    assert.strictEqual(types(r), 'same,same,same');
    assert.strictEqual(r.stats.change, 0);
}

// 2. A changed line pairs into one 'change' row, not a delete plus an add,
// so the side-by-side view lines up.
{
    const r = D.diff('a\nb\nc', 'a\nB\nc');
    assert.strictEqual(types(r), 'same,change,same');
    assert.strictEqual(r.rows[1].left, 'b');
    assert.strictEqual(r.rows[1].right, 'B');
}

// 3. Pure insertion and pure deletion.
{
    assert.strictEqual(types(D.diff('a\nc', 'a\nb\nc')), 'same,add,same');
    assert.strictEqual(types(D.diff('a\nb\nc', 'a\nc')), 'same,del,same');
}

// 4. A realistic case: one interface changed state, one added.
{
    const before = [
        'Gi1/0/1   uplink-core        connected    trunk',
        'Gi1/0/2   ap-floor2          connected    120',
        'Gi1/0/3                      notconnect   1',
    ].join('\n');
    const after = [
        'Gi1/0/1   uplink-core        connected    trunk',
        'Gi1/0/2   ap-floor2          err-disabled 120',
        'Gi1/0/3                      notconnect   1',
        'Gi1/0/4   new-ap             connected    120',
    ].join('\n');
    const r = D.diff(before, after);
    assert.strictEqual(types(r), 'same,change,same,add');
    assert.ok(r.rows[1].right.includes('err-disabled'));
}

// 5. Trailing whitespace is ignored by default (devices pad columns
// inconsistently), and can be turned off.
{
    assert.strictEqual(types(D.diff('a   \nb', 'a\nb')), 'same,same');
    assert.strictEqual(types(D.diff('a   \nb', 'a\nb', { ignoreTrailingWhitespace: false })),
        'change,same');
}

// 6. Strip patterns kill volatile fields - the uptime counter that differs
// on every capture and hides the real change.
{
    const a = 'core-sw-01 uptime is 41 weeks, 3 days\nversion 17.9.4';
    const b = 'core-sw-01 uptime is 42 weeks, 1 day\nversion 17.9.4';
    assert.strictEqual(types(D.diff(a, b)), 'change,same');
    const stripped = D.diff(a, b, { stripPatterns: ['uptime is .*$'] });
    assert.strictEqual(types(stripped), 'same,same', 'volatile line neutralised');
}

// 7. A malformed strip pattern must not throw - it is user input.
{
    assert.doesNotThrow(() => D.diff('a', 'b', { stripPatterns: ['[unclosed'] }));
}

// 8. Whitespace-insensitive comparison for reflowed output.
{
    assert.strictEqual(types(D.diff('a    b', 'a b', { ignoreAllWhitespace: true })), 'same');
    assert.strictEqual(types(D.diff('a    b', 'a b')), 'change');
}

// 9. Empty sides behave.
{
    assert.strictEqual(types(D.diff('', '')), '');
    assert.strictEqual(types(D.diff('', 'a\nb')), 'add,add');
    assert.strictEqual(types(D.diff('a\nb', '')), 'del,del');
}

// 10. Large inputs still return, via the anchored fallback, and still find
// the change. 3000 lines each is past the LCS cell cap.
{
    const big = Array.from({ length: 3000 }, (_, i) => `interface Gi1/0/${i}`);
    const other = big.slice();
    other[1500] = 'interface Gi1/0/1500 CHANGED';
    const started = Date.now();
    const r = D.diff(big.join('\n'), other.join('\n'));
    const ms = Date.now() - started;
    assert.ok(ms < 5000, `large diff took ${ms}ms`);
    assert.strictEqual(r.stats.same, 2999, 'anchored diff keeps the unchanged bulk');
    assert.ok(r.stats.change + r.stats.add + r.stats.del > 0, 'and still reports the difference');
}

// --- prompt capture ---------------------------------------------------------

// 11. The text between the last two prompts is the last command's output.
{
    const lines = [
        'core-sw-01#show version',
        'RSNet IOS Software, Version 17.9.4a',
        'core-sw-01#show int status',
        'Port      Name               Status',
        'Gi1/0/1   uplink-core        connected',
        'core-sw-01#',
    ];
    const out = D.lastCommandOutput(lines);
    assert.ok(out.confident);
    assert.ok(out.text.startsWith('core-sw-01#show int status'), 'starts at the command');
    assert.ok(out.text.includes('Gi1/0/1'), 'includes the output');
    assert.ok(!out.text.includes('RSNet IOS'), 'excludes the previous command');
}

// 12. Different prompt styles: JunOS >, bash $, root #.
{
    for (const p of ['user@router> ', 'alice@host:~$ ', 'root@box:/# ']) {
        const lines = [`${p}`.trim() + 'first', 'output one', `${p}`.trim() + 'second', 'output two', `${p}`.trim()];
        const out = D.lastCommandOutput(lines);
        assert.ok(out.confident, `prompt style ${p} not recognised`);
        assert.ok(out.text.includes('output two'), `prompt style ${p} captured the wrong block`);
    }
}

// 12b. Output lines must not be mistaken for prompts, or the capture starts
// in the middle of the previous command's output.
{
    for (const line of [
        '% Invalid input detected at \'^\' marker.',
        'Port      Name               Status       Vlan',
        'Gi1/0/1   uplink-core        connected    trunk',
        'cisco C9300-48P (X86) processor with 1300K bytes of memory.',
        'Base Ethernet MAC Address : 00:00:5e:00:53:01',
        '  Internet address is 192.0.2.10/24',
    ]) {
        assert.ok(!D.PROMPT.test(line), `output line read as a prompt: ${line}`);
    }
    for (const line of ['core-sw-01#', 'core-sw-01#show run', 'user@router> show', 'alice@host:~$ ls -l']) {
        assert.ok(D.PROMPT.test(line), `prompt not recognised: ${line}`);
    }
}

// 13. Without two prompts the capture is not confident and hands back
// everything, so the UI can say "trim this" rather than silently guessing.
{
    const out = D.lastCommandOutput(['just some output', 'with no prompt']);
    assert.strictEqual(out.confident, false);
    assert.ok(out.text.includes('just some output'));
}

console.log('ok - diff engine (13 scenarios: pairing, normalization, scale, prompt capture)');
