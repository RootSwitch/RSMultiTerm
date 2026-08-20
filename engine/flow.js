'use strict';
// Data-plane flow control, the make-or-break throughput piece. Two jobs:
//
// 1. Batching: transports emit whatever chunk sizes the network hands them;
//    forwarding those 1:1 across the port is death by messaging overhead. We
//    accumulate and flush on whichever comes first: FLUSH_MS or FLUSH_BYTES.
//
// 2. Backpressure: a credit window measured end to end. Credit is only
//    returned when xterm has actually parsed the bytes (the renderer acks
//    from inside term.write's callback), so the window tracks true
//    absorption, not just delivery. Above HIGH in-flight we pause the
//    transport - for SSH that shrinks the channel window and throttles the
//    device itself; below LOW we resume. A `show tech` then runs at exactly
//    the speed the UI can draw, with bounded memory everywhere.

const FLUSH_MS = 12;
const FLUSH_BYTES = 64 * 1024;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;

class Flow {
    // sink({t:'data', seq, buf}) delivers a batch; onPause/onResume hook the
    // transport's pause()/resume().
    constructor(sink, onPause, onResume, opts = {}) {
        this.sink = sink;
        this.onPause = onPause;
        this.onResume = onResume;
        this.flushMs = opts.flushMs ?? FLUSH_MS;
        this.flushBytes = opts.flushBytes ?? FLUSH_BYTES;
        this.highWater = opts.highWater ?? HIGH_WATER;
        this.lowWater = opts.lowWater ?? LOW_WATER;

        this.chunks = [];
        this.pending = 0;
        this.timer = null;
        this.seq = 0;
        this.inFlight = 0;
        this.paused = false;
        this.closed = false;
    }

    push(buf) {
        if (this.closed) return;
        this.chunks.push(buf);
        this.pending += buf.length;
        if (this.pending >= this.flushBytes) {
            this._flush();
        } else if (!this.timer) {
            this.timer = setTimeout(() => this._flush(), this.flushMs);
            // Don't hold the engine process alive just for a pending flush.
            if (this.timer.unref) this.timer.unref();
        }
    }

    ack(seq, bytes) {
        this.inFlight -= bytes;
        if (this.inFlight < 0) this.inFlight = 0;   // renderer reloaded mid-stream
        if (this.paused && this.inFlight <= this.lowWater) {
            this.paused = false;
            this.onResume();
        }
    }

    // Flush whatever is buffered and stop; used at close so the tail of a
    // stream (an exit message, a prompt) is never dropped.
    close() {
        this._flush();
        this.closed = true;
    }

    _flush() {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (!this.pending) return;
        const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
        this.chunks = [];
        this.pending = 0;
        this.seq++;
        this.inFlight += buf.length;
        // Structured clone serializes the ENTIRE underlying ArrayBuffer, and
        // small Buffers are views over Node's shared 8KB pool slab - a
        // one-byte keystroke echo would ship 8KB across the port. When the
        // view does not own its whole allocation, copy into a plain
        // Uint8Array, which always owns an exact-size buffer (Buffer.from
        // would land back on the pool).
        let view = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
        if (buf.byteLength !== buf.buffer.byteLength) view = new Uint8Array(view);
        this.sink({ t: 'data', seq: this.seq, buf: view });
        if (!this.paused && this.inFlight >= this.highWater) {
            this.paused = true;
            this.onPause();
        }
    }
}

module.exports = { Flow, FLUSH_MS, FLUSH_BYTES, HIGH_WATER, LOW_WATER };
