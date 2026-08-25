'use strict';
// Per-session logging. Taps the transport's RAW data event before batching
// and flow control, so a paused renderer never gaps a log. Keystrokes are
// not logged unless logInput is set - passwords get typed at enable prompts.
//
// Modes:
//   text (default) - ANSI-stripped, line-buffered, optional per-line
//                    timestamps; the log people actually read.
//   raw            - exact bytes as received (.raw.log), full fidelity for
//                    replaying escape-sequence problems.
//
// Naming: {dir}/{yyyy-MM-dd}/{session}--{host}--{HHmmss}.log
// Rotation: size threshold (default 50 MB) rolls to --part2, --part3...

const fs = require('fs');
const path = require('path');
const { AnsiStripper } = require('./ansi-strip');

const ROTATE_BYTES = 50 * 1024 * 1024;

function two(n) { return String(n).padStart(2, '0'); }
function dateDir(d) { return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; }
function timeTag(d) { return `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`; }
function stamp(d) {
    return `[${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
        `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}] `;
}

function sanitize(name) {
    return String(name || 'session').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
}

class SessionLogger {
    // opts: {dir, sessionName, host, mode:'text'|'raw', timestamps:bool, rotateBytes}
    constructor(opts) {
        this.opts = opts;
        this.stream = null;
        this.bytes = 0;
        this.part = 1;
        this.pendingLine = '';
        this.stripper = opts.mode === 'raw' ? null : new AnsiStripper();
        this.failed = false;
        this.basePath = null;
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
    }

    _rotate() {
        if (!this.stream) return;
        this.stream.end();
        this.part++;
        const ext = this.opts.mode === 'raw' ? '.raw.log' : '.log';
        this.stream = fs.createWriteStream(`${this.basePath}--part${this.part}${ext}`, { flags: 'a' });
        this.stream.on('error', () => { this.failed = true; this.stream = null; });
        this.bytes = 0;
    }

    write(buf) {
        if (this.failed) return;
        if (!this.stream) {
            try { this._open(); } catch (_) { this.failed = true; return; }
            if (!this.stream) return;
        }

        let data;
        if (this.stripper) {
            const text = this.stripper.feed(buf);
            if (!text) return;
            if (this.opts.timestamps) {
                // Line-buffered: a timestamp goes at the start of each
                // completed line; the tail waits for its newline.
                let s = this.pendingLine + text;
                const lines = s.split('\n');
                this.pendingLine = lines.pop();
                if (!lines.length) return;
                const now = stamp(new Date());
                data = lines.map((l) => now + l).join('\n') + '\n';
            } else {
                data = text;
            }
        } else {
            data = buf;
        }

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

    close() {
        if (!this.stream) return Promise.resolve();
        if (this.pendingLine) {
            this.stream.write(stamp(new Date()) + this.pendingLine + '\n');
            this.pendingLine = '';
        }
        return new Promise((res) => this.stream.end(res));
    }
}

module.exports = { SessionLogger };
