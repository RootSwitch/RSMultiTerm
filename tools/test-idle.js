'use strict';
// The idle loop and the Aliens lasers, run for real: public/idle.js loads
// into a VM with just enough of a browser stubbed in, and a fake display
// clock drives requestAnimationFrame. Two things are pinned, both measured
// in the app before they were fixed:
//
//   1. FRAME PACING. FPS_CAP is 30, and the gate used to skip any display
//      tick that arrived even slightly early. On an RDP session's 32Hz
//      adapter that was every other tick, so every style drew at 16fps; on
//      a 60Hz monitor it flickered between 20 and 30 with vsync jitter. The
//      loop must now draw at close to the cap on every common refresh rate.
//
//   2. LASERS CANNOT STEP OVER WORDS. A laser used to be tested only where
//      it landed each frame. With a fixed spawn height and a fixed step,
//      every laser landed on the same heights, and a word sitting between
//      two of them was untouchable - 446 pass-throughs against 27 kills in
//      a 45-second run. Now the whole stretch is tested, and the word
//      struck is the lowest one in the way.
//
// Usage: node tools/test-idle.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
const W = 1200, H = 800;

let failures = 0;
function check(name, ok, detail) {
    if (ok) console.log('  ok   ' + name);
    else { failures++; console.log('  FAIL ' + name + (detail ? ' - ' + detail : '')); }
}

// A small deterministic PRNG so the vsync jitter is the same every run.
function seeded(seed) {
    let x = seed >>> 0;
    return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
}

function load() {
    let rafCb = null;
    let drawn = 0;
    const noop = () => {};
    // Every canvas call is a no-op except the full-window background fill,
    // which every frame Aliens draws starts with - so it counts frames.
    const ctx = new Proxy({}, {
        get(t, k) {
            if (k === 'measureText') return () => ({ width: 7 });
            if (k === 'fillRect') return (x, y, w, h) => { if (x === 0 && y === 0 && w === W && h === H) drawn++; };
            if (k in t) return t[k];
            return noop;
        },
        set(t, k, v) { t[k] = v; return true; },
    });
    const el = () => ({
        classList: { add: noop, remove: noop }, remove: noop, getContext: () => ctx,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    });
    const sb = {
        document: {
            hidden: false, documentElement: {}, body: { appendChild: noop },
            createElement: el, getElementById: () => null, querySelector: () => null,
            addEventListener: noop, removeEventListener: noop,
        },
        innerWidth: W, innerHeight: H,
        matchMedia: () => ({ matches: false }),
        addEventListener: noop, removeEventListener: noop,
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        // Settings arrive before anything starts in the app; a thenable
        // that answers at once gives the same order here.
        rsterm: { invoke: () => ({ then: (f) => f({}) }), on: noop },
        requestAnimationFrame: (cb) => { rafCb = cb; return 1; },
        cancelAnimationFrame: () => { rafCb = null; },
        setInterval: () => 0, clearInterval: noop, setTimeout: () => 0, clearTimeout: noop,
        performance,
    };
    sb.window = sb;
    vm.createContext(sb);
    vm.runInContext(SRC, sb, { filename: 'idle.js' });
    const Idle = sb.Idle;
    Idle.start('aliens', { area: 'window' });
    return { Idle, tick: (now) => { if (rafCb) rafCb(now); }, drawn: () => drawn };
}

// --- 1. frame pacing ------------------------------------------------------
function drawnFps(hz, seconds) {
    const t = load();
    const rnd = seeded(hz * 7919);
    const period = 1000 / hz;
    let now = 5000;
    t.tick(now);
    const before = t.drawn();
    const n = Math.round(seconds * hz);
    for (let i = 0; i < n; i++) {
        now += period + (rnd() - 0.5) * 0.5;   // +-0.25ms of vsync jitter
        t.tick(now);
    }
    return (t.drawn() - before) / seconds;
}

console.log('frame pacing (FPS_CAP 30)');
const rdp = drawnFps(32, 10);
check('a 32Hz display (RDP) draws every tick, not every other one', rdp >= 30,
    rdp.toFixed(1) + 'fps');
const sixty = drawnFps(60, 10);
check('a 60Hz display draws a steady 30fps', sixty >= 29 && sixty <= 31,
    sixty.toFixed(1) + 'fps');
for (const hz of [50, 75, 90, 120, 144, 165, 240]) {
    const fps = drawnFps(hz, 10);
    check(hz + 'Hz draws close to the cap (24-40fps)', fps >= 24 && fps <= 40, fps.toFixed(1) + 'fps');
}

// --- 2. lasers ------------------------------------------------------------
// A world with only the given words, no dives, no fire from the ship, and
// a march at its slowest (no word lost yet), so nothing slides out from
// under a laser or reaches an edge and drops.
function world(words) {
    const t = load();
    let now = 5000;
    t.tick(now);
    const s = t.Idle.debugState();
    s.aliens = words.map(([text, x, y]) => ({
        text, w: 70, h: 15, homeX: x, homeY: y, x, y, tone: 0,
        state: 'formation', arrive: { t: 1 }, dive: null,
    }));
    s.total = s.aliens.length; s.ox = 0; s.oy = 0; s.dir = 1; s.minX = 400; s.maxX = 500;
    s.diveClock = 1e9; s.bombs = []; s.lasers = []; s.bursts = [];
    s.ship.cool = 1e9; s.ship.dead = 0;
    // Held here, not read back from s.aliens: once the last word dies the
    // next frame starts a new wave and replaces the list.
    return {
        s, words: s.aliens.slice(),
        fire: (x, y) => s.lasers.push({ x, y, vy: -540 }),
        // Advance by `ms` in display ticks of `period`.
        run: (ms, period) => { for (let e = 0; e < ms; e += period) { now += period; t.tick(now); } },
    };
}

console.log('aliens lasers');
// The measured failure, at every height: a word at each offset against the
// laser's landing heights must be hit by a laser fired from below it. At a
// 32Hz tick a laser moves 17px a frame against a 15px word, so a landing-
// point test misses some offsets; at 16fps it missed more than half.
for (const period of [1000 / 32, 1000 / 16]) {
    const missed = [];
    for (let off = 0; off < 40; off++) {
        const w = world([['word', 420, 200 + off]]);
        w.fire(455, 500);
        w.run(1200, period);
        if (w.words[0].state !== 'dead') missed.push(off);
    }
    check(`no word height is untouchable at ${Math.round(1000 / period)}fps`, missed.length === 0,
        `missed at offsets ${missed.join(',')}`);
}

// A step long enough to cross two stacked words in one frame strikes the
// LOWER one - the first in the laser's way - even when the upper one comes
// first in the list.
{
    const w = world([['upper', 420, 80], ['lower', 420, 100]]);
    w.fire(455, 130);
    w.run(100, 100);    // dt is capped at 0.1s: 54px, from 130 up to 76
    const [upper, lower] = w.words;
    check('a laser crossing two words strikes the lower one', lower.state === 'dead' && upper.state !== 'dead',
        `upper ${upper.state}, lower ${lower.state}`);
    check('and is spent on it', w.s.lasers.length === 0, `${w.s.lasers.length} lasers left`);
}

// The stretch test must not widen a laser sideways.
{
    const w = world([['word', 420, 200]]);
    w.fire(400, 400);   // 20px left of the word
    w.run(1200, 1000 / 32);
    check('a laser beside a word passes it', w.words[0].state !== 'dead', w.words[0].state);
}

if (failures) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log('\nall idle checks passed');
