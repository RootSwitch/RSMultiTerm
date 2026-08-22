'use strict';
// Idle animations: after N minutes without keyboard or mouse, a canvas
// takes over the window and plays something, demo-scene style. Off by
// default; Settings > Idle animation turns it on.
//
// Two rules make this safe in a tool that talks to switches:
//
//   1. OVERLAY, NEVER THE TERMINAL. Nothing here calls term.write or touches
//      a port. The canvas sits over the window; sessions keep receiving
//      output, logs keep writing, flow control keeps acking, and dismissing
//      the overlay reveals every pane exactly as it would have been. The
//      invariant test pins it: this file may not mention term.write or
//      postMessage.
//   2. THE WAKING KEYSTROKE IS SWALLOWED. The key that dismisses the
//      overlay is captured and stopped before it can reach a terminal - an
//      Enter pressed to wake the screen must not execute whatever is sitting
//      on a device's command line. Mouse movement dismisses with no side
//      effect at all.
//
// Also: a dialog appearing while the overlay is up (a password prompt, a
// host-key question) dismisses it, so nothing the app asks can be hidden
// behind an animation; the loop pauses while the window is hidden (the app
// runs with background throttling OFF so terminals keep parsing, which
// means an animation would otherwise spin at full rate while minimized);
// and prefers-reduced-motion disables auto-start.
//
// Styles come in two kinds. Screen-aware ones read what the terminals are
// showing and play with it - words become bricks, glyphs rain, text seeds
// Life. Takeover ones ignore the screen entirely. Each style is a small
// object; adding one is adding an entry to STYLES.

