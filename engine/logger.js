'use strict';
// Per-session logging. Taps the transport's RAW data event before batching
// and flow control, so a paused renderer never gaps a log.
//
// Modes:
//   text (default) - what the terminal SHOWED, line by line, optional
//                    per-line timestamps; the log people actually read.
//                    Produced by screen-log.js: the renderer's own terminal
//                    core, headless, in the logger's seat - so a corrected
//                    typo, a redrawn paste, a \r progress bar and a nano
//                    session all log the way they looked, not the way the
//                    bytes arrived.
//   raw            - exact bytes as received (.raw.log), full fidelity for
//                    replaying escape-sequence problems.
//
// Naming: {dir}/{yyyy-MM-dd}/{session}--{host}--{HHmmss}.log
// Rotation: size threshold (default 50 MB) rolls to --part2, --part3...

const fs = require('fs');
const path = require('path');
const { ScreenLog } = require('./screen-log');

const ROTATE_BYTES = 50 * 1024 * 1024;

function two(n) { return String(n).padStart(2, '0'); }
function dateDir(d) { return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; }
function timeTag(d) { return `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`; }
function stamp(d) {
    return `[${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
        `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}] `;
}

function sanitize(name) {
    return String(name || 'session').replace(/[<>:"/\|?*\x00-\x1f]/g, '_').slice(0, 80);
}

class SessionLogger {
    // opts: {dir, sessionName, host, mode:'text'|'raw', timestamps:bool,
    //        rotateBytes, cols, rows, idleMs}
    constructor(opts) {
        this.opts = opts;
        this.stream = null;
        this.bytes = 0;
        this.part = 1;
        this.failed = false;
        this.basePath = null;
        this.screen = opts.mode === 'raw' ? null : new ScreenLog({
            cols: opts.cols, rows: opts.rows, idleMs: opts.idleMs,
            onLine: (text) => this._line(text),
        });
    }

    _open() {
        const now = new Date();
        const dir = path.join(this.opts.dir, dateDir(now));
        fs.mkdirSync(dir, { recursive: true });
        const ext = this.opts.mode === 'raw' ? '.raw.log' : '.log';
        let base = path.join(dir,
            `${sanitize(this.opts.sessionName)}--${sanitize(this.opts.host)}--${timeTag(now)}`);
        // Two same-named sessions started in the same second would append
        // into ONE file and interleave; take the next free name instead.
        let n = 1;
        while (fs.existsSync((n === 1 ? base : `${base}--${n}`) + ext)) n++;
        this.basePath = n === 1 ? base : `${base}--${n}`;
        this.stream = fs.createWriteStream(this.basePath + ext, { flags: 'a' });
        this.stream.on('error', () => { this.failed = true; this.stream = null; });
        this._header(now, null);
    }

    // What this file is and when it started. One line, so it costs nothing
    // to a search over a folder of logs - unlike a stamp on every line -
    // and it means a log that has been renamed or copied still says what it
    // is. NOT written in raw mode: that mode promises the exact bytes the
    // device sent, and a line this app invented is not one of them.
    _header(when, part) {
        if (this.opts.mode === 'raw' || !this.stream) return;
        // A quick connect names the session after the host, so without
        // this the header reads '10.50.1.7 (10.50.1.7)'.
        const who = this.opts.host && this.opts.host !== this.opts.sessionName
            ? `${this.opts.sessionName} (${this.opts.host})` : this.opts.sessionName;
        this.stream.write(`--- RSMultiTerm log: ${who}` +
            (part ? ` part ${part}` : '') + ` - ${stamp(when).replace(/[[\]]/g, '').trim()} ---\n`);
    }

    _rotate() {
        if (!this.stream) return;
        this.stream.end();
        this.part++;
        const ext = this.opts.mode === 'raw' ? '.raw.log' : '.log';
        this.stream = fs.createWriteStream(`${this.basePath}--part${this.part}${ext}`, { flags: 'a' });
        this.stream.on('error', () => { this.failed = true; this.stream = null; });
        this._header(new Date(), this.part);
        this.bytes = 0;
    }

    _ensureOpen() {
        if (this.failed) return false;
        if (!this.stream) {
            try { this._open(); } catch (_) { this.failed = true; return false; }
            if (!this.stream) return false;
        }
        return true;
    }

    write(buf) {
        if (!this._ensureOpen()) return;
        if (this.screen) this.screen.write(buf);
        else this._out(buf);
    }

    // The terminal's size, so the emulated screen wraps where the real one
    // does - readline's redraws assume the width the device was told.
    resize(cols, rows) {
        if (this.screen) this.screen.resize(cols, rows);
    }

    // One finished line from the emulated screen.
    _line(text) {
        if (!this._ensureOpen()) return;
        this._out((this.opts.timestamps ? stamp(new Date()) : '') + text + '\n');
    }

    _out(data) {
        if (!this.stream) return;
        // A stalled destination must not buffer session output in memory
        // without bound - the log directory can be a network share, and a
        // hung share used to grow the heap for as long as the session
        // talked. Past a real backlog (not a transient burst), drop and say
        // so in the log itself once the destination recovers: a gap that
        // announces itself beats an engine that dies remembering.
        if (this._dropping) {
            this._droppedBytes += Buffer.byteLength(data);
        } else {
            const ok = this.stream.write(data);
            if (!ok && this.stream.writableLength > 4 * 1024 * 1024) {
                this._dropping = true;
                this._droppedBytes = 0;
                this.stream.once('drain', () => {
                    this._dropping = false;
                    if (this._droppedBytes) {
                        this.stream.write(`\n[log writer fell behind: ` +
                            `${this._droppedBytes} bytes were not logged]\n`);
                    }
                });
            }
        }
        // byteLength, not .length: rotation was counting UTF-16 code units,
        // so multi-byte-heavy sessions rotated late.
        this.bytes += Buffer.byteLength(data);
        if (this.bytes >= (this.opts.rotateBytes || ROTATE_BYTES)) this._rotate();
    }

    async close() {
        // The screen writes its last lines synchronously from inside close().
        if (this.screen) await this.screen.close();
        if (!this.stream) return;
        await new Promise((res) => this.stream.end(res));
    }
}

module.exports = { SessionLogger };
