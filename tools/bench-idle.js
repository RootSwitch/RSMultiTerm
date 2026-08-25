'use strict';
// What do the idle animations actually cost?
//
// Two numbers, because they answer different questions:
//
//   DRAW is the time a style spends inside its own frame() - measured in
//   the renderer with performance.now() around the call, so it is the cost
//   of the animation itself and nothing else. It does not move when the
//   window is remote, when the GPU is busy, or when something else is
//   compositing, which makes it the number worth comparing between styles
//   and between machines.
//
//   CPU is the whole app's processor time over the same window, sampled
//   from the OS across every process in the tree. That one DOES include
//   compositing and, over RDP, the session's own encoding of the frames -
//   which is why a remote desktop makes an animation look far more
//   expensive than it is. The idle baseline is measured the same way so
//   the difference is the honest figure.
//
// Both are capped by FPS_CAP in idle.js: at 30fps a style has 33ms per
// frame before it starts dropping them, so DRAW as a percentage of 33ms is
// the headroom reading.
//
// Usage: node tools/bench-idle.js [seconds-per-style]

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SECONDS = Math.max(2, Number(process.argv[2]) || 4);
const ROOT = path.join(__dirname, '..');
const FPS_CAP = 30;
const FRAME_BUDGET_MS = 1000 / FPS_CAP;

// Sample every process in the app's tree. TotalProcessorTime is cumulative
// per process, so two samples give the CPU-seconds burned in between.
function cpuSeconds() {
    try {
        // Sum the seconds by hand: Measure-Object -Property takes a
        // property NAME, not a calculated one, in Windows PowerShell 5.1.
        const out = execFileSync('powershell', ['-NoProfile', '-Command',
            '(Get-Process electron,RSMultiTerm -ErrorAction SilentlyContinue | ' +
            'ForEach-Object { $_.TotalProcessorTime.TotalSeconds } | ' +
            'Measure-Object -Sum).Sum'],
        { encoding: 'utf8', timeout: 15000 });
        const n = Number(String(out).trim());
        return Number.isFinite(n) ? n : null;
    } catch (_) {
        return null;   // not Windows, or no permission: DRAW still works
    }
}

const probe = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const per = ${SECONDS * 1000};
    const out = { cores: navigator.hardwareConcurrency || null, rows: [] };
    await rsterm.invoke('rs:settings.update', { idle: { area: 'window', minutes: 240 } });
    await sleep(400);

    const measure = async (id, label) => {
        const before = window.Idle.frameCost();
        const t0 = performance.now();
        if (id) window.Idle.start(id);
        await sleep(per);
        const wall = performance.now() - t0;
        const after = window.Idle.frameCost();
        if (id) window.Idle.stop();
        await sleep(200);
        out.rows.push({
            id: label,
            frames: after.frames - before.frames,
            drawMs: after.ms - before.ms,
            wallMs: wall,
        });
    };

    // Baseline first: the same window, same everything, nothing animating.
    await measure(null, '(no animation)');
    for (const st of window.Idle.styles()) await measure(st.id, st.id);
    return out;
})()`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-bench-'));
const styleCount = 12;              // generous; the probe reports the truth
const budgetMs = (styleCount + 2) * (SECONDS * 1000 + 700) + 8000;

console.log(`benchmarking ${SECONDS}s per style (about ` +
    `${Math.ceil(budgetMs / 60000)} min), window ${'1544x848'}...`);

// Resolve the electron binary directly rather than going through npx:
// spawning a .cmd shim needs a shell on Windows, and spawning it without
// one is an EINVAL that says nothing about the cause.
const electronBin = (() => {
    try {
        return require(path.join(ROOT, 'node_modules', 'electron'));
    } catch (_) {
        return process.platform === 'win32'
            ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
            : path.join(ROOT, 'node_modules', '.bin', 'electron');
    }
})();

const child = spawn(electronBin, ['.'], {
        cwd: ROOT,
        env: {
            ...process.env,
            RSMT_SMOKE: '1',
            RSMT_DATA: dataDir,
            RSMT_SMOKE_MS: String(budgetMs),
            RSMT_SMOKE_PROBE: probe,
            RSMT_SMOKE_SHOT: path.join(dataDir, 'bench.png'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

let stdout = '';
child.stdout.on('data', (d) => { stdout += d.toString(); });
child.stderr.on('data', () => { /* electron chatter */ });

// CPU is sampled around the whole run rather than per style: per-style
// sampling would need the OS clock to line up with the renderer's phases,
// and the interesting comparison is animation-vs-idle anyway. Polled
// rather than read once at exit - by the time 'exit' fires the processes
// are gone and Get-Process finds nothing, which reads as zero CPU.
let cpuStart = null;
let cpuLast = null;
setTimeout(() => { cpuStart = cpuSeconds(); }, 3000);
const cpuPoll = setInterval(() => {
    const n = cpuSeconds();
    if (n) cpuLast = n;
}, 2000);

child.on('exit', () => {
    clearInterval(cpuPoll);
    const cpuEnd = cpuLast;
    fs.rmSync(dataDir, { recursive: true, force: true });

    const m = /smoke probe: (\{[\s\S]*?\})\s*$/m.exec(stdout);
    if (!m) {
        console.error('the probe produced no result - was the app able to start?');
        process.exit(1);
    }
    const res = JSON.parse(m[1]);
    const base = res.rows.find((r) => r.id === '(no animation)') || { drawMs: 0, frames: 0 };

    const pad = (s, n) => String(s).padEnd(n);
    const lpad = (s, n) => String(s).padStart(n);
    console.log('');
    console.log(`${pad('style', 16)}${lpad('fps', 6)}${lpad('draw ms/frame', 15)}` +
        `${lpad('% of 33ms budget', 19)}`);
    console.log('-'.repeat(56));
    const ranked = res.rows.filter((r) => r.id !== '(no animation)')
        .map((r) => ({
            ...r,
            fps: r.frames / (r.wallMs / 1000),
            per: r.frames ? r.drawMs / r.frames : 0,
        }))
        .sort((a, b) => b.per - a.per);
    for (const r of ranked) {
        console.log(`${pad(r.id, 16)}${lpad(r.fps.toFixed(1), 6)}` +
            `${lpad(r.per.toFixed(2), 15)}${lpad((r.per / FRAME_BUDGET_MS * 100).toFixed(1) + '%', 19)}`);
    }
    console.log('-'.repeat(56));
    console.log(`${pad('(no animation)', 16)}${lpad('-', 6)}${lpad(base.drawMs.toFixed(2), 15)}` +
        `${lpad('-', 19)}`);

    if (cpuStart !== null && cpuEnd !== null && cpuEnd >= cpuStart) {
        const secs = cpuEnd - cpuStart;
        const wall = ranked.reduce((n, r) => n + r.wallMs, 0) / 1000;
        console.log('');
        console.log(`whole-app CPU across the animated portion: ${secs.toFixed(1)}s of ` +
            `processor time over ~${wall.toFixed(0)}s wall ` +
            `(${(secs / wall * 100).toFixed(0)}% of one core, ${res.cores || '?'} cores present).`);
        console.log('That figure INCLUDES compositing and, on a remote desktop, the ' +
            'session encoding every frame - the draw column above does not.');
    }
});
