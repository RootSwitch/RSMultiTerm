'use strict';
// A broken stdout must not crash the process.
//
// This is the bug that put an Electron "A JavaScript error occurred in the
// main process" dialog on screen: a run whose stdout was piped into a
// command that stopped reading after a few lines. The next console.log
// raised EPIPE, nothing was listening for it, and a dropped log line became
// a crash report.
//
// Reproduced honestly: a child process writes to a pipe that the parent
// closes underneath it, and must survive and exit 0.

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const CHILD = `
const safeLog = require(${JSON.stringify(path.join(__dirname, '..', 'main', 'safe-log.js').replace(/\\/g, '/'))});
if (process.env.GUARD === '1') safeLog.install();
// Keep writing well past the point the reader has gone away.
const write = process.env.GUARD === '1' ? safeLog.log : console.log;
let i = 0;
const timer = setInterval(() => {
    write('line ' + (i++) + ' ' + 'x'.repeat(4096));
    if (i > 200) { clearInterval(timer); process.exit(0); }
}, 1);
`;

// The reader closes its end almost immediately; everything after that write
// is into a broken pipe.
function run(guard) {
    const script = `
const { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(CHILD)}], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, GUARD: ${JSON.stringify(guard)} },
});
child.stdout.once('data', () => child.stdout.destroy());   // stop reading
child.on('exit', (code, signal) => {
    process.stdout.write(JSON.stringify({ code, signal }));
});
`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
    try {
        return JSON.parse((r.stdout || '').trim());
    } catch (_) {
        return { code: null, signal: null, raw: r.stdout, err: r.stderr };
    }
}

// Both halves are asserted, so this test cannot quietly stop measuring
// anything: WITHOUT the guard the child must die on the broken pipe (that
// is the bug), and WITH it the child must survive.
const bare = run('0');
assert.notStrictEqual(bare.code, 0,
    'this test is only meaningful if an unguarded write to a dead pipe still ' +
    `kills the process - if Node changed, rewrite the test rather than delete it. Got ${JSON.stringify(bare)}`);

const guarded = run('1');
assert.strictEqual(guarded.code, 0,
    `a broken stdout must not stop the process; got ${JSON.stringify(guarded)}`);

// Sanity: safeLog.log itself never throws, whatever the stream is doing.
const safeLog = require('../main/safe-log');
safeLog.install();
assert.doesNotThrow(() => safeLog.log('still fine'));
assert.doesNotThrow(() => safeLog.error('still fine'));
// install() twice must not stack listeners on every call.
const before = process.stdout.listenerCount('error');
safeLog.install();
safeLog.install();
assert.strictEqual(process.stdout.listenerCount('error'), before,
    'install() must be idempotent, not add a listener per call');

console.log('ok - safe log (a closed stdout pipe cannot crash the process)');
