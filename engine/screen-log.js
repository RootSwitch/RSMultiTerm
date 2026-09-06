'use strict';
// Text logs by emulation. The same terminal core the renderer draws with
// (xterm, headless) reads the byte stream in the logger's seat, and what
// gets written is what the SCREEN showed - not the stream with the escapes
// cut out.
//
// The difference is the whole point. A stripper drops \r and backspace and
// swallows every escape without applying what it MEANT, so anything a
// program erased, overwrote or redrew stays in the log as if it had never
// been undone: a corrected typo logs as "echo hxlloello", a Ctrl-U'd
// command logs as if it ran, a multi-line paste logs twice with the second
// copy glued to the first (readline redraws the buffer with cursor-up
// moves), every frame of a \r progress bar lands on one line (needrestart
// produced a 12,725-character line), and nano's whole UI arrives as soup.
// Measured against real bash 5.3 readline and real apt on Ubuntu 24.04,
// every one of those is the stripper; the screen was clean each time. The
// captures are the fixtures in tools/fixtures/.
//
// Streaming: a line is written the moment it scrolls out of the viewport,
// because nothing can redraw it after that. Rows still on screen are
// written when the program has been quiet for a moment (everything above
// the cursor's line - the line being edited stays open), before an
// erase-display (`clear` would otherwise take the last screenful with it -
// this log keeps history the screen wipes), when a full-screen program
// takes over (one note in its place; its paint lives in the alternate
// buffer, which is never read), and at close. Soft-wrapped rows are joined
// back into one line, so a long command is one log line, not three.
//
// The "first line not yet written" is tracked with an xterm marker, not a
// number: once the scrollback is full, lines slide through SHIFTING indices
// as older ones are trimmed, and a marker's .line follows its row through
// scrolls, trims and an app-sent ESC[3J. That is the public API built for
// exactly this, and it keeps this file off xterm's internals.
//
// What can never appear in the output: control bytes. Cells hold printable
// text only - C0/C1 controls and every escape are consumed by the parser -
// so a text log cannot carry an executable sequence by any spelling. Bytes
// that are not valid UTF-8 decode to U+FFFD, which is the honest glyph.

const { Terminal } = require('@xterm/headless');

const SCROLLBACK = 1000;
const IDLE_MS = 1500;
const ALT_NOTE = '[full-screen program - its display is not logged]';

class ScreenLog {
    // opts: {cols, rows, idleMs, onLine(text)}
    constructor(opts = {}) {
        this.onLine = opts.onLine || (() => {});
        this.idleMs = opts.idleMs === undefined ? IDLE_MS : opts.idleMs;
        this.term = new Terminal({
            cols: opts.cols || 80, rows: opts.rows || 24,
            scrollback: SCROLLBACK, allowProposedApi: true,
        });
        this.flushed = 0;       // absolute buffer index of the first unwritten line
        this.head = null;       // marker pinned to that line
        this.canary = null;     // after an erase: a scrollback marker that carries the shift
        this.canaryBase = 0;
        this.pending = 0;       // writes xterm has not parsed yet
        this.idle = null;
        this.closed = false;

        this.resizing = false;
        this.term.onScroll(() => { if (!this.resizing) this._commit(this._normal().baseY, true); });

        // An erase-display is about to blank rows that may not be written
        // yet. Only a whole-screen erase counts (`clear` sends ESC[2J, some
        // things send ESC[H ESC[J): readline's own partial erases while
        // editing must not commit the line being edited.
        this.term.parser.registerCsiHandler({ final: 'J' }, (params) => {
            const p = Array.isArray(params) && params.length ? Number(params[0]) || 0 : 0;
            const b = this._normal();
            const whole = p === 2 || (p === 0 && b.cursorX === 0 && b.cursorY === 0);
            if (whole && this.term.buffer.active.type === 'normal') {
                this._commit(this._lastContentRow(b) + 1, false);
                this._restart(b.baseY);
            }
            return false;
        });

        // A full reset (ESC c - what the `reset` command sends) empties the
        // buffer, scrollback and all. Write what is there first.
        this.term.parser.registerEscHandler({ final: 'c' }, () => {
            if (this.term.buffer.active.type === 'normal') {
                this._commit(this._lastContentRow(this._normal()) + 1, false);
            }
            this._restart(0);
            return false;
        });

        this.term.buffer.onBufferChange((buf) => {
            if (buf.type !== 'alternate') return;
            // Rows above the cursor's line only. The program restores the
            // cursor to this row when it exits (mode 1049), and the shell's
            // next prompt is printed THERE - written now, while empty, that
            // prompt would be lost.
            const b = this._normal();
            this._commit(this._lineStart(b, b.baseY + b.cursorY), true);
            this.onLine(ALT_NOTE);
        });
    }

    _normal() { return this.term.buffer.normal; }

    // xterm parses asynchronously; every write's callback fires in order.
    write(buf) {
        if (this.closed) return;
        this.pending++;
        this.term.write(buf, () => {
            this.pending--;
            this._armIdle();
        });
    }

