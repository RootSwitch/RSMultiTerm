'use strict';
// Shell-integration snippets. These run in someone's login shell on a real
// machine, so they get more than a shape check: where a bash is available
// (Git Bash on Windows, any Linux), the bash snippet is SOURCED IN A REAL
// INTERACTIVE SHELL and the emitted OSC 133 marks are asserted in order,
// including the exit status of a failing command - the thing that drives
// the red failed-command marker in the UI.
//
// Regression pinned here: an earlier draft emitted D only once, because
// with PS0 marking C nothing runs between the command and the next prompt
// that could set a "a command ran" flag. Exit codes silently vanished
// after the first command.

const assert = require('assert');
const { spawnSync } = require('child_process');

const snips = require('../main/shell-snippets');

// --- structure, for every shell ---------------------------------------------
for (const shell of snips.shells()) {
    const body = snips.sessionScript(shell);
    for (const mark of ['133;A', '133;B', '133;C', '133;D']) {
        assert.ok(body.includes(mark), `${shell}: missing the ${mark} mark`);
    }
    assert.ok(/RSMT_SHELL_INTEGRATION/.test(body),
        `${shell}: needs the already-installed guard, or sourcing twice doubles the marks`);

    const install = snips.installScript(shell);
    assert.ok(install.includes("<<'RSMT_EOF'"),
        `${shell}: the heredoc terminator must be QUOTED - the snippet is full of ` +
        '$ and backslashes that must land on disk unexpanded');
    assert.ok(install.includes(snips.MARKER),
        `${shell}: the rc line needs the marker grep uses to stay idempotent`);
    assert.ok(/grep -qs/.test(install),
        `${shell}: the rc guard must not complain when the rc file does not exist yet`);

    const uninstall = snips.uninstallScript(shell);
    assert.ok(uninstall.includes(snips.FILE_NAME), `${shell}: uninstall must remove the file`);
    assert.ok(uninstall.includes(snips.MARKER), `${shell}: uninstall must remove the rc line`);
}

// The install script must carry the snippet verbatim: a mangled heredoc
// body is the one failure that would write broken shell into a login file.
{
    const body = snips.sessionScript('bash');
    assert.ok(snips.installScript('bash').includes(body),
        'the install script must embed the snippet byte for byte');
}

// --- behavior, in a real bash ----------------------------------------------
function bashRun() {
    // The snippet is fed inline rather than sourced from a file: whichever
    // bash is on PATH may not share this process's filesystem view (WSL
    // sees /mnt/c, Git Bash sees C:/), and the snippet's behavior is what
    // is under test, not path translation.
    const input = [
        'PS1="rsmt$ "',
        snips.sessionScript('bash'),
        'true',
        'false',
        'exit 0',
        '',
    ].join('\n');
    // An interactive shell, because PS1/PS0 only render in one. The marks
    // arrive on BOTH streams - A and D from printf on stdout, B and C from
    // PS1/PS0 on stderr - so the redirect happens inside the shell, which
    // merges them in true chronological order. Concatenating the two
    // captured streams afterwards would scramble the sequence under test.
    const r = spawnSync('bash', ['-c', 'bash -i 2>&1'], {
        input, encoding: 'latin1', timeout: 20000,
    });
    if (r.error) return null;           // no bash on this machine
    return r.stdout || '';
}

const out = bashRun();
if (out === null) {
    console.log('ok - shell snippets (structure only; no bash on PATH to run the bash snippet against)');
} else {
    const marks = (out.match(/\x1b]133;[^\x07]*/g) || []).map((m) => m.slice(6));
    assert.ok(marks.length, `no OSC 133 marks came out of bash at all; raw: ${JSON.stringify(out.slice(0, 400))}`);

    // Two commands were submitted (true, false), so two full cycles must
    // appear, and the failing one must carry its status.
    const cycle = marks.join(' ');
    assert.ok(/A B C D;0/.test(cycle), `expected a clean command cycle, got: ${cycle}`);
    assert.ok(/A B C D;1/.test(cycle),
        `a failing command must report its exit status - this is what paints the ` +
        `red failed-command marker. Got: ${cycle}`);
    assert.strictEqual(marks.filter((m) => m.startsWith('D;')).length, 2,
        `every finished command reports exactly one D; got: ${cycle}`);
    assert.ok(marks.indexOf('A') < marks.indexOf('B'), 'A must precede B');

    console.log(`ok - shell snippets (3 shells structural; bash executed live: ${cycle})`);
}
