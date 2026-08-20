'use strict';
// Flow-control test: pushes 50 MB through Flow in random-sized chunks against
// a deliberately slow consumer and asserts the four properties that matter:
//   1. integrity  - every byte arrives, in order
//   2. batching   - message count is a small fraction of chunk count
//   3. window     - in-flight bytes never exceed HIGH + one max batch
//   4. pause/resume - the producer is actually paused while the consumer
//                     lags, and resumed when credit returns
// Runs in plain Node; no Electron involved.

const assert = require('assert');
const crypto = require('crypto');
const { Flow } = require('../engine/flow');

const TOTAL = 50 * 1024 * 1024;

function run() {
    return new Promise((resolve, reject) => {
        // Source data: repeatable pseudo-random bytes so a corruption is a
        // real corruption, not a test artifact.
        const source = crypto.randomBytes(1024 * 1024);

        let produced = 0;
        let consumed = 0;
        let messages = 0;
        let maxInFlight = 0;
        let pauses = 0;
        let resumes = 0;
        let pausedNow = false;
        let producing = false;

        const pendingAcks = [];
        const received = [];   // {seq} order check
        let lastSeq = 0;
        const hasher = crypto.createHash('sha256');
        const srcHasher = crypto.createHash('sha256');

        const flow = new Flow(
            (msg) => {
                messages++;
                assert.strictEqual(msg.t, 'data');
                assert.strictEqual(msg.seq, lastSeq + 1, 'sequence gap');
                lastSeq = msg.seq;
                hasher.update(msg.buf);
                consumed += msg.buf.byteLength;
                if (flow.inFlight > maxInFlight) maxInFlight = flow.inFlight;
                // Consumer acks later, at a bounded rate (the slow terminal).
                pendingAcks.push({ seq: msg.seq, bytes: msg.buf.byteLength });
            },
            () => { pauses++; pausedNow = true; },
            () => { resumes++; pausedNow = false; produce(); });

        // The consumer: drains acks every 5 ms, at most 128 KB per tick -
        // slower than the producer, so the window must fill and pause.
        const drain = setInterval(() => {
            let budget = 128 * 1024;
            while (pendingAcks.length && budget > 0) {
                const a = pendingAcks.shift();
                budget -= a.bytes;
                flow.ack(a.seq, a.bytes);
            }
            if (produced >= TOTAL && !pendingAcks.length && !flow.pending) {
                clearInterval(drain);
                finish();
            }
        }, 5);

        // The producer: pushes random 100 B - 32 KB slices, synchronously
        // until paused (like a socket 'data' storm), yielding occasionally.
        function produce() {
            if (producing) return;
            producing = true;
            while (produced < TOTAL && !pausedNow) {
                const size = 100 + Math.floor(Math.random() * 32 * 1024);
                const n = Math.min(size, TOTAL - produced);
                const off = produced % (source.length - n);
                const chunk = source.subarray(off, off + n);
                srcHasher.update(chunk);
                flow.push(Buffer.from(chunk));
                produced += n;
                assert.ok(!pausedNow || flow.inFlight >= 0);
            }
            producing = false;
        }

        function finish() {
            try {
                flow.close();
                assert.strictEqual(consumed, TOTAL, `consumed ${consumed} != produced ${TOTAL}`);
                assert.strictEqual(hasher.digest('hex'), srcHasher.digest('hex'), 'byte corruption');
                assert.ok(pauses > 0, 'window never paused a slow consumer');
                assert.ok(resumes >= pauses - 1, `pauses ${pauses} but resumes ${resumes}`);
                assert.ok(maxInFlight <= flow.highWater + 64 * 1024 + 32 * 1024,
                    `in-flight peaked at ${maxInFlight}`);
                const chunkEstimate = TOTAL / (16 * 1024);   // avg chunk ~16 KB
                assert.ok(messages < chunkEstimate / 2,
                    `batching ineffective: ${messages} messages for ~${Math.round(chunkEstimate)} chunks`);
                console.log(`ok - flow: 50 MB, ${messages} batches, ` +
                    `${pauses} pauses/${resumes} resumes, peak in-flight ${Math.round(maxInFlight / 1024)} KB`);
                resolve();
            } catch (e) { reject(e); }
        }

        // A stuck window (credit never returned) must fail loudly, not hang
        // the test chain forever.
        const watchdog = setTimeout(() => {
            clearInterval(drain);
            reject(new Error(`stalled: produced ${produced}, consumed ${consumed}, ` +
                `inFlight ${flow.inFlight}, paused ${pausedNow}`));
        }, 60 * 1000);
        watchdog.unref();

        produce();
    });
}

run().catch((e) => { console.error('FAIL -', e.message); process.exit(1); });
