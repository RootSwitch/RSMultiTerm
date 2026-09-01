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
            // Panes is the default: an animation that keeps the sidebar,
            // tabs and toolbar visible reads as part of the app, where a
            // full-window takeover reads as "something has gone wrong".
            area: i.area === 'window' ? 'window' : 'panes',
            // Which styles "Surprise me" may pick. Empty means all of them.
            picks: Array.isArray(i.picks) ? i.picks : [],
            // Minutes before "Surprise me" moves to another style. 0 = stay
            // on the one it picked.
            rotate: Math.max(0, Math.min(240, Number(i.rotateMinutes) || 0)),
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
        if (Date.now() - lastActivity < settings.minutes * 60 * 1000) return;
        // Re-read settings at the moment of starting rather than trusting
        // the cached copy: a change saved during this run must apply now,
        // not after a restart.
        rsterm.invoke('rs:settings.get').then((s) => {
            applySettings(s);
            if (!running && settings.style !== 'off') start(settings.style);
        });
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
        const rects = [];
        const tab = window.Tabs && window.TermPanes && window.Tabs.active();
        for (const sid of (tab ? tab.sessionIds : [])) {
            const pane = window.TermPanes.panes.get(sid);
            if (!pane || !pane.host || !pane.host.isConnected) continue;
            const r = pane.host.getBoundingClientRect();
            if (r.width > 10 && r.height > 10) rects.push(r);
        }
        // Nothing open. This used to return null, and the caller reads null
        // as "the whole window" - so picking "terminal panes only" and then
        // idling with no session connected produced a full-screen takeover
        // and a setting that looked like it had not saved. Reported twice,
        // both times with no panes up. The terminal AREA exists whether or
        // not a session does, so play in that and leave the chrome alone.
        if (!rects.length) {
            const grid = document.getElementById('grid');
            const r = grid && grid.getBoundingClientRect();
            if (!r || r.width < 40 || r.height < 40) return null;
            return { x: r.left, y: r.top, w: r.width, h: r.height, rects: [r] };
        }
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
        const all = Object.keys(STYLES);
        const chosen = settings.picks.filter((p) => STYLES[p]);
        // No preference means "everything meant to be a surprise" - a style
        // marked surprise:false (the clock) joins only when ticked by name,
        // because a surprise clock is just a clock.
        const pool = chosen.length ? chosen
            : all.filter((id) => STYLES[id].surprise !== false);
        // On a rotation, do not draw the style that just finished - with two
        // or three ticked, chance alone repeats often enough to look stuck.
        const avoid = opts && opts.avoid;
        const draw = (avoid && pool.length > 1) ? pool.filter((p) => p !== avoid) : pool;
        const id = styleId === 'random' || !STYLES[styleId]
            ? draw[Math.floor(Math.random() * draw.length)] : styleId;
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
        const areaChoice = (opts && opts.area) || settings.area;
        const region = areaChoice === 'panes' ? paneRegion() : null;
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
        env.play = play ? { left: false, right: false, up: false, down: false, fire: false, fired: false, score: 0 } : null;
        running = { canvas, ctx, style, env, region, state: style.init(env), raf: 0, lastFrame: 0,
            id, play, areaChoice,
            // Only "Surprise me" rotates - a chosen style changing itself
            // would be the app overruling the choice. A game never does.
            rotateAt: (!play && styleId === 'random' && settings.rotate)
                ? Date.now() + settings.rotate * 60000 : 0 };
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
            ? `${style.label}: ${style.playHint ||
                'arrows or A/D move, Space fires, Esc or a click quits'}`
            : `idle: ${style.label} - any key or mouse movement to return`);
    }

    function stop(opts) {
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
        // A rotation is not the user coming back: leave the focus and the
        // status line alone, because the next style is about to claim both.
        if (opts && opts.quiet) return;
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
                : (e.code === 'ArrowUp' || e.code === 'KeyW') ? 'up'
                    : (e.code === 'ArrowDown' || e.code === 'KeyS') ? 'down'
                        : e.code === 'Space' ? 'fire' : null;
        if (!k) return;
        const down = e.type === 'keydown';
        if (k === 'fire' && down && !input.fire) input.fired = true;   // an edge, consumed by the style
        input[k] = down;
    }
    function onWakeMouse() { stop(); }

    // "Surprise me" moving on by itself. The idle clock is not restarted -
    // the user has not touched anything - and start() sets `running` before
    // this returns, so the 5s idle check cannot race a second animation in.
    function rotate() {
        const prev = running.id;
        const area = running.areaChoice;
        stop({ quiet: true });
        start('random', { area, avoid: prev });
    }
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
    // Cumulative time spent INSIDE the styles' own drawing, for
    // tools/bench-idle.js. Two clock reads at 30fps is not a cost worth
    // gating behind a flag, and a number nobody can measure is a number
    // nobody can defend.
    let frameMs = 0;
    function frame(now) {
        if (!running) return;
        running.raf = requestAnimationFrame(frame);
        // A dialog the app raised must never sit hidden under an animation.
        if ((frames++ & 15) === 0 && document.querySelector('.modal-backdrop')) { stop(); return; }
        // Wall-clock, not the rAF timestamp: this is a minutes-scale
        // deadline and the loop stops dead while the window is hidden.
        if (running.rotateAt && Date.now() >= running.rotateAt) { rotate(); return; }
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
        const t0 = performance.now();
        running.style.frame(ctx, running.env, running.state, dt);
        frameMs += performance.now() - t0;
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
        ctx.fillText(env.playHint || 'arrows / WASD steer   space fires   esc quits',
            12, env.h - 20);
    }

    // The Extras menu: every effect on demand, and the two games to play.
    // Sits on the quick-connect row under the theme picker, where the
    // decorative controls live.
    function extrasMenu(anchor) {
        const r = anchor.getBoundingClientRect();
        // Both lists are DERIVED and sorted. Derived, so a style marked
        // playable cannot be forgotten here (Blocks was added to four
        // places); sorted, because the order was previously "whichever was
        // written first", which is findable only by the person who wrote
        // it. Fifteen effects in authoring order is a list you scan twice.
        const byLabel = (a, b) => a[1].label.localeCompare(b[1].label);
        const all = Object.entries(STYLES).sort(byLabel);
        const items = [];
        for (const [id, st] of all.filter(([, st2]) => st2.playable)) {
            items.push({ label: `Play ${st.label}`,
                onClick: () => start(id, { play: true, area: settings.area }) });
        }
        items.push(null);
        for (const [id, st] of all) {
            items.push({ label: `Effect: ${st.label}`, onClick: () => start(id, { area: settings.area }) });
        }
        items.push(null, {
            label: 'Idle Animation Settings...',
            onClick: () => window.SettingsUI && window.SettingsUI.openSettings(),
        }, {
            // The same knob as Settings > Play over, surfaced here so people
            // learn that "just the terminal panes" exists at all. Writes the
            // setting; the Settings dialog reads it back on open.
            label: 'Full screen animation',
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
        label: 'Rain', screen: true, mood: 'calm',
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
        label: 'Bricks', screen: true, mood: 'lively', playable: true,
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
        label: 'Life', screen: true, mood: 'calm',
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
        label: 'Starfield', screen: false, mood: 'calm',
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
        label: 'Snow', screen: false, mood: 'calm',
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
        label: 'Fire', screen: false, mood: 'lively',
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
        label: 'Aliens', screen: true, mood: 'lively', playable: true,
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


    // --- Pipes --------------------------------------------------------------
    // pipes.sh, in box-drawing characters on the theme's palette. Each pipe
    // walks a cell grid, turns at random, and when the screen fills the
    // whole thing clears and starts over - which is exactly the rhythm of
    // the original, and the reason it is hypnotic rather than busy.
    STYLES.pipes = {
        label: 'Pipes', screen: false, mood: 'calm',
        init(env) {
            // cw and ch are corrected on the first frame from the font's
            // real metrics. Box-drawing glyphs only join into continuous
            // pipes when the grid pitch IS the glyph pitch: guess it and
            // every horizontal run comes out dashed.
            const cw = 12, chh = 18;
            const cols = Math.max(4, Math.floor(env.w / cw));
            const rows = Math.max(4, Math.floor(env.h / chh));
            const palette = [env.colors.accent, env.colors.up, env.colors.warn,
                env.colors.txt, env.colors.down];
            const mk = () => ({
                x: Math.floor(Math.random() * cols), y: Math.floor(Math.random() * rows),
                dir: Math.floor(Math.random() * 4),
                color: palette[Math.floor(Math.random() * palette.length)],
            });
            return {
                cw, ch: chh, cols, rows, palette, mk,
                pipes: Array.from({ length: 4 }, mk),
                drawn: 0, budget: cols * rows * 0.75, step: 0, first: true,
            };
        },
        frame(ctx, env, s, dt) {
            const c = env.colors;
            if (s.first) {
                // The font size IS the row pitch so vertical bars meet top
                // to bottom, and the measured advance IS the column pitch
                // so horizontals meet end to end.
                ctx.font = `${s.ch}px ${c.mono}`;
                const adv = ctx.measureText('─').width;
                if (adv > 1) {
                    s.cw = adv;
                    s.cols = Math.max(4, Math.floor(env.w / adv));
                }
                ctx.fillStyle = c.ground;
                ctx.fillRect(0, 0, env.w, env.h);
                s.first = false;
                s.budget = s.cols * s.rows * 0.75;
            }
            // Fixed cadence: pipes advance on a clock, not per frame, or
            // they scribble the screen full in a second on a fast machine.
            s.step += dt;
            const stepEvery = 0.055;
            if (s.step < stepEvery) return;
            s.step = 0;

            ctx.font = `${s.ch}px ${c.mono}`;
            ctx.textBaseline = 'top';
            // 0=up 1=right 2=down 3=left. The glyph is chosen by the turn:
            // straight runs get a line, turns get the matching corner.
            const STRAIGHT = ['│', '─', '│', '─'];
            const CORNER = {
                '0,1': '┌', '3,2': '┌',
                '0,3': '┐', '1,2': '┐',
                '2,1': '└', '3,0': '└',
                '1,0': '┘', '2,3': '┘',
            };
            for (const p of s.pipes) {
                const was = p.dir;
                // Mostly straight, sometimes a right angle - never a
                // reversal, which would draw over itself.
                if (Math.random() < 0.18) {
                    p.dir = Math.random() < 0.5 ? (p.dir + 1) % 4 : (p.dir + 3) % 4;
                }
                const glyph = was === p.dir ? STRAIGHT[p.dir] : (CORNER[`${was},${p.dir}`] || STRAIGHT[p.dir]);
                ctx.fillStyle = p.color;
                ctx.fillText(glyph, p.x * s.cw, p.y * s.ch);
                s.drawn++;
                if (p.dir === 0) p.y--;
                else if (p.dir === 1) p.x++;
                else if (p.dir === 2) p.y++;
                else p.x--;
                // Off the edge: respawn somewhere else rather than wrapping,
                // which would leave a pipe crossing the whole screen.
                if (p.x < 0 || p.y < 0 || p.x >= s.cols || p.y >= s.rows) {
                    Object.assign(p, s.mk());
                }
            }
            if (s.drawn > s.budget) {
                ctx.fillStyle = c.ground;
                ctx.fillRect(0, 0, env.w, env.h);
                s.drawn = 0;
                s.pipes = Array.from({ length: 3 + Math.floor(Math.random() * 3) }, s.mk);
            }
        },
    };

    // --- Snake --------------------------------------------------------------
    // Eats the glyphs of your own output. Plays itself when idle - a
    // deliberately simple greedy chase, which is more watchable than a
    // perfect solver - and takes the keyboard when started from Extras.
    STYLES.snake = {
        label: 'Snake', screen: true, mood: 'lively', playable: true,
        init(env) {
            const cw = 14, chh = 18;
            const cols = Math.max(10, Math.floor(env.w / cw));
            const rows = Math.max(8, Math.floor(env.h / chh));
            const glyphs = env.screen && env.screen.glyphs.size > 6
                ? [...env.screen.glyphs].filter((g) => g.trim())
                : [...'$#@%&*+=?!0123456789abcdef'];
            // Food sits WHERE THE TEXT IS. Scattering the right glyphs at
            // random positions looked like confetti; placing them on the
            // real character cells means the snake eats your last command's
            // output, in place, which is the whole idea. One cell per
            // character, thinned so the board is playable rather than solid.
            const food = [];
            const taken = new Set();
            for (const line of (env.screen ? env.screen.lines : [])) {
                if (!line.cw || !line.ch) continue;
                for (let i = 0; i < line.text.length; i++) {
                    const g = line.text[i];
                    if (!g.trim()) continue;
                    if (Math.random() > 0.45) continue;   // thin it out
                    const gx = Math.floor((line.x + i * line.cw) / cw);
                    const gy = Math.floor(line.y / chh);
                    if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) continue;
                    const key = `${gx},${gy}`;
                    if (taken.has(key)) continue;
                    taken.add(key);
                    food.push({ x: gx, y: gy, g });
                }
            }
            // A blank screen still gets something to chase.
            const want = Math.max(14, Math.floor(cols * rows * 0.02));
            while (food.length < want) {
                const gx = Math.floor(Math.random() * cols);
                const gy = Math.floor(Math.random() * rows);
                const key = `${gx},${gy}`;
                if (taken.has(key)) continue;
                taken.add(key);
                food.push({ x: gx, y: gy, g: glyphs[Math.floor(Math.random() * glyphs.length)] || '*' });
            }
            const head = { x: Math.floor(cols / 2), y: Math.floor(rows / 2) };
            return {
                cw, ch: chh, cols, rows, glyphs, food,
                body: [head], dir: { x: 1, y: 0 }, grow: 4,
                step: 0, every: 0.085, dead: 0, eaten: 0,
            };
        },
        frame(ctx, env, s, dt) {
            const c = env.colors;
            ctx.fillStyle = c.bg;
            ctx.fillRect(0, 0, env.w, env.h);

            s.step += dt;
            if (s.step >= s.every) {
                s.step = 0;
                if (s.dead > 0) {
                    // A beat on the crash, then start over.
                    s.dead--;
                    if (s.dead === 0) Object.assign(s, STYLES.snake.init(env));
                } else {
                    STYLES.snake.advance(env, s);
                }
            }

            ctx.font = `${s.ch - 3}px ${c.mono}`;
            ctx.textBaseline = 'top';
            for (const f of s.food) {
                ctx.fillStyle = c.dim;
                ctx.fillText(f.g, f.x * s.cw, f.y * s.ch);
            }
            s.body.forEach((seg, i) => {
                ctx.fillStyle = i === 0 ? c.up : c.accent;
                ctx.fillText(i === 0 ? '■' : '▪', seg.x * s.cw, seg.y * s.ch);
            });
            if (env.play) {
                ctx.font = `13px ${c.mono}`;
                ctx.fillStyle = c.dim;
                ctx.textAlign = 'left';
                ctx.fillText(`eaten ${s.eaten}`, 12, 10);
                ctx.textAlign = 'left';
            }
            drawHud(ctx, env);
        },
        // One grid step. Player input steers when playing; otherwise a
        // greedy chase toward the nearest food, refusing only the moves
        // that would eat its own neck.
        advance(env, s) {
            const p = env.play;
            if (p) {
                // Absolute directions: up is up, whatever way the snake was
                // going. The first version used relative turns, which read
                // as broken - nothing on screen says which way "left" is
                // when you are travelling down. Reversals are ignored (the
                // axis check), so pressing back into the neck does nothing.
                if (p.up && s.dir.y === 0) s.dir = { x: 0, y: -1 };
                else if (p.down && s.dir.y === 0) s.dir = { x: 0, y: 1 };
                else if (p.left && s.dir.x === 0) s.dir = { x: -1, y: 0 };
                else if (p.right && s.dir.x === 0) s.dir = { x: 1, y: 0 };
            } else {
                const head = s.body[0];
                let best = null;
                let bestD = Infinity;
                for (const f of s.food) {
                    const d = Math.abs(f.x - head.x) + Math.abs(f.y - head.y);
                    if (d < bestD) { bestD = d; best = f; }
                }
                if (best) {
                    const occupied = new Set(s.body.map((b) => `${b.x},${b.y}`));
                    const options = [
                        { x: Math.sign(best.x - head.x), y: 0 },
                        { x: 0, y: Math.sign(best.y - head.y) },
                        s.dir, { x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 },
                    ].filter((d) => d.x || d.y);
                    for (const d of options) {
                        const nx = head.x + d.x;
                        const ny = head.y + d.y;
                        if (nx < 0 || ny < 0 || nx >= s.cols || ny >= s.rows) continue;
                        if (occupied.has(`${nx},${ny}`)) continue;
                        s.dir = d;
                        break;
                    }
                }
            }

            const head = s.body[0];
            const next = { x: head.x + s.dir.x, y: head.y + s.dir.y };
            if (next.x < 0 || next.y < 0 || next.x >= s.cols || next.y >= s.rows ||
                s.body.some((b) => b.x === next.x && b.y === next.y)) {
                s.dead = 8;
                return;
            }
            s.body.unshift(next);
            const hit = s.food.findIndex((f) => f.x === next.x && f.y === next.y);
            if (hit >= 0) {
                s.food.splice(hit, 1);
                s.grow += 2;
                s.eaten++;
                if (env.play) env.play.score += 10;
                // Keep the board stocked, from the same glyph pool.
                s.food.push({
                    x: Math.floor(Math.random() * s.cols), y: Math.floor(Math.random() * s.rows),
                    g: s.glyphs[Math.floor(Math.random() * s.glyphs.length)] || '*',
                });
            }
            if (s.grow > 0) s.grow--;
            else s.body.pop();
        },
    };


    // --- Aquarium -----------------------------------------------------------
    // asciiquarium's spirit: fish in both directions, bubbles, and - the
    // screen-aware touch - the words the terminal was showing become the
    // seaweed, swaying at the bottom in the theme's up-color.

    // Blocks: falling tetrads, themed. Idle mode plays ITSELF - a small
    // placement heuristic (the classic height/lines/holes/bumpiness
    // weights) picks a target and steers toward it, which is endlessly
    // watchable in the way of an arcade cabinet running its demo. Play
    // mode is the game everyone already knows: left/right move, up
    // rotates, down hurries, Space slams.
    STYLES.blocks = {
        label: 'Blocks', screen: false, mood: 'lively', playable: true,
        playHint: 'left/right move   up rotates   down hurries   space slams   esc quits',
        // Each piece: rotation states as [x,y] cells, plus which theme
        // color paints it - the board matches the app instead of fighting
        // it.
        PIECES: [
            { rots: [[[0,1],[1,1],[2,1],[3,1]], [[2,0],[2,1],[2,2],[2,3]]], color: 'accent' },
            { rots: [[[1,0],[2,0],[1,1],[2,1]]], color: 'warn' },
            { rots: [[[1,0],[0,1],[1,1],[2,1]], [[1,0],[1,1],[2,1],[1,2]],
                [[0,1],[1,1],[2,1],[1,2]], [[1,0],[0,1],[1,1],[1,2]]], color: 'txt' },
            { rots: [[[1,0],[2,0],[0,1],[1,1]], [[1,0],[1,1],[2,1],[2,2]]], color: 'up' },
            { rots: [[[0,0],[1,0],[1,1],[2,1]], [[2,0],[1,1],[2,1],[1,2]]], color: 'down' },
            { rots: [[[0,0],[0,1],[1,1],[2,1]], [[1,0],[2,0],[1,1],[1,2]],
                [[0,1],[1,1],[2,1],[2,2]], [[1,0],[1,1],[0,2],[1,2]]], color: 'dim' },
            { rots: [[[2,0],[0,1],[1,1],[2,1]], [[1,0],[1,1],[1,2],[2,2]],
                [[0,1],[1,1],[2,1],[0,2]], [[0,0],[1,0],[1,1],[1,2]]], color: 'accent' },
        ],
        COLS: 10,
        ROWS: 20,

        cells(piece, rot, x, y) {
            const shape = piece.rots[rot % piece.rots.length];
            return shape.map(([cx, cy]) => [cx + x, cy + y]);
        },
        fits(s, piece, rot, x, y) {
            for (const [cx, cy] of STYLES.blocks.cells(piece, rot, x, y)) {
                if (cx < 0 || cx >= STYLES.blocks.COLS || cy >= STYLES.blocks.ROWS) return false;
                if (cy >= 0 && s.board[cy][cx]) return false;
            }
            return true;
        },
        spawn(s, env) {
            // A 7-bag, like the real thing: every piece once per seven, so
            // the drought that makes randomness feel broken cannot happen.
            if (!s.bag.length) {
                s.bag = [0, 1, 2, 3, 4, 5, 6];
                for (let i = s.bag.length - 1; i > 0; i--) {
                    const j = Math.floor(env.rnd() * (i + 1));
                    const t = s.bag[i]; s.bag[i] = s.bag[j]; s.bag[j] = t;
                }
            }
            s.cur = { idx: s.next, rot: 0, x: 3, y: -1 };
            s.next = s.bag.pop();
            s.plan = null;
            if (!STYLES.blocks.fits(s, STYLES.blocks.PIECES[s.cur.idx], 0, 3, -1)) s.over = 90;
        },
        lock(s, env) {
            const b = STYLES.blocks;
            const piece = b.PIECES[s.cur.idx];
            for (const [cx, cy] of b.cells(piece, s.cur.rot, s.cur.x, s.cur.y)) {
                if (cy < 0) { s.over = 90; return; }
                s.board[cy][cx] = piece.color;
            }
            const kept = s.board.filter((row) => row.some((c) => !c));
            const cleared = b.ROWS - kept.length;
            if (cleared) {
                while (kept.length < b.ROWS) kept.unshift(Array(b.COLS).fill(null));
                s.board = kept;
                s.lines += cleared;
                if (env.play) env.play.score += [0, 100, 300, 500, 800][cleared];
            }
            b.spawn(s, env);
        },
        // Where this piece rests if dropped in column x at rotation rot.
        dropY(s, piece, rot, x) {
            let y = -2;
            while (STYLES.blocks.fits(s, piece, rot, x, y + 1)) y++;
            return y;
        },
        // The self-player: try every rotation and column, score the board
        // each would leave, take the best. The weights are the well-known
        // set that plays essentially forever - the point of a screensaver.
        think(s) {
            const b = STYLES.blocks;
            const piece = b.PIECES[s.cur.idx];
            let best = null;
            for (let rot = 0; rot < piece.rots.length; rot++) {
                for (let x = -2; x < b.COLS; x++) {
                    const y = b.dropY(s, piece, rot, x);
                    if (!b.fits(s, piece, rot, x, y)) continue;
                    const board = s.board.map((row) => row.slice());
                    for (const [cx, cy] of b.cells(piece, rot, x, y)) {
                        if (cy >= 0) board[cy][cx] = true;
                    }
                    let lines = 0;
                    for (const row of board) { if (row.every(Boolean)) lines++; }
                    let height = 0;
                    let holes = 0;
                    let bump = 0;
                    let prev = -1;
                    for (let cx = 0; cx < b.COLS; cx++) {
                        let top = b.ROWS;
                        for (let cy = 0; cy < b.ROWS; cy++) {
                            if (board[cy][cx]) { top = cy; break; }
                        }
                        const h = b.ROWS - top;
                        height += h;
                        for (let cy = top + 1; cy < b.ROWS; cy++) {
                            if (!board[cy][cx]) holes++;
                        }
                        if (prev >= 0) bump += Math.abs(h - prev);
                        prev = h;
                    }
                    const score = -0.51 * height + 0.76 * lines - 0.36 * holes - 0.18 * bump;
                    if (!best || score > best.score) best = { rot, x, score };
                }
            }
            return best || { rot: s.cur.rot, x: s.cur.x };
        },
        init(env) {
            const b = STYLES.blocks;
            const cell = Math.max(8, Math.floor(Math.min(
                (env.h - 24) / b.ROWS, env.w / (b.COLS + 12))));
            const s = {
                board: Array.from({ length: b.ROWS }, () => Array(b.COLS).fill(null)),
                bag: [], next: 0, cur: null, plan: null,
                lines: 0, over: 0, overStay: false,
                cell,
                ox: Math.floor((env.w - b.COLS * cell) / 2),
                oy: Math.floor((env.h - b.ROWS * cell) / 2),
                fall: 0, moveHeld: -1, rotHeld: false,
            };
            b.spawn(s, env);   // fills next from the first bag...
            b.spawn(s, env);   // ...and deals the first current piece
            s.over = 0;
            return s;
        },
        frame(ctx, env, s, dt) {
            const b = STYLES.blocks;
            const c = env.colors;
            const p = env.play;
            ctx.fillStyle = c.night || c.bg;
            ctx.fillRect(0, 0, env.w, env.h);

            if (s.over > 0) {
                s.over--;
                if (s.over === 0) {
                    if (p) s.overStay = true;
                    else Object.assign(s, b.init(env));
                }
            }
            const piece = s.cur && b.PIECES[s.cur.idx];
            const stopped = s.over > 0 || s.overStay;

            if (!stopped && piece) {
                if (p) {
                    // The player. Held keys repeat at a walk; edges act now.
                    s.moveHeld -= dt;
                    const step = (dx) => {
                        if (b.fits(s, piece, s.cur.rot, s.cur.x + dx, s.cur.y)) s.cur.x += dx;
                        s.moveHeld = s.moveHeld < -0.5 ? 0.17 : 0.09;
                    };
                    if (p.left && !p.right && s.moveHeld <= 0) step(-1);
                    if (p.right && !p.left && s.moveHeld <= 0) step(1);
                    if (!p.left && !p.right) s.moveHeld = -1;
                    if (p.up && !s.rotHeld) {
                        // One rotation per press, with the sideways nudge
                        // that makes rotating against a wall feel fair.
                        for (const kick of [0, -1, 1, -2, 2]) {
                            if (b.fits(s, piece, s.cur.rot + 1, s.cur.x + kick, s.cur.y)) {
                                s.cur.rot = (s.cur.rot + 1) % piece.rots.length;
                                s.cur.x += kick;
                                break;
                            }
                        }
                    }
                    s.rotHeld = p.up;
                    if (p.fired) {
                        p.fired = false;
                        s.cur.y = b.dropY(s, piece, s.cur.rot, s.cur.x);
                        b.lock(s, env);
                    }
                    const speed = Math.max(0.08, 0.8 - Math.floor(s.lines / 10) * 0.07);
                    s.fall += dt;
                    if (s.fall >= (p.down ? 0.04 : speed)) {
                        s.fall = 0;
                        if (b.fits(s, piece, s.cur.rot, s.cur.x, s.cur.y + 1)) s.cur.y++;
                        else b.lock(s, env);
                    }
                } else {
                    // The self-player: decide once per piece, then walk it
                    // there one considered move at a time - watching it
                    // THINK is the show, and a teleport has no drama.
                    if (!s.plan) s.plan = b.think(s);
                    s.fall += dt;
                    if (s.fall >= 0.06) {
                        s.fall = 0;
                        if (s.cur.rot !== s.plan.rot &&
                            b.fits(s, piece, s.cur.rot + 1, s.cur.x, s.cur.y)) {
                            s.cur.rot = (s.cur.rot + 1) % piece.rots.length;
                        } else if (s.cur.x < s.plan.x &&
                            b.fits(s, piece, s.cur.rot, s.cur.x + 1, s.cur.y)) {
                            s.cur.x++;
                        } else if (s.cur.x > s.plan.x &&
                            b.fits(s, piece, s.cur.rot, s.cur.x - 1, s.cur.y)) {
                            s.cur.x--;
                        } else if (b.fits(s, piece, s.cur.rot, s.cur.x, s.cur.y + 1)) {
                            s.cur.y++;
                        } else {
                            b.lock(s, env);
                        }
                    }
                }
            }
            if (s.overStay && p && p.fired) {
                p.fired = false;
                const score = p.score;
                Object.assign(s, b.init(env));
                p.score = score;
            }

            // The well.
            ctx.strokeStyle = c.dim;
            ctx.lineWidth = 1;
            ctx.strokeRect(s.ox - 1.5, s.oy - 1.5, b.COLS * s.cell + 3, b.ROWS * s.cell + 3);
            const paint = (cx, cy, color, ghost) => {
                if (cy < 0) return;
                ctx.fillStyle = color;
                ctx.globalAlpha = ghost ? 0.22 : 1;
                ctx.fillRect(s.ox + cx * s.cell + 1, s.oy + cy * s.cell + 1,
                    s.cell - 2, s.cell - 2);
                ctx.globalAlpha = 1;
            };
            for (let cy = 0; cy < b.ROWS; cy++) {
                for (let cx = 0; cx < b.COLS; cx++) {
                    if (s.board[cy][cx]) paint(cx, cy, c[s.board[cy][cx]] || c.txt);
                }
            }
            if (piece && !stopped) {
                // The ghost: where it lands, faint - players expect it, and
                // in idle mode it telegraphs the machine's intention.
                const gy = b.dropY(s, piece, s.cur.rot, s.cur.x);
                for (const [cx, cy] of b.cells(piece, s.cur.rot, s.cur.x, gy)) {
                    paint(cx, cy, c[piece.color] || c.txt, true);
                }
                for (const [cx, cy] of b.cells(piece, s.cur.rot, s.cur.x, s.cur.y)) {
                    paint(cx, cy, c[piece.color] || c.txt);
                }
            }
            // The next piece, parked beside the well.
            const nx = s.ox + b.COLS * s.cell + Math.floor(s.cell * 1.2);
            ctx.font = `12px ${c.mono}`;
            ctx.textBaseline = 'top';
            ctx.textAlign = 'left';
            ctx.fillStyle = c.dim;
            ctx.fillText('next', nx, s.oy);
            const np = b.PIECES[s.next];
            for (const [cx, cy] of np.rots[0]) {
                ctx.fillStyle = c[np.color] || c.txt;
                ctx.fillRect(nx + cx * s.cell * 0.7, s.oy + 18 + cy * s.cell * 0.7,
                    s.cell * 0.7 - 2, s.cell * 0.7 - 2);
            }
            ctx.fillStyle = c.dim;
            ctx.fillText(`lines ${s.lines}`, nx, s.oy + 18 + s.cell * 3);
            if (stopped) {
                ctx.fillStyle = c.txt;
                ctx.font = `bold ${Math.max(16, s.cell)}px ${c.mono}`;
                ctx.textAlign = 'center';
                ctx.fillText('game over',
                    s.ox + b.COLS * s.cell / 2, s.oy + b.ROWS * s.cell * 0.42);
                if (p) {
                    ctx.font = `12px ${c.mono}`;
                    ctx.fillStyle = c.dim;
                    ctx.fillText('space deals again', s.ox + b.COLS * s.cell / 2,
                        s.oy + b.ROWS * s.cell * 0.42 + s.cell + 8);
                }
            }
            if (p) { env.playHint = STYLES.blocks.playHint; drawHud(ctx, env); }
        },
    };

    STYLES.aquarium = {
        label: 'Aquarium', screen: true, mood: 'calm',
        init(env) {
            const palette = ['accent', 'up', 'warn', 'txt', 'down'];
            const fish = Array.from({ length: 9 + Math.floor(Math.random() * 5) }, () => {
                const right = Math.random() < 0.5;
                return {
                    right,
                    art: right ? '><((*>' : '<*))><',
                    x: Math.random() * env.w,
                    y: 30 + Math.random() * Math.max(60, env.h - 140),
                    v: (18 + Math.random() * 55) * (right ? 1 : -1),
                    bob: Math.random() * Math.PI * 2,
                    tone: palette[Math.floor(Math.random() * palette.length)],
                    bubbleT: Math.random() * 4,
                };
            });
            // Seaweed anchored where words were; a blank screen grows its
            // own kelp at random roots.
            let roots = (env.screen ? env.screen.words : [])
                .filter((w) => w.text.length >= 3).map((w) => ({ x: w.x, text: w.text }));
            if (roots.length < 5) {
                roots = Array.from({ length: 8 }, () => ({
                    x: Math.random() * env.w, text: '(((((((' }));
            }
            const weeds = roots.slice(0, 16).map((r) => ({
                x: Math.min(env.w - 12, Math.max(6, r.x)),
                glyphs: [...r.text].filter((g) => g.trim()).slice(0, 8),
                sway: Math.random() * Math.PI * 2,
            }));
            return { fish, weeds, bubbles: [], t: 0 };
        },
        frame(ctx, env, s, dt) {
            const c = env.colors;
            s.t += dt;
            ctx.fillStyle = c.ground;
            ctx.fillRect(0, 0, env.w, env.h);
            ctx.textBaseline = 'middle';

            // Seaweed first, behind everything.
            ctx.font = `13px ${c.mono}`;
            for (const w of s.weeds) {
                for (let i = 0; i < w.glyphs.length; i++) {
                    const lean = Math.sin(s.t * 0.9 + w.sway + i * 0.5) * (2 + i * 1.4);
                    ctx.fillStyle = c.up;
                    ctx.globalAlpha = 0.55 + (i / w.glyphs.length) * 0.35;
                    ctx.fillText(w.glyphs[i], w.x + lean, env.h - 10 - i * 13);
                }
            }
            ctx.globalAlpha = 1;

            for (const f of s.fish) {
                f.x += f.v * dt;
                const y = f.y + Math.sin(s.t * 1.4 + f.bob) * 5;
                if (f.v > 0 && f.x > env.w + 60) f.x = -60;
                if (f.v < 0 && f.x < -60) f.x = env.w + 60;
                ctx.font = `14px ${c.mono}`;
                ctx.fillStyle = c[f.tone] || c.txt;
                ctx.fillText(f.art, f.x, y);
                f.bubbleT -= dt;
                if (f.bubbleT <= 0) {
                    f.bubbleT = 2.5 + Math.random() * 5;
                    s.bubbles.push({ x: f.x + (f.v > 0 ? 44 : -6), y: y - 6, age: 0 });
                }
            }

            for (let i = s.bubbles.length - 1; i >= 0; i--) {
                const b = s.bubbles[i];
                b.age += dt;
                b.y -= 28 * dt;
                b.x += Math.sin(s.t * 2 + i) * 8 * dt;
                if (b.y < 8) { s.bubbles.splice(i, 1); continue; }
                ctx.font = `${b.age < 1 ? 9 : 12}px ${c.mono}`;
                ctx.fillStyle = c.inkDim;
                ctx.fillText(b.age < 1 ? '.' : 'o', b.x, b.y);
            }
        },
    };

    // --- Plasma -------------------------------------------------------------
    // The demoscene field: three sines and a distance term summed per cell,
    // mapped through the glyph ramp and the theme's own colors. Row strings
    // per color bucket keep it to a handful of fillText calls per row, the
    // trick the donut uses.
    STYLES.plasma = {
        label: 'Plasma', screen: false, mood: 'lively',
        init(env) {
            const chh = 16;
            return {
                cw: 9, ch: chh, measured: false,
                cols: Math.max(20, Math.floor(env.w / 9)),
                rows: Math.max(10, Math.floor(env.h / chh)),
                t: 0, ramp: ' .:-=+*#%@',
            };
        },
        frame(ctx, env, s, dt) {
            const c = env.colors;
            if (!s.measured) {
                ctx.font = `${s.ch - 2}px ${c.mono}`;
                const adv = ctx.measureText('M').width;
                if (adv > 1) { s.cw = adv; s.cols = Math.max(20, Math.floor(env.w / adv)); }
                s.measured = true;
            }
            s.t += dt * 0.8;
            ctx.fillStyle = c.ground;
            ctx.fillRect(0, 0, env.w, env.h);
            ctx.font = `${s.ch - 2}px ${c.mono}`;
            ctx.textBaseline = 'top';
            const t = s.t;
            const tones = [c.inkDim, c.accent, c.ink];
            for (let r = 0; r < s.rows; r++) {
                const rowY = r * s.ch;
                const bands = ['', '', ''];
                for (let i = 0; i < s.cols; i++) {
                    const x = i / 6, y = r / 3.2;
                    const v = Math.sin(x + t) + Math.sin((y + t) / 1.4) +
                        Math.sin((x + y + t) / 2) +
                        Math.sin(Math.sqrt(x * x + y * y + 1) - t);
                    const n = (v + 4) / 8;   // 0..1
                    const g = s.ramp[Math.max(0, Math.min(s.ramp.length - 1,
                        Math.floor(n * s.ramp.length)))];
                    const bucket = n < 0.42 ? 0 : n < 0.68 ? 1 : 2;
                    for (let b = 0; b < 3; b++) bands[b] += b === bucket ? g : ' ';
                }
                for (let b = 0; b < 3; b++) {
                    if (!bands[b].trim()) continue;
                    ctx.fillStyle = tones[b];
                    ctx.fillText(bands[b], 0, rowY);
                }
            }
        },
    };

    // --- Big clock ----------------------------------------------------------
    // Seven-segment time and the date, glanceable across a room - the one
    // style that is also a tool, which is why "Surprise me" never picks it
    // unless it is ticked on purpose: a surprise clock is just a clock.
    STYLES.clock = {
        label: 'Big Clock (24h)', screen: false, mood: 'calm', surprise: false,
        // Segments per digit: [top, topL, topR, mid, botL, botR, bottom].
        DIGITS: {
            0: [1, 1, 1, 0, 1, 1, 1], 1: [0, 0, 1, 0, 0, 1, 0],
            2: [1, 0, 1, 1, 1, 0, 1], 3: [1, 0, 1, 1, 0, 1, 1],
            4: [0, 1, 1, 1, 0, 1, 0], 5: [1, 1, 0, 1, 0, 1, 1],
            6: [1, 1, 0, 1, 1, 1, 1], 7: [1, 0, 1, 0, 0, 1, 0],
            8: [1, 1, 1, 1, 1, 1, 1], 9: [1, 1, 1, 1, 0, 1, 1],
        },
        init(env) {
            return { driftX: 0, driftY: 0, lastMinute: -1 };
        },
        drawDigit(ctx, seg, x, y, w, h, thick) {
            const bar = (bx, by, bw, bh) => ctx.fillRect(bx, by, bw, bh);
            if (seg[0]) bar(x + thick, y, w - 2 * thick, thick);
            if (seg[1]) bar(x, y + thick * 0.6, thick, h / 2 - thick);
            if (seg[2]) bar(x + w - thick, y + thick * 0.6, thick, h / 2 - thick);
            if (seg[3]) bar(x + thick, y + h / 2 - thick / 2, w - 2 * thick, thick);
            if (seg[4]) bar(x, y + h / 2 + thick * 0.4, thick, h / 2 - thick);
            if (seg[5]) bar(x + w - thick, y + h / 2 + thick * 0.4, thick, h / 2 - thick);
            if (seg[6]) bar(x + thick, y + h - thick, w - 2 * thick, thick);
        },
        frame(ctx, env, s) {
            const c = env.colors;
            ctx.fillStyle = c.ground;
            ctx.fillRect(0, 0, env.w, env.h);

            const now = new Date();
            // Drift a little each minute so a bench display does not burn
            // one spot into an OLED.
            if (now.getMinutes() !== s.lastMinute) {
                s.lastMinute = now.getMinutes();
                s.driftX = (Math.random() - 0.5) * env.w * 0.08;
                s.driftY = (Math.random() - 0.5) * env.h * 0.12;
            }
            const rawHours = now.getHours();
            const hours = s.twelve ? (rawHours % 12) || 12 : rawHours;
            const text = [hours, now.getMinutes(), now.getSeconds()]
                .map((n) => String(n).padStart(2, '0'));
            const dw = Math.min(env.w / 11, env.h / 4);
            const dh = dw * 1.7;
            const thick = Math.max(4, dw * 0.16);
            const gap = dw * 0.35;
            const colonW = dw * 0.5;
            // Every digit advances dw+gap and every colon colonW+gap, so
            // the span is 6 digits, 2 colons and 8 gaps - the first version
            // undercounted the gaps and the seconds column rode off the
            // right edge of the window.
            const totalW = 6 * dw + 8 * gap + 2 * colonW;
            const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
            let x = clamp((env.w - totalW) / 2 + s.driftX, 14, Math.max(14, env.w - totalW - 14));
            const centreX = x + totalW / 2;
            const y = clamp((env.h - dh) / 2 - 20 + s.driftY, 14, Math.max(14, env.h - dh - 60));

            ctx.fillStyle = c.ink;
            const blink = now.getMilliseconds() < 500;
            for (let g = 0; g < 3; g++) {
                for (const ch of text[g]) {
                    STYLES.clock.drawDigit(ctx, STYLES.clock.DIGITS[ch], x, y, dw, dh, thick);
                    x += dw + gap;
                }
                if (g < 2) {
                    if (blink) {
                        ctx.fillRect(x + colonW / 2 - thick / 2, y + dh * 0.28, thick, thick);
                        ctx.fillRect(x + colonW / 2 - thick / 2, y + dh * 0.65, thick, thick);
                    }
                    x += colonW + gap;
                }
            }
            ctx.font = `16px ${c.mono}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = c.inkDim;
            const dateLine = now.toLocaleDateString(undefined,
                { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            ctx.fillText(s.twelve
                ? `${dateLine}   ${rawHours < 12 ? 'AM' : 'PM'}` : dateLine,
            centreX, y + dh + 26);
            ctx.textAlign = 'left';
        },
    };

    // The same clock, half the dial: 12-hour with an AM/PM tag. A separate
    // entry rather than a setting, so both live in the Extras list and the
    // picker like everything else.
    STYLES.clock12 = {
        label: 'Big Clock (12h)', screen: false, mood: 'calm', surprise: false,
        init(env) {
            const st = STYLES.clock.init(env);
            st.twelve = true;
            return st;
        },
        frame(ctx, env, s) { STYLES.clock.frame(ctx, env, s); },
    };

    // --- DVD bounce ---------------------------------------------------------
    // The mark drifts, bounces, and changes color on every wall. Hitting a
    // corner EXACTLY gets the burst everybody has waited a whole meeting
    // for. The epsilon is honest - a near-miss is a near-miss.
    STYLES.dvd = {
        label: 'Logo Bounce', screen: false, mood: 'calm',
        init(env) {
            return {
                x: Math.random() * (env.w - 180) + 20,
                y: Math.random() * (env.h - 80) + 20,
                vx: 90 * (Math.random() < 0.5 ? 1 : -1),
                vy: 72 * (Math.random() < 0.5 ? 1 : -1),
                w: 150, h: 54, tone: 0, corners: 0,
                burst: [], flash: 0,
            };
        },
        frame(ctx, env, s, dt) {
            const c = env.colors;
            const palette = [c.accent, c.up, c.warn, c.down, c.ink];
            ctx.fillStyle = c.ground;
            ctx.fillRect(0, 0, env.w, env.h);

            s.x += s.vx * dt;
            s.y += s.vy * dt;
            let hitX = false;
            let hitY = false;
            if (s.x <= 0) { s.x = 0; s.vx = Math.abs(s.vx); hitX = true; }
            if (s.x + s.w >= env.w) { s.x = env.w - s.w; s.vx = -Math.abs(s.vx); hitX = true; }
            if (s.y <= 0) { s.y = 0; s.vy = Math.abs(s.vy); hitY = true; }
            if (s.y + s.h >= env.h) { s.y = env.h - s.h; s.vy = -Math.abs(s.vy); hitY = true; }
            if (hitX || hitY) s.tone = (s.tone + 1) % palette.length;
            if (hitX && hitY) {
                s.corners++;
                s.flash = 1;
                const cx = s.x + s.w / 2;
                const cy = s.y + s.h / 2;
                for (let i = 0; i < 26; i++) {
                    const a = (i / 26) * Math.PI * 2;
                    s.burst.push({ x: cx, y: cy, vx: Math.cos(a) * (120 + Math.random() * 120),
                        vy: Math.sin(a) * (120 + Math.random() * 120), age: 0 });
                }
            }

            const tone = palette[s.tone];
            if (s.flash > 0) {
                s.flash -= dt * 1.4;
                ctx.fillStyle = tone;
                ctx.globalAlpha = Math.max(0, s.flash) * 0.18;
                ctx.fillRect(0, 0, env.w, env.h);
                ctx.globalAlpha = 1;
            }

            ctx.strokeStyle = tone;
            ctx.lineWidth = 2;
            ctx.strokeRect(s.x + 1, s.y + 1, s.w - 2, s.h - 2);
            ctx.font = `bold 17px ${c.mono}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = tone;
            ctx.fillText('RSMultiTerm', s.x + s.w / 2, s.y + s.h / 2 - 6);
            ctx.font = `10px ${c.mono}`;
            ctx.fillStyle = c.inkDim;
            ctx.fillText(s.corners === 0 ? 'waiting for the corner'
                : `corners: ${s.corners}`, s.x + s.w / 2, s.y + s.h / 2 + 14);
            ctx.textAlign = 'left';

            ctx.textBaseline = 'middle';
            for (let i = s.burst.length - 1; i >= 0; i--) {
                const p = s.burst[i];
                p.age += dt;
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                p.vy += 60 * dt;
                if (p.age > 1.6) { s.burst.splice(i, 1); continue; }
                ctx.font = `${13 - p.age * 5}px ${c.mono}`;
                ctx.fillStyle = tone;
                ctx.globalAlpha = Math.max(0, 1 - p.age / 1.6);
                ctx.fillText('*', p.x, p.y);
            }
            ctx.globalAlpha = 1;
        },
    };

    window.Idle = {
        start, stop,
        isPlaying: () => !!(running && running.play),
        isRunning: () => !!running,
        // Frames drawn since load - the honest way to measure the loop.
        frameCount: () => frames,
        // {frames, ms} since load - the draw cost, independent of whatever
        // the compositor or a remote-desktop session does with the result.
        frameCost: () => ({ frames, ms: frameMs }),
        // The running style's state, for probes that want to assert on
        // behavior (a wave thinned, a diver launched) rather than pixels.
        debugState: () => (running ? running.state : null),
        // Whether the OS is asking for reduced motion - shown in Settings,
        // never used to refuse an explicit opt-in.
        reducedMotion: () => reducedMotion,
        styles: () => Object.entries(STYLES).map(([id, s]) => ({ id, label: s.label,
            mood: s.mood || 'calm', surprise: s.surprise !== false,
            playable: !!s.playable })),
        // For probes: which style is up, and whether it is clipped to the
        // terminal area or has taken the window.
        currentStyle: () => (running ? running.id : null),
        currentArea: () => (running ? (running.region ? 'panes' : 'window') : null),
        rotateNow: () => { if (running && !running.play) rotate(); },
    };
})();