(function () {
    const FPS_CAP = 30;
    const CHECK_EVERY_MS = 5000;

    let settings = { style: 'off', minutes: 5 };
    let lastActivity = Date.now();
    let running = null;       // {canvas, ctx, style, state, raf, lastFrame, env}
    let reducedMotion = false;
    try {
        reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_) { /* no matchMedia: assume motion is fine */ }

    // --- settings -----------------------------------------------------------
    const applySettings = (s) => {
        const i = (s && s.idle) || {};
        settings = {
            style: i.style || 'off',
            minutes: Math.max(1, Math.min(240, Number(i.minutes) || 5)),
        };
    };
    rsterm.invoke('rs:settings.get').then(applySettings);
    rsterm.on('rs:evt.settings-changed', applySettings);

    // --- activity -----------------------------------------------------------
    const touch = () => { lastActivity = Date.now(); };
    for (const ev of ['keydown', 'mousedown', 'wheel']) {
        window.addEventListener(ev, touch, { capture: true, passive: true });
    }
    // Mouse movement counts, but a jitter from a bumped desk should not
    // wake the screen, so a small threshold applies while running.
    let lastMouse = null;
    window.addEventListener('mousemove', (e) => {
        if (!running) { touch(); return; }
        if (lastMouse && Math.hypot(e.clientX - lastMouse.x, e.clientY - lastMouse.y) > 12) {
            touch();
            stop();
        }
        lastMouse = { x: e.clientX, y: e.clientY };
    }, { capture: true, passive: true });

    setInterval(() => {
        if (running || settings.style === 'off' || reducedMotion) return;
        if (document.hidden) return;
        if (document.querySelector('.modal-backdrop')) return;
        if (Date.now() - lastActivity >= settings.minutes * 60 * 1000) start(settings.style);
    }, CHECK_EVERY_MS);

    // --- theme + screen sampling -------------------------------------------
    function themeColors() {
        const cs = getComputedStyle(document.documentElement);
        const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
        return {
            bg: (window.TermPanes && window.TermPanes.currentBackground()) || '#101318',
            accent: v('--se-accent', '#4aa3e0'),
            up: v('--se-up', '#5eb95e'),
            down: v('--se-down', '#e05561'),
            warn: v('--se-warn', '#e6c351'),
            txt: v('--se-txt', '#e8ecf2'),
            dim: v('--se-txt-dim', '#8a95a5'),
            mono: v('--mt-mono', 'monospace'),
        };
    }

    // What the visible terminals are showing, with pixel geometry so a style
    // can draw exactly where the text is. Reads the buffer through xterm's
    // public API; nothing is written.
    function sampleScreen() {
        const out = { lines: [], words: [], glyphs: new Set() };
        if (!window.Tabs || !window.TermPanes) return out;
        const tab = window.Tabs.active();
        if (!tab) return out;
        for (const sid of tab.sessionIds) {
            const pane = window.TermPanes.panes.get(sid);
            if (!pane || !pane.host || !pane.host.isConnected) continue;
            const term = pane.term;
            const rect = pane.host.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) continue;
            let cw = rect.width / term.cols;
            let ch = rect.height / term.rows;
            try {
                const d = term._core._renderService.dimensions.css.cell;
                if (d && d.width > 0 && d.height > 0) { cw = d.width; ch = d.height; }
            } catch (_) { /* the estimate above is close enough */ }
            const buf = term.buffer.active;
            for (let r = 0; r < term.rows; r++) {
                const line = buf.getLine(buf.viewportY + r);
                const text = line ? line.translateToString(true) : '';
                if (!text) continue;
                const y = rect.top + r * ch;
                out.lines.push({ text, x: rect.left, y, cw, ch });
                for (const ch_ of text) if (ch_ !== ' ') out.glyphs.add(ch_);
                const re = /\S+/g;
                let m;
                while ((m = re.exec(text))) {
                    out.words.push({
                        text: m[0], x: rect.left + m.index * cw, y,
                        w: m[0].length * cw, h: ch,
                    });
                }
            }
        }
        return out;
    }

    // --- the loop -------------------------------------------------------------
    function start(styleId) {
        if (running) return;
        const ids = Object.keys(STYLES);
        const id = styleId === 'random' || !STYLES[styleId]
            ? ids[Math.floor(Math.random() * ids.length)] : styleId;
        const style = STYLES[id];

        const canvas = document.createElement('canvas');
        canvas.id = 'idle-overlay';
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        document.body.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        const env = {
            w: canvas.width, h: canvas.height,
            colors: themeColors(),
            screen: style.screen ? sampleScreen() : null,
            rnd: Math.random,
        };
        running = { canvas, ctx, style, env, state: style.init(env), raf: 0, lastFrame: 0, id };
        lastMouse = null;

        // The waking keystroke never reaches a terminal: capture phase,
        // default prevented, propagation stopped, THEN the overlay goes.
        document.addEventListener('keydown', onWakeKey, { capture: true });
        document.addEventListener('mousedown', onWakeMouse, { capture: true });
        document.addEventListener('wheel', onWakeMouse, { capture: true, passive: true });
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('resize', onResize);
        running.raf = requestAnimationFrame(frame);
        setStatus(`idle: ${style.label} - any key or mouse movement to return`);
    }

    function stop() {
        if (!running) return;
        cancelAnimationFrame(running.raf);
        running.canvas.remove();
        document.removeEventListener('keydown', onWakeKey, { capture: true });
        document.removeEventListener('mousedown', onWakeMouse, { capture: true });
        document.removeEventListener('wheel', onWakeMouse, { capture: true });
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('resize', onResize);
        running = null;
        touch();
        setStatus('');
        // Back to where the keyboard was.
        const tab = window.Tabs && window.Tabs.active();
        const pane = tab && window.TermPanes.panes.get(tab.focusedSessionId);
        if (pane) pane.term.focus();
    }

    function onWakeKey(e) {
        e.preventDefault();
        e.stopImmediatePropagation();
        stop();
    }
    function onWakeMouse() { stop(); }
    function onVisibility() {
        if (!running) return;
        if (document.hidden) cancelAnimationFrame(running.raf);
        else { running.lastFrame = 0; running.raf = requestAnimationFrame(frame); }
    }
    function onResize() {
        if (!running) return;
        running.canvas.width = running.env.w = window.innerWidth;
        running.canvas.height = running.env.h = window.innerHeight;
        running.state = running.style.init(running.env);
    }

    let frames = 0;
    function frame(now) {
        if (!running) return;
        running.raf = requestAnimationFrame(frame);
        // A dialog the app raised must never sit hidden under an animation.
        if ((frames++ & 15) === 0 && document.querySelector('.modal-backdrop')) { stop(); return; }
        if (running.lastFrame && now - running.lastFrame < 1000 / FPS_CAP) return;
        const dt = running.lastFrame ? Math.min(0.1, (now - running.lastFrame) / 1000) : 1 / FPS_CAP;
        running.lastFrame = now;
        running.style.frame(running.ctx, running.env, running.state, dt);
    }

    function setStatus(text) {
        const el = document.getElementById('status-text');
        if (el && text) el.textContent = text;
    }

    // --- styles ---------------------------------------------------------------
    // Each: { label, screen: bool, init(env) -> state, frame(ctx, env, state, dt) }.

    const STYLES = {};

    // Rain: columns of glyphs falling in the theme's accent. The glyphs are
    // whatever the terminals were showing - your own hostnames and IPs
    // coming down, which is the whole reason it does not look like a film.
    STYLES.rain = {
        label: 'Rain', screen: true,
        init(env) {
            const cw = 14, ch = 18;
            const cols = Math.ceil(env.w / cw);
            const glyphs = env.screen && env.screen.glyphs.size > 12
                ? [...env.screen.glyphs]
                : [...'0123456789abcdefABCDEF:./#@%*+-=<>?'];
            return {
                cw, ch, glyphs,
                cols: Array.from({ length: cols }, () => ({
                    y: -Math.random() * env.h, speed: 60 + Math.random() * 180,
                    len: 6 + Math.floor(Math.random() * 18),
                })),
                first: true,
            };
        },
        frame(ctx, env, s, dt) {
            const c = env.colors;
            if (s.first) { ctx.fillStyle = c.bg; ctx.fillRect(0, 0, env.w, env.h); s.first = false; }
            // Fade the previous frame toward the ground: the trail.
            ctx.globalAlpha = 0.10;
            ctx.fillStyle = c.bg;
            ctx.fillRect(0, 0, env.w, env.h);
            ctx.globalAlpha = 1;
            ctx.font = `${s.ch - 3}px ${c.mono}`;
            ctx.textBaseline = 'top';
            s.cols.forEach((col, i) => {
                col.y += col.speed * dt;
                const x = i * s.cw;
                const g = s.glyphs[Math.floor(Math.random() * s.glyphs.length)];
                ctx.fillStyle = c.txt;
                ctx.fillText(g, x, col.y);
                ctx.fillStyle = c.accent;
                ctx.fillText(s.glyphs[Math.floor(Math.random() * s.glyphs.length)], x, col.y - s.ch);
                if (col.y > env.h + col.len * s.ch) {
                    col.y = -Math.random() * env.h * 0.5;
                    col.speed = 60 + Math.random() * 180;
                }
            });
        },
    };

    // Bricks: every word on screen is a brick, where it is. An automatic
    // paddle plays until the screen is clear, then the screen is re-read.
    STYLES.bricks = {
        label: 'Bricks', screen: true,
        init(env) {
            const words = (env.screen ? env.screen.words : []).filter((w) => w.text.length > 0);
            const bricks = words.map((w, i) => ({ ...w, alive: true, tone: i % 3 }));
            const paddleW = Math.max(80, env.w * 0.08);
            return {
                bricks, paddleW,
                paddleX: env.w / 2 - paddleW / 2,
                ball: { x: env.w / 2, y: env.h * 0.7, vx: 180, vy: -260, r: 5 },
                speed: 320,
            };
        },
        frame(ctx, env, s, dt) {
            const c = env.colors;
            ctx.fillStyle = c.bg;
            ctx.fillRect(0, 0, env.w, env.h);

            // Move the ball.
            const b = s.ball;
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx); }
            if (b.x > env.w - b.r) { b.x = env.w - b.r; b.vx = -Math.abs(b.vx); }
            if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy); }

            // The paddle chases the ball, with just enough lag to miss now
            // and then - a perfect paddle is boring to watch.
            const paddleY = env.h - 24;
            const target = b.x - s.paddleW / 2 + Math.sin(b.y / 40) * 30;
            s.paddleX += Math.max(-420 * dt, Math.min(420 * dt, target - s.paddleX));
            s.paddleX = Math.max(0, Math.min(env.w - s.paddleW, s.paddleX));
            if (b.vy > 0 && b.y + b.r >= paddleY && b.y - b.r <= paddleY + 8 &&
                b.x >= s.paddleX - b.r && b.x <= s.paddleX + s.paddleW + b.r) {
                b.y = paddleY - b.r;
                const hit = (b.x - (s.paddleX + s.paddleW / 2)) / (s.paddleW / 2);
                const ang = hit * 1.1;
                b.vx = Math.sin(ang) * s.speed;
                b.vy = -Math.cos(ang) * s.speed;
            }
            if (b.y > env.h + 40) {
                // Missed: serve again from the middle.
                b.x = env.w / 2; b.y = env.h * 0.7; b.vx = (Math.random() - 0.5) * 300; b.vy = -280;
            }

            // Bricks.
            let alive = 0;
            ctx.font = `${Math.max(10, Math.round((s.bricks[0] || { h: 16 }).h * 0.75))}px ${c.mono}`;
            ctx.textBaseline = 'top';
            for (const br of s.bricks) {
                if (!br.alive) continue;
                alive++;
                if (b.x + b.r > br.x && b.x - b.r < br.x + br.w &&
                    b.y + b.r > br.y && b.y - b.r < br.y + br.h) {
                    br.alive = false;
                    // Reflect on the axis of least penetration.
                    const dx = Math.min(b.x + b.r - br.x, br.x + br.w - (b.x - b.r));
                    const dy = Math.min(b.y + b.r - br.y, br.y + br.h - (b.y - b.r));
                    if (dx < dy) b.vx = -b.vx; else b.vy = -b.vy;
                    continue;
                }
                ctx.fillStyle = br.tone === 0 ? c.accent : br.tone === 1 ? c.up : c.warn;
                ctx.globalAlpha = 0.18;
                ctx.fillRect(br.x + 1, br.y + 1, br.w - 2, br.h - 2);
                ctx.globalAlpha = 1;
                ctx.fillText(br.text, br.x, br.y + 2);
            }
            if (alive === 0) {
                const fresh = STYLES.bricks.init({ ...env, screen: sampleScreen() });
                if (fresh.bricks.length) Object.assign(s, fresh);
            }

            // Paddle and ball.
            ctx.fillStyle = c.txt;
            ctx.fillRect(s.paddleX, paddleY, s.paddleW, 6);
            ctx.beginPath();
            ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
            ctx.fill();
        },
    };

    // Life: Conway's Game of Life seeded by the characters on screen. Cells
    // are the terminal's own cell size, so the first generation IS the
    // screen, and then it starts to move.
    STYLES.life = {
        label: 'Life', screen: true,
        init(env) {
            const sample = env.screen || { lines: [] };
            const cw = Math.max(6, Math.round((sample.lines[0] || { cw: 9 }).cw));
            const ch = Math.max(8, Math.round((sample.lines[0] || { ch: 18 }).ch));
            const cols = Math.ceil(env.w / cw), rows = Math.ceil(env.h / ch);
            const grid = new Uint8Array(cols * rows);
            let seeded = 0;
            for (const l of sample.lines) {
                const row = Math.floor(l.y / ch);
                for (let i = 0; i < l.text.length; i++) {
                    if (l.text[i] === ' ') continue;
                    const col = Math.floor((l.x + i * l.cw) / cw);
                    if (col >= 0 && col < cols && row >= 0 && row < rows) { grid[row * cols + col] = 1; seeded++; }
                }
            }
            // A near-empty screen gets a random soup so there is something to
            // watch.
            if (seeded < cols * rows * 0.04) {
                for (let i = 0; i < grid.length; i++) if (Math.random() < 0.18) grid[i] = 1;
            }
            return { cw, ch, cols, rows, grid, next: new Uint8Array(cols * rows), age: new Uint8Array(cols * rows),
                acc: 0, history: [], stale: 0 };
        },
        frame(ctx, env, s, dt) {
            const c = env.colors;
            s.acc += dt;
            if (s.acc >= 0.12) {
                s.acc = 0;
                const { cols, rows, grid, next, age } = s;
                let pop = 0;
                for (let r = 0; r < rows; r++) {
                    for (let col = 0; col < cols; col++) {
                        let n = 0;
                        for (let dr = -1; dr <= 1; dr++) {
                            for (let dc = -1; dc <= 1; dc++) {
                                if (!dr && !dc) continue;
                                const rr = (r + dr + rows) % rows, cc = (col + dc + cols) % cols;
                                n += grid[rr * cols + cc];
                            }
                        }
                        const i = r * cols + col;
                        const alive = grid[i] ? (n === 2 || n === 3) : n === 3;
                        next[i] = alive ? 1 : 0;
                        age[i] = alive ? Math.min(255, age[i] + 1) : 0;
                        pop += next[i];
                    }
                }
                s.grid.set(next);
                // Still life or a short oscillation for a while: reseed.
                s.history.push(pop);
                if (s.history.length > 24) s.history.shift();
                if (s.history.length === 24 && new Set(s.history).size <= 2) {
                    Object.assign(s, STYLES.life.init({ ...env, screen: sampleScreen() }));
                }
            }
            ctx.fillStyle = c.bg;
            ctx.fillRect(0, 0, env.w, env.h);
            for (let r = 0; r < s.rows; r++) {
                for (let col = 0; col < s.cols; col++) {
                    const i = r * s.cols + col;
                    if (!s.grid[i]) continue;
                    const a = s.age[i];
                    ctx.fillStyle = a < 2 ? c.txt : a < 8 ? c.accent : c.dim;
                    ctx.fillRect(col * s.cw + 1, r * s.ch + 1, s.cw - 2, s.ch - 2);
                }
            }
        },
    };

    // Starfield: the warp. Depth picks the glyph, so far stars are dots and
    // near ones are hashes streaking past.
    STYLES.starfield = {
        label: 'Starfield', screen: false,
        init(env) {
            const mk = () => ({ x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: Math.random() });
            return { stars: Array.from({ length: 420 }, mk), mk, speed: 0.35 };
        },
        frame(ctx, env, s, dt) {
            const c = env.colors;
            ctx.fillStyle = c.bg;
            ctx.fillRect(0, 0, env.w, env.h);
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'center';
            const cx = env.w / 2, cy = env.h / 2;
            const glyphs = ['.', ':', '+', '*', '#'];
            for (const st of s.stars) {
                st.z -= s.speed * dt;
                if (st.z <= 0.02) { Object.assign(st, s.mk()); st.z = 1; }
                const k = 1 / st.z;
                const x = cx + st.x * k * cx * 0.9, y = cy + st.y * k * cy * 0.9;
                if (x < 0 || x > env.w || y < 0 || y > env.h) { Object.assign(st, s.mk()); st.z = 1; continue; }
                const tier = Math.min(4, Math.floor((1 - st.z) * 5));
                ctx.font = `${8 + tier * 3}px ${c.mono}`;
                ctx.fillStyle = tier >= 3 ? c.txt : tier === 2 ? c.accent : c.dim;
                ctx.fillText(glyphs[tier], x, y);
            }
            ctx.textAlign = 'start';
        },
    };

    // Snow: the chill one. Flakes drift, sway, and settle into a drift along
    // the bottom edge that slowly grows.
    STYLES.snow = {
        label: 'Snow', screen: false,
        init(env) {
            const mk = () => ({
                x: Math.random() * env.w, y: -Math.random() * env.h,
                v: 25 + Math.random() * 45, sway: Math.random() * Math.PI * 2,
                size: Math.random() < 0.2 ? 2 : Math.random() < 0.5 ? 1 : 0,
            });
            return { flakes: Array.from({ length: 260 }, mk), mk, drift: new Float32Array(Math.ceil(env.w / 6)), t: 0 };
        },
        frame(ctx, env, s, dt) {
            const c = env.colors;
            s.t += dt;
            ctx.fillStyle = c.bg;
            ctx.fillRect(0, 0, env.w, env.h);
            ctx.textBaseline = 'middle';
            const glyph = ['.', '*', '*'];
            for (const f of s.flakes) {
                f.y += f.v * dt;
                f.x += Math.sin(s.t * 0.8 + f.sway) * 14 * dt;
                const bin = Math.max(0, Math.min(s.drift.length - 1, Math.floor(f.x / 6)));
                if (f.y >= env.h - s.drift[bin]) {
                    s.drift[bin] = Math.min(env.h * 0.25, s.drift[bin] + 0.35);
                    Object.assign(f, s.mk());
                    f.y = -10;
                    continue;
                }
                ctx.font = `${10 + f.size * 4}px ${c.mono}`;
                ctx.fillStyle = f.size === 2 ? c.txt : c.dim;
                ctx.fillText(glyph[f.size], f.x, f.y);
            }
            ctx.fillStyle = c.txt;
            for (let i = 0; i < s.drift.length; i++) {
                if (s.drift[i] > 0) ctx.fillRect(i * 6, env.h - s.drift[i], 6, s.drift[i]);
            }
        },
    };

    // Fire: the demo-scene heat buffer. Each cell cools from the one below
    // it with a little random drift, the bottom row is the fuel, and heat
    // picks both the glyph and the color - the theme's own colors, so Ember
    // burns orange, Phosphor green, and Classic is a blue flame.
    STYLES.fire = {
        label: 'Fire', screen: false,
        init(env) {
            const cw = 10, ch = 16;
            const cols = Math.ceil(env.w / cw), rows = Math.ceil(env.h / ch);
            return { cw, ch, cols, rows, heat: new Float32Array(cols * rows), acc: 0, t: 0 };
        },
        frame(ctx, env, s, dt) {
            const c = env.colors;
            const { cols, rows, heat } = s;
            s.t += dt;
            s.acc += dt;
            // Simulate at a fixed 20 Hz regardless of draw rate, so the flame
            // speed does not depend on the machine.
            while (s.acc >= 0.05) {
                s.acc -= 0.05;
                // Fuel: the bottom row flickers near full heat.
                for (let x = 0; x < cols; x++) {
                    heat[(rows - 1) * cols + x] = 0.85 + Math.random() * 0.15;
                }
                for (let y = rows - 2; y >= 0; y--) {
                    for (let x = 0; x < cols; x++) {
                        const drift = Math.floor(Math.random() * 3) - 1;
                        const sx = Math.max(0, Math.min(cols - 1, x + drift));
                        const below = heat[(y + 1) * cols + sx];
                        heat[y * cols + x] = Math.max(0, below - Math.random() * 0.09 - 0.015);
                    }
                }
            }
            ctx.fillStyle = c.bg;
            ctx.fillRect(0, 0, env.w, env.h);
            ctx.font = `${s.ch - 2}px ${c.mono}`;
            ctx.textBaseline = 'top';
            const ramp = ' .:-=+*#%@';
            let tier = -1;
            for (let y = 0; y < rows; y++) {
                for (let x = 0; x < cols; x++) {
                    const h = heat[y * cols + x];
                    if (h < 0.08) continue;
                    const g = ramp[Math.min(ramp.length - 1, Math.floor(h * ramp.length))];
                    const t = h > 0.75 ? 2 : h > 0.4 ? 1 : 0;
                    if (t !== tier) { ctx.fillStyle = t === 2 ? c.txt : t === 1 ? c.accent : c.dim; tier = t; }
                    ctx.fillText(g, x * s.cw, y * s.ch);
                }
            }
        },
    };

    window.Idle = {
        start, stop,
        isRunning: () => !!running,
        // Frames drawn since load - the honest way to measure the loop.
        frameCount: () => frames,
        styles: () => Object.entries(STYLES).map(([id, s]) => ({ id, label: s.label })),
    };
})();
