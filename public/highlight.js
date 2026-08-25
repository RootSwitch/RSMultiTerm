'use strict';
// Context highlighting: the first thing anyone notices about the app.
//
// Strategy: scan ONLY the visible viewport rows and mark matches with xterm
// decorations (DOM overlay elements, so they ride both renderers and can
// carry CSS animation). Never match on the write stream - tokens split
// across chunks and ANSI escapes interleave mid-word there. Cost is
// O(visible rows) per scan regardless of scrollback size or throughput,
// throttled to one scan per 50 ms during sustained output.
//
// Blink is pure CSS on the overlay (.mt-hl-blink), capped at the first 50
// flashing matches on screen - a page of flashing err-disabled is a seizure
// hazard and a GPU waste, and 50 is already "everything is on fire".

(function () {
    let sets = [];               // raw rule sets from main
    const compiled = new Map();  // setId -> [{rule, regex}]
    const BLINK_CAP = 50;

    function loadSets() {
        return rsterm.invoke('rs:highlights.get').then((s) => {
            sets = s;
            compiled.clear();
            for (const pane of window.TermPanes.panes.values()) {
                if (pane.highlighter) pane.highlighter.rescan();
            }
        });
    }

    function compile(setId) {
        if (compiled.has(setId)) return compiled.get(setId);
        const set = sets.find((s) => s.id === setId || s.name === setId) || sets[0];
        const out = [];
        for (const rule of (set ? set.rules : [])) {
            if (!rule.enabled) continue;
            let src = rule.isRegex ? rule.pattern
                : rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (rule.wholeWord) src = `\\b(?:${src})\\b`;
            try {
                out.push({ rule, regex: new RegExp(src, rule.caseSensitive ? 'g' : 'gi') });
            } catch (_) {
                // A malformed user regex disables that rule, visibly in the
                // rules UI (compileError flag re-checked there), never a crash.
                rule.compileError = true;
            }
        }
        compiled.set(setId, out);
        return out;
    }

    // --- watch: output triggers -------------------------------------------
    // Matching happens on COMPLETED buffer lines via onLineFeed, not on the
    // write stream (tokens split across chunks) and not in the viewport
    // scan (a background tab's pane may never render). The buffer line is
    // already parsed, so escape sequences are gone by the time we look.
    // A chatty match is rate-limited per pane and rule: the badge is
    // idempotent anyway, and one notification per burst is a feature.
    const WATCH_COOLDOWN_MS = 5000;
    const lastWatchAlert = new Map();   // `${sessionId}:${pattern}` -> ts

    function fireWatch(pane, rule, lineText) {
        const key = `${pane.sessionId}:${rule.pattern}`;
        const now = Date.now();
        if (now - (lastWatchAlert.get(key) || 0) < WATCH_COOLDOWN_MS) return;
        lastWatchAlert.set(key, now);
        if (window.Tabs) window.Tabs.markAlert(pane.sessionId);
        const st = document.getElementById('status-text');
        if (st) st.textContent = `${pane.title}: "${rule.pattern}" matched`;
        // A system notification only when the app is NOT focused: if you
        // are looking at the window, the badge and the colored match are
        // already doing the job.
        if (!document.hasFocus() && typeof Notification !== 'undefined' &&
            Notification.permission !== 'denied') {
            try {
                new Notification(pane.title, {
                    body: `${rule.pattern}: ${window.App.plainText(lineText).slice(0, 140)}`,
                    silent: true,
                });
            } catch (_) { /* notifications unavailable: the badge stands */ }
        }
    }

    class Highlighter {
        constructor(pane, setId) {
            this.pane = pane;
            this.setId = setId || (sets[0] ? sets[0].id : null);
            this.term = pane.term;
            this.lineCache = new Map();   // absLine -> {text, decos: []}
            this.dirty = false;
            this.lastScan = 0;
            this.timer = null;
            this.blinkCount = 0;
            this.blinkOn = true;
            this.blinkTimer = null;
            this.blinkables = new Set();

            this.disposables = [
                this.term.onRender(() => this.schedule()),
                this.term.onScroll(() => this.schedule()),
                this.term.onResize(() => { this.lineCache.clear(); this.schedule(); }),
                // Watch rules check each line as it completes; by the time
                // onLineFeed fires the cursor has moved on, so the finished
                // line is the row above it.
                this.term.onLineFeed(() => {
                    const watch = compile(this.setId).filter((r) => r.rule.watch);
                    if (!watch.length) return;
                    const buf = this.term.buffer.active;
                    const row = buf.baseY + buf.cursorY - 1;
                    const line = row >= 0 ? buf.getLine(row) : null;
                    if (!line) return;
                    const text = line.translateToString(true);
                    if (!text) return;
                    for (const { rule, regex } of watch) {
                        regex.lastIndex = 0;
                        if (regex.test(text)) fireWatch(this.pane, rule, text);
                    }
                }),
            ];
            this.schedule();
        }

        schedule() {
            if (this.dirty) return;
            this.dirty = true;
            const since = Date.now() - this.lastScan;
            const wait = since > 50 ? 16 : 50 - since;
            this.timer = setTimeout(() => this.scan(), wait);
        }

        scan() {
            this.dirty = false;
            this.lastScan = Date.now();
            const term = this.term;
            const buf = term.buffer.active;
            const rules = compile(this.setId);
            if (!rules.length) return;

            const top = buf.viewportY;
            const bottom = Math.min(top + term.rows, buf.length);
            const wanted = new Set();
            this.blinkCount = 0;

            for (let y = top; y < bottom; y++) {
                wanted.add(y);
                const line = buf.getLine(y);
                if (!line) continue;
                const text = line.translateToString(true);
                const cached = this.lineCache.get(y);
                if (cached && cached.text === text) {
                    this.blinkCount += cached.blinks;
                    continue;
                }
                if (cached) for (const d of cached.decos) d.dispose();

                const decos = [];
                let blinks = 0;
                const claimed = [];   // [start, end) ranges already matched
                for (const { rule, regex } of rules) {
                    regex.lastIndex = 0;
                    let m;
                    while ((m = regex.exec(text)) !== null) {
                        if (m[0].length === 0) { regex.lastIndex++; continue; }
                        const a = m.index;
                        const b = a + m[0].length;
                        if (claimed.some(([ca, cb]) => a < cb && b > ca)) continue;
                        claimed.push([a, b]);
                        const deco = this.decorate(y, a, m[0].length, rule);
                        if (deco) {
                            decos.push(deco);
                            if (rule.blink && this.blinkCount + blinks < BLINK_CAP) blinks++;
                        }
                    }
                }
                this.blinkCount += blinks;
                this.lineCache.set(y, { text, decos, blinks });
            }

            // Evict cache outside ~2x viewport so long sessions stay bounded.
            for (const [y, entry] of this.lineCache) {
                if (y < top - term.rows || y > bottom + term.rows) {
                    for (const d of entry.decos) d.dispose();
                    this.lineCache.delete(y);
                }
            }
        }

        decorate(absLine, x, width, rule) {
            const buf = this.term.buffer.active;
            const delta = absLine - (buf.baseY + buf.cursorY);
            let marker;
            try {
                marker = this.term.registerMarker(delta);
            } catch (_) { return null; }
            if (!marker) return null;

            // Colors are applied by the RENDERER, via decoration cell
            // coloring, never by repainting glyphs in an overlay. The old
            // overlay approach drew a second copy of the text whose CSS
            // metrics only matched the DOM renderer's - under WebGL every
            // highlighted token doubled with a growing offset. Cell colors
            // are pixel-perfect under both renderers by construction.
            //
            // Rule colors are authored against a dark terminal. On a light
            // background the foreground is corrected at paint time so the
            // stored rule (the user's data) stays exactly as written. A rule
            // with its own background sets both, so it is self-contained and
            // needs no correction. Bold renders as color only: a faithful
            // bold would mean repainting glyphs, which is the doubling bug.
            const termBg = window.TermPanes.currentBackground();
            const fg = rule.fg
                ? (rule.bg ? rule.fg : window.Colors.readable(rule.fg, termBg))
                : undefined;
            const spec = {
                marker, x, width, layer: 'bottom',
                backgroundColor: rule.bg || undefined,
                foregroundColor: fg,
            };
            const wantsOverlay = !!rule.underline;
            const mkDeco = () => {
                const d = this.term.registerDecoration(spec);
                if (d && wantsOverlay) {
                    d.onRender((el) => {
                        // add, never assign: xterm's own class carries the
                        // absolute positioning.
                        el.classList.add('mt-hl');
                        // A border, not text-decoration: the overlay stays
                        // empty so there is nothing to mis-measure.
                        el.style.borderBottom = `1px solid ${fg || rule.bg || 'currentColor'}`;
                    });
                }
                return d;
            };

            if (rule.blink && this.blinkCount < BLINK_CAP) {
                // Blink alternates the decoration itself: colors live in
                // the renderer now, so CSS opacity on the (empty) overlay
                // element cannot blink them. On the off beat the decoration
                // is gone and the plain text shows through - same behavior
                // a real terminal blink attribute has.
                const b = { marker, mk: mkDeco, deco: this.blinkOn ? mkDeco() : null };
                this.blinkables.add(b);
                this.ensureBlinkTimer();
                const self = this;
                return {
                    dispose() {
                        if (b.deco) b.deco.dispose();
                        marker.dispose();
                        self.blinkables.delete(b);
                    },
                };
            }

            const deco = mkDeco();
            if (!deco) { marker.dispose(); return null; }
            const origDispose = deco.dispose.bind(deco);
            deco.dispose = () => { origDispose(); marker.dispose(); };
            return deco;
        }

        ensureBlinkTimer() {
            if (this.blinkTimer) return;
            this.blinkTimer = setInterval(() => {
                this.blinkOn = !this.blinkOn;
                for (const b of [...this.blinkables]) {
                    if (b.marker.isDisposed) { this.blinkables.delete(b); continue; }
                    if (this.blinkOn && !b.deco) b.deco = b.mk();
                    else if (!this.blinkOn && b.deco) { b.deco.dispose(); b.deco = null; }
                }
                if (!this.blinkables.size) {
                    clearInterval(this.blinkTimer);
                    this.blinkTimer = null;
                    this.blinkOn = true;
                }
            }, 500);
        }

        rescan() {
            for (const entry of this.lineCache.values()) {
                for (const d of entry.decos) d.dispose();
            }
            this.lineCache.clear();
            if (!this.disposed) this.schedule();
        }

        dispose() {
            // Order matters: the flag first, so the rescan below only clears
            // decorations and cannot arm a timer that would scan a disposed
            // terminal ~50ms after the pane is gone.
            this.disposed = true;
            if (this.timer) clearTimeout(this.timer);
            if (this.blinkTimer) { clearInterval(this.blinkTimer); this.blinkTimer = null; }
            for (const d of this.disposables) d.dispose();
            this.rescan();
        }
    }

    function attach(pane, setId) {
        if (pane.highlighter) pane.highlighter.dispose();
        pane.highlighter = new Highlighter(pane, setId);
    }

    rsterm.on('rs:evt.highlights-changed', loadSets);

    window.Highlight = { attach, loadSets, getSets: () => sets };
})();
