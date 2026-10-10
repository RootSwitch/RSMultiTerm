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
//   3. SNAKE HEARS EVERY TAP. Snake read the arrow keys HELD at the moment
//      it moved a step, so a tap that began and ended between two steps
//      was lost: a 60ms tap steered 48-67% of the time depending on frame
//      rate. Presses are now queued as they happen and spent one per step.
//
//   4. SNAKE KEEPS ITS PACE. A step reset the clock to zero and threw the
//      leftover time away, so steps could only land on whole frames and the
//      speed depended on the display: 8 squares a second at 16fps, 10.6 at
//      32fps. It is now ten a second everywhere.
//
//   5. PIPES AND BLOCKS KEEP THEIR PACE, by the same rule (stepsDue): Pipes'
//      segments, Blocks' self-player, soft drop and held-key repeat, and
//      Blocks' game-over pause, which was counted in frames.
//
//   7. THE FRAME RATE FOLLOWS THE SETTING. Automatic is 15fps where Chromium
//      reports software rendering (no GPU: the processor paints every frame)
//      and 30 elsewhere; low and full override it either way; a game being
//      played keeps full speed.
//
//   6. THE PALETTE READS ON WHAT IT IS DRAWN ON. A light theme "kept
//      dark" (or under "Always dark") handed the animations its own dark
//      colors on a near-black night: Mono's text at 1.3:1, so Aliens' ship,
//      lasers and divers all but vanished. The styles that paint their own
//      night (`ground: true`) had the same problem on every light theme.
//      Every built-in theme in every terminal mode is checked, for a style
//      over the terminal and a style on its night.
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

// env.settings is what rs:settings.get returns, env.rendering what
// rs:app.rendering does.
function load(style = 'aliens', opts = { area: 'window' }, env = {}) {
    let rafCb = null;
    let drawn = 0;
    const handlers = {};
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
            addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
            removeEventListener: noop,
        },
        innerWidth: W, innerHeight: H,
        matchMedia: () => ({ matches: false }),
        addEventListener: noop, removeEventListener: noop,
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        // Settings arrive before anything starts in the app; a thenable
        // that answers at once gives the same order here.
        rsterm: {
            invoke: (ch) => {
                const v = ch === 'rs:settings.get' ? (env.settings || {})
                    : ch === 'rs:app.rendering' ? (env.rendering || {}) : {};
                return { then: (f) => f(v) };
            },
            on: noop,
        },
        requestAnimationFrame: (cb) => { rafCb = cb; return 1; },
        cancelAnimationFrame: () => { rafCb = null; },
        setInterval: () => 0, clearInterval: noop, setTimeout: () => 0, clearTimeout: noop,
        performance,
    };
    sb.window = sb;
    vm.createContext(sb);
    vm.runInContext(SRC, sb, { filename: 'idle.js' });
    const Idle = sb.Idle;
    Idle.start(style, opts);
    // A key event through the overlay's own capture-phase handler.
    const key = (type, code) => {
        const e = { type, code, key: code, preventDefault: noop, stopImmediatePropagation: noop };
        for (const fn of handlers[type] || []) fn(e);
    };
    return { Idle, tick: (now) => { if (rafCb) rafCb(now); }, drawn: () => drawn, key };
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

