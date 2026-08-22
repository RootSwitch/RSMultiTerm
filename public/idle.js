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
// behind an animation; and the loop pauses while the window is hidden (the
// app runs with background throttling OFF so terminals keep parsing, which
// means an animation would otherwise spin at full rate while minimized).
//
// prefers-reduced-motion is NOT a veto. Windows Server editions ship with
// "Show animations in Windows" off, and RDP sessions turn it off too;
// Chromium reports both as reduce, and the first version silently refused
// to ever start on those machines - the setting looked broken. The setting
// is off by default, so turning it on IS the consent; Settings shows a note
// when the OS is asking for reduced motion, and that is all.
//
// Styles come in two kinds. Screen-aware ones read what the terminals are
// showing and play with it - words become bricks, glyphs rain, text seeds
// Life. Takeover ones ignore the screen entirely. Each style is a small
// object; adding one is adding an entry to STYLES.

(function () {
    const FPS_CAP = 30;
    const CHECK_EVERY_MS = 5000;

    let settings = { style: 'off', minutes: 5, area: 'window' };
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
            area: i.area === 'panes' ? 'panes' : 'window',
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
        if (running.play) { touch(); return; }   // a nudged mouse must not end a game
        if (lastMouse && Math.hypot(e.clientX - lastMouse.x, e.clientY - lastMouse.y) > 12) {
            touch();
            stop();
        }
        lastMouse = { x: e.clientX, y: e.clientY };
    }, { capture: true, passive: true });

    setInterval(() => {
        if (running || settings.style === 'off') return;
        if (document.hidden) return;
        if (document.querySelector('.modal-backdrop')) return;
        if (Date.now() - lastActivity >= settings.minutes * 60 * 1000) start(settings.style);
    }, CHECK_EVERY_MS);

    // --- theme + screen sampling -------------------------------------------
    function themeColors() {
        const cs = getComputedStyle(document.documentElement);
        const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
        const c = {
            bg: (window.TermPanes && window.TermPanes.currentBackground()) || '#101318',
            accent: v('--se-accent', '#4aa3e0'),
            up: v('--se-up', '#5eb95e'),
            down: v('--se-down', '#e05561'),
            warn: v('--se-warn', '#e6c351'),
            txt: v('--se-txt', '#e8ecf2'),
            dim: v('--se-txt-dim', '#8a95a5'),
            mono: v('--mt-mono', 'monospace'),
        };
        // Takeover styles (stars, snow, fire) want night. On a light theme
        // the terminal background is paper, and white flakes on paper is a
        // flashbang - so the ground becomes a near-black tint of the theme's
        // accent (Sakura gets a dark pink night, Glacier a dark blue one),
        // and the ink is the accent itself rather than the theme's dark text.
        // Screen-aware styles keep the real background: they are drawing
        // over the terminal's own words and should look like it.
        const light = window.Colors && window.Colors.isLight(c.bg);
        if (light) {
            const a = window.Colors.hexToRgb(c.accent) || { r: 60, g: 80, b: 120 };
            c.ground = window.Colors.rgbToHex({
                r: Math.round(a.r * 0.14), g: Math.round(a.g * 0.14), b: Math.round(a.b * 0.14) });
            c.ink = '#f2f2f2';
            c.inkDim = c.accent;
        } else {
            c.ground = c.bg;
            c.ink = c.txt;
            c.inkDim = c.dim;
        }
        return c;
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
    // The union of the visible terminal hosts: a clip path plus its
    // bounding box. Null when there are no panes (then it is the window).
    function paneRegion() {
        if (!window.Tabs || !window.TermPanes) return null;
        const tab = window.Tabs.active();
        if (!tab) return null;
        const rects = [];
        for (const sid of tab.sessionIds) {
            const pane = window.TermPanes.panes.get(sid);
            if (!pane || !pane.host || !pane.host.isConnected) continue;
            const r = pane.host.getBoundingClientRect();
            if (r.width > 10 && r.height > 10) rects.push(r);
        }
        if (!rects.length) return null;
        const x = Math.min(...rects.map((r) => r.left)), y = Math.min(...rects.map((r) => r.top));
        const right = Math.max(...rects.map((r) => r.right)), bottom = Math.max(...rects.map((r) => r.bottom));
        return { x, y, w: right - x, h: bottom - y, rects };
    }
    function shiftScreen(screen, dx, dy) {
        for (const l of screen.lines) { l.x += dx; l.y += dy; }
        for (const w of screen.words) { w.x += dx; w.y += dy; }
    }

    function start(styleId, opts) {
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

        // "Terminal panes only": the animation is clipped to the terminal
        // hosts and its world is their bounding box, so the rain falls in
        // your terminal while the sidebar, tabs and title stay visible.
        const region = (opts && opts.area || settings.area) === 'panes' ? paneRegion() : null;
        if (region) canvas.classList.add('keyed');
        const screen = style.screen ? sampleScreen() : null;
        if (region && screen) shiftScreen(screen, -region.x, -region.y);
        const env = {
            w: region ? region.w : canvas.width, h: region ? region.h : canvas.height,
            colors: themeColors(),
            screen,
            rnd: Math.random,
        };
        // Play mode: the keyboard drives the style instead of waking it.
        // Every key is still swallowed (nothing reaches a terminal); Escape
        // or a click ends the game. Arrows or A/D move, Space fires or
        // serves - the three keys everybody guesses first.
        const play = !!(opts && opts.play);
        env.play = play ? { left: false, right: false, fire: false, fired: false, score: 0 } : null;
        running = { canvas, ctx, style, env, region, state: style.init(env), raf: 0, lastFrame: 0, id, play };
        lastMouse = null;

        // The waking keystroke never reaches a terminal: capture phase,
        // default prevented, propagation stopped, THEN the overlay goes.
        document.addEventListener('keydown', onWakeKey, { capture: true });
        document.addEventListener('keyup', onWakeKey, { capture: true });
        document.addEventListener('mousedown', onWakeMouse, { capture: true });
        document.addEventListener('wheel', onWakeMouse, { capture: true, passive: true });
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('resize', onResize);
        running.raf = requestAnimationFrame(frame);
        setStatus(play
            ? `${style.label}: arrows or A/D move, Space fires, Esc or a click quits`
            : `idle: ${style.label} - any key or mouse movement to return`);
    }

    function stop() {
        if (!running) return;
        cancelAnimationFrame(running.raf);
        running.canvas.remove();
        document.removeEventListener('keydown', onWakeKey, { capture: true });
        document.removeEventListener('keyup', onWakeKey, { capture: true });
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
        if (!running || !running.play) { stop(); return; }
        if (e.key === 'Escape') { stop(); return; }
        const input = running.env.play;
        const k = (e.code === 'ArrowLeft' || e.code === 'KeyA') ? 'left'
            : (e.code === 'ArrowRight' || e.code === 'KeyD') ? 'right'
                : (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') ? 'fire' : null;
        if (!k) return;
        const down = e.type === 'keydown';
        if (k === 'fire' && down && !input.fire) input.fired = true;   // an edge, consumed by the style
        input[k] = down;
    }
    function onWakeMouse() { stop(); }
    function onVisibility() {
        if (!running) return;
        if (document.hidden) cancelAnimationFrame(running.raf);
        else { running.lastFrame = 0; running.raf = requestAnimationFrame(frame); }
    }
    function onResize() {
        if (!running) return;
        running.canvas.width = window.innerWidth;
        running.canvas.height = window.innerHeight;
        if (running.region) running.region = paneRegion();
        running.env.w = running.region ? running.region.w : window.innerWidth;
        running.env.h = running.region ? running.region.h : window.innerHeight;
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
        const { ctx, region } = running;
        if (region) {
            // Clip to the panes, then move the origin to their box: every
            // style draws as if the box were the whole canvas. Outside the
            // clip nothing is ever painted, so the chrome shows through.
            ctx.save();
            ctx.beginPath();
            for (const r of region.rects) ctx.rect(r.left, r.top, r.width, r.height);
            ctx.clip();
            ctx.translate(region.x, region.y);
        }
        running.style.frame(ctx, running.env, running.state, dt);
        if (region) ctx.restore();
    }

    // A fresh screen sample in the running style's coordinate space.
    function resample() {
        const screen = sampleScreen();
        if (running && running.region) shiftScreen(screen, -running.region.x, -running.region.y);
        return screen;
    }

    // Score and controls, drawn by the playable styles.
    function drawHud(ctx, env) {
        const c = env.colors;
        const p = env.play;
        if (!p) return;
        ctx.font = `13px ${c.mono}`;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'right';
        ctx.fillStyle = c.txt;
        ctx.fillText(`score ${p.score}`, env.w - 12, 10);
        ctx.textAlign = 'left';
        ctx.fillStyle = c.dim;
        ctx.fillText('arrows / A D move   space fires   esc quits', 12, env.h - 20);
    }

    // The Extras menu: every effect on demand, and the two games to play.
    // Sits on the quick-connect row under the theme picker, where the
    // decorative controls live.
    function extrasMenu(anchor) {
        const r = anchor.getBoundingClientRect();
        const items = [
            { label: 'Play Bricks', onClick: () => start('bricks', { play: true, area: settings.area }) },
            { label: 'Play Aliens', onClick: () => start('aliens', { play: true, area: settings.area }) },
            null,
        ];
        for (const [id, st] of Object.entries(STYLES)) {
            items.push({ label: `Effect: ${st.label}`, onClick: () => start(id, { area: settings.area }) });
        }
        items.push(null, {
            label: 'Idle animation settings...',
            onClick: () => window.SettingsUI && window.SettingsUI.openSettings(),
        }, {
            // The same knob as Settings > Play over, surfaced here so people
            // learn that "just the terminal panes" exists at all. Writes the
            // setting; the Settings dialog reads it back on open.
            label: 'Full screen',
            checked: settings.area !== 'panes',
            onClick: (on) => rsterm.invoke('rs:settings.update', { idle: { area: on ? 'window' : 'panes' } }),
        });
        window.Modals.menu(r.left, r.bottom + 2, items);
    }
    const extrasBtn = document.getElementById('extras-btn');
    if (extrasBtn) extrasBtn.addEventListener('click', () => extrasMenu(extrasBtn));

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
                // In play mode the ball waits on the paddle until Space.
                held: !!env.play,
            };
        },
        frame(ctx, env, s, dt) {
            const c = env.colors;
            ctx.fillStyle = c.bg;
            ctx.fillRect(0, 0, env.w, env.h);

            // Move the ball - unless it is sitting on the paddle waiting
            // for the serve.
            const b = s.ball;
            const paddleTop = env.h - 24;
            if (s.held) {
                b.x = s.paddleX + s.paddleW / 2;
                b.y = paddleTop - b.r - 1;
                if (env.play && env.play.fired) {
                    env.play.fired = false;
                    s.held = false;
                    b.vx = (Math.random() - 0.5) * 200;
                    b.vy = -s.speed;
                }
            } else {
                b.x += b.vx * dt;
                b.y += b.vy * dt;
            }
            if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx); }
            if (b.x > env.w - b.r) { b.x = env.w - b.r; b.vx = -Math.abs(b.vx); }
            if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy); }

            // The paddle: yours in play mode; otherwise it chases the ball
            // with just enough lag to miss now and then - a perfect paddle
            // is boring to watch.
            const paddleY = env.h - 24;
            if (env.play) {
                const dir = (env.play.right ? 1 : 0) - (env.play.left ? 1 : 0);
                s.paddleX += dir * 560 * dt;
            } else {
                const target = b.x - s.paddleW / 2 + Math.sin(b.y / 40) * 30;
                s.paddleX += Math.max(-420 * dt, Math.min(420 * dt, target - s.paddleX));
            }
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
                if (env.play) {
                    s.held = true;   // missed: back on the paddle, your serve
                } else {
                    // Missed: serve again from the middle.
                    b.x = env.w / 2; b.y = env.h * 0.7; b.vx = (Math.random() - 0.5) * 300; b.vy = -280;
                }
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
                    if (env.play) env.play.score += 10;
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
                const fresh = STYLES.bricks.init({ ...env, screen: resample() });
                if (fresh.bricks.length) Object.assign(s, fresh);
            }

            // Paddle and ball.
            ctx.fillStyle = c.txt;
            ctx.fillRect(s.paddleX, paddleY, s.paddleW, 6);
            ctx.beginPath();
            ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
            ctx.fill();
            drawHud(ctx, env);
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
                    Object.assign(s, STYLES.life.init({ ...env, screen: resample() }));
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
            ctx.fillStyle = c.ground;
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
                ctx.fillStyle = tier >= 3 ? c.ink : tier === 2 ? c.accent : c.inkDim;
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
            ctx.fillStyle = c.ground;
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
                ctx.fillStyle = f.size === 2 ? c.ink : c.inkDim;
                ctx.fillText(glyph[f.size], f.x, f.y);
            }
            ctx.fillStyle = c.ink;
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
            // Simulate at a fixed 10 Hz regardless of draw rate, so the flame
            // speed does not depend on the machine. (20 Hz read as frantic.)
            while (s.acc >= 0.1) {
                s.acc -= 0.1;
                // Fuel: the bottom row flickers near full heat.
                for (let x = 0; x < cols; x++) {
                    heat[(rows - 1) * cols + x] = 0.85 + Math.random() * 0.15;
                }
                for (let y = rows - 2; y >= 0; y--) {
                    for (let x = 0; x < cols; x++) {
                        const drift = Math.floor(Math.random() * 3) - 1;
                        const sx = Math.max(0, Math.min(cols - 1, x + drift));
                        const below = heat[(y + 1) * cols + sx];
                        // Cooling per row sets the flame height: this
                        // averages ~1/35 per row, so the fire reaches about
                        // 60% of the window instead of licking the bottom.
                        heat[y * cols + x] = Math.max(0, below - Math.random() * 0.045 - 0.006);
                    }
                }
            }
            ctx.fillStyle = c.ground;
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
                    if (t !== tier) { ctx.fillStyle = t === 2 ? c.ink : t === 1 ? c.accent : c.inkDim; tier = t; }
                    ctx.fillText(g, x * s.cw, y * s.ch);
                }
            }
        },
    };

    // Aliens: the three lineages in one. The words on screen FLY IN along
    // curves and reassemble where they were (the Galaga arrival), then march
    // as a block - left, edge, drop a row, right - speeding up as they thin
    // out (the Invaders heartbeat), while singles peel off to dive and drop
    // glyph bombs (the Galaxian swoop). An auto-piloted ship at the bottom
    // shoots back, dodges most bombs, and mistimes the occasional one, since
    // a flawless bot is boring to watch. Lives are infinite; this is a
    // screensaver, not a game.
    STYLES.aliens = {
        label: 'Aliens', screen: true,
        init(env) {
            return STYLES.aliens.wave(env, { waves: 0, ship: null, bombs: [], lasers: [], bursts: [] });
        },
        // Start a wave from whatever is on screen; a blank screen gets a
        // classic 5x11 block of glyphs so there is still something to shoot.
        wave(env, s) {
            let words = (env.screen ? env.screen.words : []).filter((w) => w.text.length > 0);
            if (words.length < 6) {
                words = [];
                const cw = 11, ch = 20;
                for (let r = 0; r < 5; r++) {
                    for (let c = 0; c < 11; c++) {
                        words.push({ text: ['<o>', '{o}', '[o]', '(o)', '-o-'][r], w: 3 * cw, h: ch,
                            x: env.w * 0.2 + c * cw * 5, y: env.h * 0.12 + r * ch * 1.6 });
                    }
                }
            }
            const aliens = words.map((w, i) => {
                // Entry curve: from a random edge, through an off-axis control
                // point, to the word's own screen position.
                const side = Math.random() < 0.5 ? -1 : 1;
                const from = Math.random() < 0.5
                    ? { x: env.w / 2 + side * (env.w / 2 + 80), y: Math.random() * env.h * 0.5 }
                    : { x: Math.random() * env.w, y: -60 };
                return {
                    text: w.text, w: w.w, h: w.h, homeX: w.x, homeY: w.y,
                    x: from.x, y: from.y, tone: i % 3, state: 'arriving',
                    arrive: { t: -i * 0.02 - Math.random() * 0.15, from,
                        ctrl: { x: (from.x + w.x) / 2 + side * 220, y: Math.min(from.y, w.y) - 140 } },
                    dive: null,
                };
            });
            const minX = Math.min(...aliens.map((a) => a.homeX));
            const maxX = Math.max(...aliens.map((a) => a.homeX + a.w));
            return Object.assign(s, {
                aliens, total: aliens.length, minX, maxX,
                ox: 0, oy: 0, dir: 1, settled: false, diveClock: 2 + Math.random() * 2,
                ship: s.ship || { x: env.w / 2, dead: 0, cool: 0, think: 0, target: env.w / 2 },
                bombs: [], lasers: [], waves: (s.waves || 0) + 1,
            });
        },
        frame(ctx, env, s, dt) {
            const c = env.colors;
            const shipY = env.h - 34;
            const shipW = 36;
            const quad = (p0, p1, p2, t) => ({
                x: (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * p1.x + t * t * p2.x,
                y: (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * p1.y + t * t * p2.y,
            });

            // --- aliens --------------------------------------------------
            let alive = 0, inFormation = 0, lowest = 0;
            for (const a of s.aliens) {
                if (a.state === 'dead') continue;
                alive++;
                if (a.state === 'arriving') {
                    a.arrive.t += dt * 0.55;
                    if (a.arrive.t >= 1) { a.state = 'formation'; }
                    else if (a.arrive.t > 0) {
                        const p = quad(a.arrive.from, a.arrive.ctrl,
                            { x: a.homeX + s.ox, y: a.homeY + s.oy }, a.arrive.t);
                        a.x = p.x; a.y = p.y;
                    }
                }
                if (a.state === 'formation') {
                    inFormation++;
                    a.x = a.homeX + s.ox;
                    a.y = a.homeY + s.oy;
                }
                if (a.state === 'diving') {
                    const d = a.dive;
                    d.t += dt / d.dur;
                    const p = quad(d.from, d.ctrl, d.to, Math.min(1, d.t));
                    a.x = p.x; a.y = p.y;
                    d.bomb -= dt;
                    if (d.bomb <= 0 && a.y < shipY - 80) {
                        d.bomb = 0.7;
                        s.bombs.push({ x: a.x + a.w / 2, y: a.y + a.h, vy: 220 });
                    }
                    if (d.t >= 1) {
                        // Back in from the top to the slot.
                        a.state = 'arriving';
                        a.arrive = { t: 0, from: { x: a.homeX + s.ox, y: -50 },
                            ctrl: { x: a.homeX + s.ox + 60, y: (a.homeY + s.oy) / 2 } };
                    }
                }
                // Only the block counts toward "reached the ship": a diver
                // swooping past the bottom is the point of diving, not an
                // invasion - measuring it restarted the wave every dive.
                if (a.state === 'formation') lowest = Math.max(lowest, a.y + a.h);
            }
            s.settled = inFormation > 0 && s.aliens.every((a) => a.state !== 'arriving' || a.arrive.t >= 1);

            // March: the whole block, faster as it thins. Edges flip the
            // direction and drop one row.
            if (inFormation) {
                const speed = 22 * (1 + 4 * (1 - alive / s.total));
                s.ox += s.dir * speed * dt;
                if (s.dir > 0 && s.maxX + s.ox > env.w - 12) { s.dir = -1; s.oy += 16; }
                if (s.dir < 0 && s.minX + s.ox < 12) { s.dir = 1; s.oy += 16; }
            }
            // Pick a diver now and then, once the formation has settled.
            if (s.settled) {
                s.diveClock -= dt;
                if (s.diveClock <= 0) {
                    s.diveClock = 1.5 + Math.random() * 2.5;
                    const pool = s.aliens.filter((a) => a.state === 'formation');
                    if (pool.length) {
                        const a = pool[Math.floor(Math.random() * pool.length)];
                        const side = Math.random() < 0.5 ? -1 : 1;
                        a.state = 'diving';
                        a.dive = {
                            t: 0, dur: 2.2 + Math.random(), bomb: 0.3,
                            from: { x: a.x, y: a.y },
                            ctrl: { x: a.x + side * 320, y: a.y + (shipY - a.y) * 0.6 },
                            to: { x: s.ship.x - side * 120, y: env.h + 40 },
                        };
                    }
                }
            }

            // --- the ship ------------------------------------------------
            const ship = s.ship;
            if (ship.dead > 0) {
                ship.dead -= dt;
            } else if (env.play) {
                const dir = (env.play.right ? 1 : 0) - (env.play.left ? 1 : 0);
                ship.x += dir * 400 * dt;
                ship.x = Math.max(shipW, Math.min(env.w - shipW, ship.x));
                ship.cool -= dt;
                if (env.play.fired) {
                    env.play.fired = false;
                    if (ship.cool <= 0) {
                        ship.cool = 0.22;
                        s.lasers.push({ x: ship.x, y: shipY - 6, vy: -540 });
                    }
                }
            } else {
                ship.think -= dt;
                if (ship.think <= 0) {
                    // Re-aim every quarter second, not every frame: the lag is
                    // what makes it occasionally late.
                    ship.think = 0.25;
                    const threat = s.bombs.find((b) => b.y > shipY - 140 && Math.abs(b.x - ship.x) < 34);
                    if (threat) {
                        ship.target = ship.x + (threat.x > ship.x ? -110 : 110);
                    } else {
                        let best = null;
                        for (const a of s.aliens) {
                            if (a.state === 'dead' || a.state === 'arriving') continue;
                            if (!best || a.y > best.y) best = a;
                        }
                        ship.target = best ? best.x + best.w / 2 : env.w / 2;
                    }
                }
                const step = 330 * dt;
                ship.x += Math.max(-step, Math.min(step, ship.target - ship.x));
                ship.x = Math.max(shipW, Math.min(env.w - shipW, ship.x));
                ship.cool -= dt;
                if (ship.cool <= 0) {
                    ship.cool = 0.42;
                    s.lasers.push({ x: ship.x, y: shipY - 6, vy: -540 });
                }
            }

            // --- projectiles -----------------------------------------------
            for (const b of s.bombs) b.y += b.vy * dt;
            for (const l of s.lasers) l.y += l.vy * dt;
            if (ship.dead <= 0) {
                const hit = s.bombs.find((b) => Math.abs(b.x - ship.x) < shipW / 2 && b.y >= shipY - 8 && b.y <= shipY + 12);
                if (hit) {
                    hit.y = env.h + 99;
                    ship.dead = 1.4;
                    s.bursts.push({ x: ship.x, y: shipY, t: 0.6, big: true });
                }
            }
            for (const l of s.lasers) {
                if (l.y < -10) continue;
                for (const a of s.aliens) {
                    if (a.state === 'dead' || a.state === 'arriving') continue;
                    if (l.x >= a.x && l.x <= a.x + a.w && l.y >= a.y && l.y <= a.y + a.h) {
                        a.state = 'dead';
                        if (env.play) env.play.score += 10;
                        l.y = -99;
                        s.bursts.push({ x: a.x + a.w / 2, y: a.y + a.h / 2, t: 0.35, big: false });
                        break;
                    }
                }
            }
            s.bombs = s.bombs.filter((b) => b.y < env.h + 20);
            s.lasers = s.lasers.filter((l) => l.y > -20);
            for (const k of s.bursts) k.t -= dt;
            s.bursts = s.bursts.filter((k) => k.t > 0);

            // Wave over - cleared, or the block reached the ship - so read
            // the screen again and fly the next one in.
            if (alive === 0 || (s.settled && lowest >= shipY - 20)) {
                STYLES.aliens.wave({ ...env, screen: resample() }, s);
            }

            // --- draw ------------------------------------------------------
            ctx.fillStyle = c.bg;
            ctx.fillRect(0, 0, env.w, env.h);
            ctx.textBaseline = 'top';
            const fontPx = Math.max(10, Math.round(((s.aliens[0] || { h: 16 }).h) * 0.75));
            ctx.font = `${fontPx}px ${c.mono}`;
            for (const a of s.aliens) {
                if (a.state === 'dead') continue;
                if (a.state === 'arriving' && a.arrive.t <= 0) continue;
                ctx.fillStyle = a.state === 'diving' ? c.txt
                    : a.tone === 0 ? c.accent : a.tone === 1 ? c.up : c.warn;
                ctx.fillText(a.text, a.x, a.y + 2);
            }
            ctx.fillStyle = c.warn;
            for (const b of s.bombs) ctx.fillText(':', b.x - 3, b.y);
            ctx.fillStyle = c.txt;
            for (const l of s.lasers) ctx.fillText('|', l.x - 3, l.y);
            for (const k of s.bursts) {
                ctx.fillStyle = k.big ? c.down : c.warn;
                ctx.font = `${k.big ? fontPx * 2 : fontPx}px ${c.mono}`;
                ctx.fillText(k.big ? '* * *' : '*', k.x - (k.big ? fontPx * 1.5 : fontPx / 3), k.y - fontPx / 2);
            }
            if (ship.dead <= 0) {
                ctx.font = `${fontPx + 4}px ${c.mono}`;
                ctx.fillStyle = c.txt;
                ctx.fillText('<^>', ship.x - (fontPx + 4) * 0.9, shipY);
            }
            drawHud(ctx, env);
        },
    };

    window.Idle = {
        start, stop,
        isPlaying: () => !!(running && running.play),
        isRunning: () => !!running,
        // Frames drawn since load - the honest way to measure the loop.
        frameCount: () => frames,
        // The running style's state, for probes that want to assert on
        // behavior (a wave thinned, a diver launched) rather than pixels.
        debugState: () => (running ? running.state : null),
        // Whether the OS is asking for reduced motion - shown in Settings,
        // never used to refuse an explicit opt-in.
        reducedMotion: () => reducedMotion,
        styles: () => Object.entries(STYLES).map(([id, s]) => ({ id, label: s.label })),
    };
})();