    resize(cols, rows) {
        if (this.closed) return;
        // Behind a barrier, so everything already sent is parsed at the
        // geometry the device produced it for.
        this.pending++;
        this.term.write('', () => {
            this.pending--;
            const b = this._normal();
            if (this.term.buffer.active.type === 'normal') {
                this._commit(this._lineStart(b, b.baseY + b.cursorY), true);
            }
            // Reflow moves lines under the marker; a scroll fired mid-resize
            // must not commit against indices that are about to change.
            this.resizing = true;
            if (this.head) { this.head.dispose(); this.head = null; }
            this.term.resize(cols, rows);
            this.resizing = false;
            // Reflow may have changed how many rows the written lines take.
            // The cursor's own line is where "not yet written" begins.
            const b2 = this._normal();
            this.flushed = this._lineStart(b2, b2.baseY + b2.cursorY);
            this._setHead();
            this._armIdle();
        });
    }

    // One completion, however many times it is asked for: the engine closes
    // a logger from the transport's close event AND from session.close(),
    // and the second caller must wait for the flush, not skip it.
    close() {
        if (this.closing) return this.closing;
        this.closed = true;
        if (this.idle) { clearTimeout(this.idle); this.idle = null; }
        this.closing = new Promise((resolve) => {
            this.term.write('', () => {
                const b = this._normal();
                this._commit(this._lastContentRow(b) + 1, false);
                this.term.dispose();
                resolve();
            });
        });
        return this.closing;
    }

    _armIdle() {
        if (this.closed || !this.idleMs) return;
        if (this.idle) clearTimeout(this.idle);
        this.idle = setTimeout(() => {
            this.idle = null;
            if (this.closed || this.pending) return;
            if (this.term.buffer.active.type !== 'normal') return;
            const b = this._normal();
            this._commit(this._lineStart(b, b.baseY + b.cursorY), true);
        }, this.idleMs);
        if (this.idle.unref) this.idle.unref();
    }

    // The first row of the logical line that row `abs` belongs to.
    _lineStart(b, abs) {
        let i = Math.min(abs, b.length - 1);
        while (i > 0) {
            const line = b.getLine(i);
            if (!line || !line.isWrapped) break;
            i--;
        }
        return Math.max(0, i);
    }

    // The last row on screen with anything on it, or baseY - 1 for none.
    _lastContentRow(b) {
        for (let y = b.length - 1; y >= b.baseY; y--) {
            const line = b.getLine(y);
            if (line && line.translateToString(true) !== '') return y;
        }
        return b.baseY - 1;
    }

    // Write every unwritten logical line that ends before `through`.
    // `hold`: a logical line that continues past `through` stays unwritten
    // (it is still being wrapped onto); without it, the rows are written as
    // they stand, which is right when they are about to be erased.
    _commit(through, hold) {
        const b = this._normal();
        if (this.head) {
            if (this.head.line >= 0) this.flushed = this.head.line;
            else {
                // The line this pointed at was trimmed before it was written.
                // With a flush on every scroll this should not happen; if it
                // does, say so rather than pretend.
                this.onLine('[log fell behind - some output here was not captured]');
                this.flushed = 0;
            }
        } else if (this.canary) {
            const c = this.canary;
            this.canary = null;
            // Gone: an ESC[3J took the whole scrollback. Moved: the cap trimmed
            // that many lines off the top.
            const shift = c.line >= 0 ? this.canaryBase - (c.line + 1) : this.canaryBase;
            c.dispose();
            this.flushed = Math.max(0, this.flushed - shift);
        }
        const end = Math.min(through, b.length);
        let i = Math.max(0, this.flushed);
        const before = i;
        while (i < end) {
            let j = i + 1;
            while (j < b.length) {
                const line = b.getLine(j);
                if (!line || !line.isWrapped) break;
                j++;
            }
            if (j > end && hold) break;
            const stop = Math.min(j, end);
            let text = '';
            for (let k = i; k < stop; k++) {
                const line = b.getLine(k);
                text += line ? line.translateToString(k === stop - 1) : '';
            }
            this.onLine(text);
            i = stop;
        }
        if (i !== before || !this.head) {
            this.flushed = i;
            this._setHead();
        }
    }

    // Everything on screen is about to be new. Erase-display (ESC[2J) and a
    // reset are the two things xterm disposes every marker for - the only
    // two, measured: erase-in-line, erase-below and overwriting all leave a
    // marker alone - so the pointer goes back to a plain number here. The
    // erase moves no lines, so the number stays right until the next
    // commit registers a fresh marker.
    _restart(at) {
        if (this.head) { this.head.dispose(); this.head = null; }
        if (this.canary) { this.canary.dispose(); this.canary = null; }
        this.flushed = at;
        // A plain number cannot see a trim - and `clear` sends ESC[3J right
        // after its ESC[2J, which drops the whole scrollback. A marker on
        // the LAST scrollback line is out of the erase's reach, moves with
        // any trim, and dies with the 3J: the next commit reads the shift
        // off it before trusting the number.
        const b = this._normal();
        this.canaryBase = b.baseY;
        if (b.baseY > 0 && this.term.buffer.active.type === 'normal') {
            this.canary = this.term.registerMarker(-(b.cursorY + 1)) || null;
        }
    }

    _setHead() {
        if (this.head) { this.head.dispose(); this.head = null; }
        if (this.canary) { this.canary.dispose(); this.canary = null; }
        const b = this._normal();
        if (this.flushed < 0 || this.flushed >= b.length) return;
        if (this.term.buffer.active.type !== 'normal') return;   // xterm refuses markers then
        this.head = this.term.registerMarker(this.flushed - (b.baseY + b.cursorY)) || null;
    }
}

module.exports = { ScreenLog, ALT_NOTE };