// frameCost() is what tools/bench-idle.js divides by, so it must count the
// frames DRAWN. It used to count display ticks: at 60Hz the gate skips every
// other one, which doubled the bench's fps and halved its cost per frame.
for (const hz of [60, 144]) {
    const t = load();
    let now = 5000;
    t.tick(now);
    const before = t.Idle.frameCost().frames;
    const drawnBefore = t.drawn();
    for (let i = 0; i < hz * 10; i++) { now += 1000 / hz; t.tick(now); }
    const counted = t.Idle.frameCost().frames - before;
    const drawn = t.drawn() - drawnBefore;
    check(`frameCost counts frames drawn, not display ticks (${hz}Hz)`, counted === drawn,
        `${counted} counted, ${drawn} drawn`);
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

// --- 3. snake controls ---------------------------------------------------
// Snake in play mode, heading right, with key events arriving BETWEEN frames
// at the given times. Returns the headings it took, in order, as letters.
function steer(hz, keys, setup) {
    const t = load('snake', { play: true, area: 'window' });
    const period = 1000 / hz;
    let now = 5000;
    t.tick(now);
    const s = t.Idle.debugState();
    s.dir = { x: 1, y: 0 };
    if (setup) setup(s);
    const events = keys.map(([at, type, code]) => ({ at: now + at, type, code }))
        .sort((a, b) => a.at - b.at);
    const seen = [];
    const end = now + 1500;
    while (now < end) {
        now += period;
        while (events.length && events[0].at <= now) { const e = events.shift(); t.key(e.type, e.code); }
        t.tick(now);
        const d = t.Idle.debugState().dir;
        const h = d.x === 1 ? 'R' : d.x === -1 ? 'L' : d.y === -1 ? 'U' : 'D';
        if (seen[seen.length - 1] !== h) seen.push(h);
    }
    return seen.join('');
}
const tap = (at, code, len) => [[at, 'keydown', code], [at + len, 'keyup', code]];

console.log('snake controls');
{
    // A 40ms tap at many phases against the step: every one must steer.
    const rnd = seeded(4242);
    for (const hz of [16, 30, 32]) {
        let missed = 0;
        for (let i = 0; i < 60; i++) {
            if (!steer(hz, tap(200 + rnd() * 300, 'ArrowUp', 40)).includes('U')) missed++;
        }
        check(`every short tap steers at ${hz}fps`, missed === 0, `${missed} of 60 taps lost`);
    }
}
{
    // Up then left, both inside one step: both turns land, in order.
    const rnd = seeded(77);
    let failed = 0;
    for (let i = 0; i < 40; i++) {
        const at = 200 + rnd() * 300;
        const h = steer(30, [...tap(at, 'ArrowUp', 30), ...tap(at + 40, 'ArrowLeft', 30)]);
        if (!h.includes('RUL')) failed++;
    }
    check('a quick double turn lands both turns', failed === 0, `${failed} of 40 lost a turn`);
}
{
    // A press back into the neck is dropped without blocking the next one.
    const h = steer(30, [...tap(300, 'ArrowLeft', 30), ...tap(320, 'ArrowUp', 30)]);
    check('a reversal is dropped and the next press still turns', h === 'RU', h);
}
{
    // Held keys still steer: Left held from the start is illegal while
    // heading right, then takes effect the moment an Up tap makes it legal.
    const h = steer(30, [[200, 'keydown', 'ArrowLeft'], ...tap(400, 'ArrowUp', 30), [1200, 'keyup', 'ArrowLeft']]);
    check('a held direction applies once it becomes legal', h === 'RUL', h);
}
{
    // A mash of six presses between two frames plays out as three turns at
    // most. (The cap is on presses WAITING: a mash that spans a step lets
    // that step spend one, which is fine.) Frames at 30fps fall every
    // 33.3ms from the start, so 301-323ms sits between the frames at 300
    // and 333. The presses zigzag up and away, so no turn they make can run
    // the snake into itself - a crash restarts it heading right, which would
    // read as one more turn.
    const keys = [];
    ['ArrowUp', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowUp', 'ArrowLeft']
        .forEach((code, i) => keys.push(...tap(301 + i * 4, code, 2)));
    const h = steer(30, keys);
    check('the queue is bounded: a mash plays out as three turns', h === 'RULU', h);
}
{
    // A held key's auto-repeat must not fill the queue and crowd out a real
    // press: only the first keydown of a hold is a press. (Up is let go as
    // Left is tapped; held any longer, it would rightly turn the snake back
    // up once that was legal again.)
    const repeats = [200, 230, 260, 290, 320].map((at) => [at, 'keydown', 'ArrowUp']);
    const h = steer(30, [...repeats, ...tap(330, 'ArrowLeft', 30), [335, 'keyup', 'ArrowUp']]);
    check('auto-repeat does not crowd out a real press', h === 'RUL', h);
}
{
    // Presses made during a crash are not orders for the next snake.
    const h = steer(30, tap(100, 'ArrowUp', 30), (s) => { s.dead = 6; });
    check('presses during a crash are cleared on restart', !h.includes('U'), h);
}

// --- 4. snake pace ---------------------------------------------------------
// Snake left to itself on an endless board (no wall to crash into), heading
// right with no input: every step moves the head one square, so the head's
// x is the step count. Returns the step times in ms.
function snakeSteps(hz, seconds, jitter) {
    const t = load('snake', { play: true, area: 'window' });
    const rnd = seeded(hz * 31);
    const period = 1000 / hz;
    let now = 5000;
    t.tick(now);
    const s = t.Idle.debugState();
    s.cols = 1e6;
    s.dir = { x: 1, y: 0 };
    s.food = [];
    const times = [];
    let x = s.body[0].x;
    const end = now + seconds * 1000;
    while (now < end) {
        now += period + (jitter ? (rnd() - 0.5) * 2 * jitter : 0);
        t.tick(now);
        const nx = t.Idle.debugState().body[0].x;
        for (let i = x; i < nx; i++) times.push(now);
        x = nx;
    }
    return times;
}

console.log('snake pace');
for (const hz of [16, 20, 25, 30, 32, 50, 60, 75, 90, 120, 144, 165, 240]) {
    const n = snakeSteps(hz, 20, 0.25).length / 20;
    check(`ten squares a second at ${hz}Hz`, Math.abs(n - 10) <= 0.2, n.toFixed(2) + '/s');
}
{
    // And evenly: at 60Hz the loop draws every 33.3ms, so every step must
    // be exactly three frames after the last - never slipping to a fourth
    // because three frames summed to 99.999ms.
    const times = snakeSteps(60, 10, 0.25);
    const gaps = times.slice(1).map((v, i) => v - times[i]);
    const odd = gaps.filter((g) => Math.abs(g - 100) > 2);
    check('at 60Hz every step is three frames apart', odd.length === 0,
        `${odd.length} of ${gaps.length} gaps off, e.g. ${odd.slice(0, 3).map((g) => g.toFixed(1)).join(', ')}ms`);
}

// --- 5. pipes and blocks pace ---------------------------------------------
// Drive a style at a refresh rate; `each` may adjust the state before every
// frame, `read` samples it after. Returns [{ now, v }].
function paced(style, opts, hz, seconds, setup, each, read) {
    const t = load(style, opts);
    const rnd = seeded(hz * 53);
    const period = 1000 / hz;
    let now = 5000;
    t.tick(now);
    if (setup) setup(t.Idle.debugState(), t);
    // A first sample before any frame, so a step on the very first frame
    // still shows as a change.
    const out = [{ now, v: read(t.Idle.debugState()) }];
    const end = now + seconds * 1000;
    while (now < end) {
        now += period + (rnd() - 0.5) * 0.5;
        if (each) each(t.Idle.debugState());
        t.tick(now);
        out.push({ now, v: read(t.Idle.debugState()) });
    }
    return out;
}
// Frames on which a step happened, judged by a changed signature.
function stepTimes(samples) {
    const times = [];
    for (let i = 1; i < samples.length; i++) {
        if (samples[i].v !== samples[i - 1].v) times.push(samples[i].now);
    }
    return times;
}
const RATES = [16, 20, 25, 30, 32, 50, 60, 75, 90, 120, 144, 165, 240];
const emptyBoard = (s) => { for (const row of s.board) row.fill(null); };
const pieceSig = (s) => `${s.cur && s.cur.idx}:${s.cur && s.cur.x}:${s.cur && s.cur.y}:${s.cur && s.cur.rot}:${s.lines}:${s.bag.length}`;

console.log('pipes and blocks pace');
{
    // Pipes: every step draws one segment per pipe. A huge budget means the
    // screen never resets mid-count.
    const pipeSteps = (hz, secs) => paced('pipes', { area: 'window' }, hz, secs,
        (s) => { s.budget = Infinity; }, null, (s) => s.drawn / s.pipes.length);
    for (const hz of RATES) {
        const smp = pipeSteps(hz, 10);
        const n = (smp[smp.length - 1].v - smp[0].v) / 10;
        check(`pipes: fifteen segments a second at ${hz}Hz`, Math.abs(n - 15) <= 0.3, n.toFixed(2) + '/s');
    }
    const times = stepTimes(pipeSteps(60, 6));
    const gaps = times.slice(1).map((v, i) => v - times[i]);
    const odd = gaps.filter((g) => Math.abs(g - 1000 / 15) > 2);
    check('pipes: at 60Hz every step is two frames apart', odd.length === 0,
        `${odd.length} of ${gaps.length} gaps off, e.g. ${odd.slice(0, 3).map((g) => g.toFixed(1)).join(', ')}ms`);
}
{
    // Blocks playing itself: every step is exactly one move - rotate, slide,
    // drop or lock - so a changed piece signature is a step. The board is
    // emptied every frame so it can never top out mid-count.
    const selfSteps = (hz, secs) => stepTimes(paced('blocks', { area: 'window' }, hz, secs,
        null, emptyBoard, pieceSig));
    for (const hz of RATES) {
        const n = selfSteps(hz, 10).length / 10;
        check(`blocks self-play: fifteen moves a second at ${hz}Hz`, Math.abs(n - 15) <= 0.3, n.toFixed(2) + '/s');
    }
    const times = selfSteps(60, 6);
    const gaps = times.slice(1).map((v, i) => v - times[i]);
    const odd = gaps.filter((g) => Math.abs(g - 1000 / 15) > 2);
    check('blocks self-play: at 60Hz every move is two frames apart', odd.length === 0,
        `${odd.length} of ${gaps.length} gaps off, e.g. ${odd.slice(0, 3).map((g) => g.toFixed(1)).join(', ')}ms`);
}
{
    // Soft drop: Down held, so every step drops a row or locks the piece.
    for (const hz of [16, 30, 32, 60, 144]) {
        const n = stepTimes(paced('blocks', { play: true, area: 'window' }, hz, 10,
            (s, t) => t.key('keydown', 'ArrowDown'), emptyBoard, pieceSig)).length / 10;
        check(`blocks soft drop: fifteen rows a second at ${hz}Hz`, Math.abs(n - 15) <= 0.3, n.toFixed(2) + '/s');
    }
}
{
    // Held Right: one move at once, the next 0.2s later, then ten a second.
    // The piece is put back at the left wall whenever it nears the right
    // one, so the hold never runs out of room.
    // Moves are counted against the position just before each frame, so a
    // move on the same frame as a put-back still counts.
    for (const hz of [16, 30, 32, 60, 144]) {
        let pre = 0;
        let count = 0;
        const smp = paced('blocks', { play: true, area: 'window' }, hz, 6,
            (s, t) => { s.cur.x = 0; s.cur.rot = 0; t.key('keydown', 'ArrowRight'); },
            (s) => { emptyBoard(s); if (s.cur.x >= 5) s.cur.x = 0; pre = s.cur.x; },
            (s) => { if (s.cur.x > pre) count++; return count; });
        const moves = stepTimes(smp);
        const first = moves[1] - moves[0];
        const rate = (moves.length - 2) / ((moves[moves.length - 1] - moves[1]) / 1000);
        const half = 500 / Math.min(hz, 30);
        check(`blocks held key: first repeat after 0.2s at ${hz}Hz`, Math.abs(first - 200) <= half + 1,
            first.toFixed(1) + 'ms');
        check(`blocks held key: then ten moves a second at ${hz}Hz`, Math.abs(rate - 10) <= 0.25,
            rate.toFixed(2) + '/s');
    }
}
{
    // The game-over pause is three seconds, not 90 frames. A full board and
    // the square piece make the very next lock end the game. (Not just any
    // piece: the flat bar lies wholly on the top row, so locking it there
    // completes every row, clears the board, and the game goes on.)
    for (const hz of [16, 60]) {
        const smp = paced('blocks', { area: 'window' }, hz, 6, (s) => {
            for (const row of s.board) row.fill('accent');
            s.cur = { idx: 1, rot: 0, x: 3, y: -1 };
            s.plan = null;
        }, null, (s) => s.over > 0);
        const start = smp.find((x) => x.v);
        const endAt = start && smp.find((x) => x.now > start.now && !x.v);
        const secs = start && endAt ? (endAt.now - start.now) / 1000 : null;
        check(`blocks game over: a three-second pause at ${hz}Hz`, secs !== null && Math.abs(secs - 3) <= 0.07,
            secs === null ? 'pause never ended' : secs.toFixed(2) + 's');
    }
}
{
    // A hard drop locks the piece; the new piece must not be moved by
    // gravity in the same frame, measured against the old piece's shape.
    // Down held at 16fps is the case that needs the guard: one frame is
    // most of a soft-drop step, so a fresh clock is due at once.
    const t = load('blocks', { play: true, area: 'window' });
    let now = 5000;
    t.tick(now);
    const s = t.Idle.debugState();
    const before = s.cur;
    t.key('keydown', 'ArrowDown');
    t.key('keydown', 'Space');
    now += 1000 / 16;
    t.tick(now);
    const after = t.Idle.debugState().cur;
    check('blocks hard drop: the new piece starts at the top', after !== before && after.y === -1,
        `new piece at y=${after.y}`);
}

// --- 6. the palette against the terminal ---------------------------------
// idle.js with the real colors.js beside it, a theme's CSS variables, and a
// terminal reporting the background and text it would draw with.
const COLORS_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'colors.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const ROOT_BLOCK = STYLE_CSS.slice(STYLE_CSS.indexOf(':root {'), STYLE_CSS.indexOf('}', STYLE_CSS.indexOf(':root {')));
const CSS_DEFAULTS = {};
for (const m of ROOT_BLOCK.matchAll(/(--se-[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)) CSS_DEFAULTS[m[1]] = m[2];
const themeBox = { window: {}, document: { documentElement: { style: { setProperty() {}, removeProperty() {} } } },
    localStorage: { getItem: () => null, setItem() {} } };
vm.createContext(themeBox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'themes.js'), 'utf8'), themeBox);
const ALL_THEMES = themeBox.window.Themes.THEMES;

function paletteFor(vars, bg, fg, style = 'aliens') {
    const noop = () => {};
    const ctx = new Proxy({}, { get(t, k) { if (k === 'measureText') return () => ({ width: 7 }); return k in t ? t[k] : noop; },
        set(t, k, v) { t[k] = v; return true; } });
    const el = () => ({ classList: { add: noop, remove: noop }, remove: noop, getContext: () => ctx,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) });
    const sb = {
        document: { hidden: false, documentElement: {}, body: { appendChild: noop }, createElement: el,
            getElementById: () => null, querySelector: () => null, addEventListener: noop, removeEventListener: noop },
        innerWidth: W, innerHeight: H, matchMedia: () => ({ matches: false }),
        addEventListener: noop, removeEventListener: noop,
        getComputedStyle: () => ({ getPropertyValue: (n) => vars[n] || '' }),
        rsterm: { invoke: () => ({ then: (f) => f({}) }), on: noop },
        requestAnimationFrame: () => 1, cancelAnimationFrame: noop,
        setInterval: () => 0, clearInterval: noop, setTimeout: () => 0, clearTimeout: noop, performance,
    };
    sb.window = sb;
    sb.TermPanes = { currentBackground: () => bg, currentForeground: () => fg };
    vm.createContext(sb);
    vm.runInContext(COLORS_SRC, sb, { filename: 'colors.js' });
    vm.runInContext(SRC, sb, { filename: 'idle.js' });
    sb.Idle.start(style, { area: 'window' });
    return { colors: sb.Idle.debugColors(), C: sb.Colors };
}

console.log('animation palette against the terminal');
{
    const fails = [];
    let mismatched = 0, matched = 0;
    for (const [key, theme] of Object.entries(ALL_THEMES)) {
        const v = { ...CSS_DEFAULTS, ...theme.vars };
        const probe = paletteFor(v, '#000000', '#ffffff').C;
        // What the terminal draws with in each mode (term-pane.js).
        const modes = {
            theme: { bg: v['--se-input'], fg: v['--se-txt'] },
            'theme-dark': (() => { const k = probe.keptDark({ input: v['--se-input'], panel: v['--se-panel'],
                txt: v['--se-txt'], accent: v['--se-accent'] }); return { bg: k.background, fg: k.foreground }; })(),
            dark: { bg: '#1b1e25', fg: '#e6e9ef' },
        };
        for (const [mode, { bg, fg }] of Object.entries(modes)) {
          // Aliens draws over the terminal; Pipes paints its own night.
          for (const [style, onGround] of [['aliens', false], ['pipes', true]]) {
            const { colors: c, C } = paletteFor(v, bg, fg, style);
            const surface = onGround ? c.ground : c.bg;
            const ratio = (x) => C.contrast(C.hexToRgb(x), C.hexToRgb(surface));
            const tag = `${key}/${mode}/${style}`;
            if (C.isLight(bg) && c.ground !== C.night(v['--se-accent'])) {
                fails.push(`${tag}: the night is ${c.ground}, not the theme's own ${C.night(v['--se-accent'])}`);
            }
            if (C.isLight(v['--se-input']) !== C.isLight(surface)) {
                // Where the colors are chosen for the surface, the ink a
                // night-painting style writes with must read too. (A theme
                // on its own surface keeps its design: Solarized Dark's text
                // sits at 6.3:1 on purpose.)
                if (onGround && ratio(c.ink) < 7) fails.push(`${tag}: ink ${c.ink} at ${ratio(c.ink).toFixed(1)}:1`);
                if (onGround && ratio(c.inkDim) < 3) fails.push(`${tag}: inkDim ${c.inkDim} at ${ratio(c.inkDim).toFixed(1)}:1`);
                mismatched++;
                if (ratio(c.txt) < 7) fails.push(`${tag}: text ${c.txt} at ${ratio(c.txt).toFixed(1)}:1`);
                for (const k of ['accent', 'up', 'down', 'warn']) {
                    if (ratio(c[k]) < 4.5) fails.push(`${tag}: ${k} ${c[k]} at ${ratio(c[k]).toFixed(1)}:1`);
                }
                if (ratio(c.dim) < 3) fails.push(`${tag}: dim ${c.dim} at ${ratio(c.dim).toFixed(1)}:1`);
            } else {
                matched++;
                for (const k of ['accent', 'up', 'down', 'warn', 'txt']) {
                    if (c[k] !== v['--se-' + k]) fails.push(`${tag}: ${k} changed to ${c[k]} though the theme fits its terminal`);
                }
                if (c.dim !== v['--se-txt-dim']) fails.push(`${tag}: dim changed to ${c.dim} though the theme fits its terminal`);
            }
          }
        }
    }
    check(`a palette on the other kind of surface reads (${mismatched} cases)`,
        !fails.some((f) => !f.includes('though')), fails.filter((f) => !f.includes('though')).slice(0, 4).join('; '));
    check(`a palette on its own kind of surface is left exactly as it is (${matched} cases)`,
        !fails.some((f) => f.includes('though')), fails.filter((f) => f.includes('though')).slice(0, 4).join('; '));
}

{
    // Every style that paints the night (or borrows a style that does)
    // declares `ground: true`, and no other does: the flag is what picks
    // the palette that reads on it.
    const bodies = {};
    const parts = SRC.split(/\n    STYLES\.(\w+) = \{/);
    for (let i = 1; i < parts.length; i += 2) bodies[parts[i]] = parts[i + 1].split('\n    STYLES.')[0];
    const paints = (id, seen = new Set()) => {
        if (seen.has(id)) return false;
        seen.add(id);
        const b = bodies[id] || '';
        if (/c\.ground/.test(b)) return true;
        return [...b.matchAll(/STYLES\.(\w+)\.frame\(/g)].some((m) => paints(m[1], seen));
    };
    const wrong = Object.keys(bodies).filter((id) => paints(id) !== /\bground: true\b/.test(bodies[id].split('\n')[1] || ''));
    check('the styles that paint the night are the ones flagged ground: true', wrong.length === 0,
        `mismatched: ${wrong.join(', ')}`);
}

// --- 7. the frame-rate setting -------------------------------------------
function fpsWith(hz, env, opts = { area: 'window' }) {
    const t = load('aliens', opts, env);
    const rnd = seeded(hz * 101);
    const period = 1000 / hz;
    let now = 5000;
    t.tick(now);
    const before = t.drawn();
    for (let i = 0; i < hz * 10; i++) { now += period + (rnd() - 0.5) * 0.5; t.tick(now); }
    return (t.drawn() - before) / 10;
}
const NO_GPU = { software: true }, GPU = { software: false };
const fpsSet = (fps) => ({ idle: { fps } });
console.log('frame-rate setting');
{
    const cases = [
        ['automatic without a GPU: 15fps (60Hz)', 60, { rendering: NO_GPU }, 14.5, 15.5],
        ['automatic without a GPU over RDP: every other tick (32Hz)', 32, { rendering: NO_GPU }, 15.5, 16.5],
        ['automatic without a GPU: 15fps (144Hz)', 144, { rendering: NO_GPU }, 13.5, 15.5],
        ['automatic with a GPU: 30fps (60Hz)', 60, { rendering: GPU }, 29, 31],
        ['low with a GPU: 15fps', 60, { rendering: GPU, settings: fpsSet('low') }, 14.5, 15.5],
        ['full without a GPU: 30fps (60Hz)', 60, { rendering: NO_GPU, settings: fpsSet('full') }, 29, 31],
        ['full without a GPU over RDP: every tick (32Hz)', 32, { rendering: NO_GPU, settings: fpsSet('full') }, 31.5, 32.5],
        ['an unknown value is automatic', 60, { rendering: NO_GPU, settings: fpsSet('warp') }, 14.5, 15.5],
    ];
    for (const [name, hz, env, lo, hi] of cases) {
        const fps = fpsWith(hz, env);
        check(name, fps >= lo && fps <= hi, fps.toFixed(1) + 'fps');
    }
    const played = fpsWith(60, { rendering: NO_GPU, settings: fpsSet('low') }, { play: true, area: 'window' });
    check('a game being played keeps full speed under low', played >= 29 && played <= 31, played.toFixed(1) + 'fps');
}

if (failures) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log('\nall idle checks passed');
