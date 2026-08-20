'use strict';
// Telnet negotiator tests. The core trick: every scenario runs twice - once
// with the input as one buffer, once split into single bytes - and must
// produce identical output both ways. That is the chunk-boundary property a
// per-chunk parser silently lacks.

const assert = require('assert');
const {
    TelnetNegotiator, IAC, DONT, DO, WONT, WILL, SB, SE,
    OPT_ECHO, OPT_SGA, OPT_TTYPE, OPT_NAWS,
} = require('../engine/transports/telnet-negotiator');

function run(input, opts = {}) {
    const neg = new TelnetNegotiator();
    if (opts.cols) { neg.cols = opts.cols; neg.rows = opts.rows; }
    const data = [];
    const sent = [];
    neg.on('data', (b) => data.push(b));
    neg.on('send', (b) => sent.push(b));
    if (opts.byteAtATime) {
        for (const byte of input) neg.feed(Buffer.from([byte]));
    } else {
        neg.feed(Buffer.from(input));
    }
    return {
        neg,
        data: Buffer.concat(data.length ? data : [Buffer.alloc(0)]),
        sent: Buffer.concat(sent.length ? sent : [Buffer.alloc(0)]),
    };
}

// Both feeding modes must agree byte for byte.
function runBoth(input, opts = {}) {
    const whole = run(input, opts);
    const split = run(input, { ...opts, byteAtATime: true });
    assert.deepStrictEqual(split.data, whole.data, 'chunk-boundary data mismatch');
    assert.deepStrictEqual(split.sent, whole.sent, 'chunk-boundary reply mismatch');
    return whole;
}

// 1. Plain data passes untouched.
{
    const r = runBoth(Buffer.from('show version\r\n'));
    assert.strictEqual(r.data.toString(), 'show version\r\n');
    assert.strictEqual(r.sent.length, 0);
}

// 2. Escaped 0xFF in the stream becomes one 0xFF of payload.
{
    const r = runBoth(Buffer.from([0x41, IAC, IAC, 0x42]));
    assert.deepStrictEqual([...r.data], [0x41, 0xFF, 0x42]);
}

// 3. Server WILL ECHO / WILL SGA accepted; unknown WILL refused.
{
    const r = runBoth(Buffer.from([IAC, WILL, OPT_ECHO, IAC, WILL, OPT_SGA, IAC, WILL, 39]));
    assert.deepStrictEqual([...r.sent],
        [IAC, DO, OPT_ECHO, IAC, DO, OPT_SGA, IAC, DONT, 39]);
}

// 4. Server DO SGA/TTYPE/NAWS accepted (NAWS immediately reports size);
//    unknown DO refused.
{
    const r = runBoth(Buffer.from([IAC, DO, OPT_SGA, IAC, DO, 39, IAC, DO, OPT_NAWS]),
        { cols: 132, rows: 43 });
    assert.deepStrictEqual([...r.sent], [
        IAC, WILL, OPT_SGA,
        IAC, WONT, 39,
        IAC, WILL, OPT_NAWS,
        IAC, SB, OPT_NAWS, 0, 132, 0, 43, IAC, SE,
    ]);
}

// 5. TTYPE subnegotiation answers xterm-256color.
{
    const r = runBoth(Buffer.from([IAC, DO, OPT_TTYPE, IAC, SB, OPT_TTYPE, 1, IAC, SE]));
    const expect = [IAC, WILL, OPT_TTYPE,
        IAC, SB, OPT_TTYPE, 0, ...Buffer.from('xterm-256color', 'ascii'), IAC, SE];
    assert.deepStrictEqual([...r.sent], expect);
}

// 6. Re-asking an already-agreed option is not re-answered (ack loop guard).
{
    const r = runBoth(Buffer.from([IAC, WILL, OPT_ECHO, IAC, WILL, OPT_ECHO]));
    assert.deepStrictEqual([...r.sent], [IAC, DO, OPT_ECHO]);
}

// 7. Negotiation interleaved mid-payload does not disturb the payload.
{
    const r = runBoth(Buffer.concat([
        Buffer.from('login'), Buffer.from([IAC, WILL, OPT_ECHO]), Buffer.from(': '),
    ]));
    assert.strictEqual(r.data.toString(), 'login: ');
    assert.deepStrictEqual([...r.sent], [IAC, DO, OPT_ECHO]);
}

// 8. NAWS resize resends dimensions, including the 255-doubling rule.
{
    const r = run(Buffer.from([IAC, DO, OPT_NAWS]));
    r.sent; // initial report consumed above
    const sent = [];
    r.neg.on('send', (b) => sent.push(b));
    r.neg.setSize(255, 50);
    assert.deepStrictEqual([...Buffer.concat(sent)],
        [IAC, SB, OPT_NAWS, 0, IAC, IAC, 0, 50, IAC, SE]);
}

// 9. Outgoing payload escaping doubles 0xFF and nothing else.
{
    const neg = new TelnetNegotiator();
    assert.deepStrictEqual([...neg.encode(Buffer.from([0x01, 0xFF, 0x02]))], [0x01, 0xFF, 0xFF, 0x02]);
    assert.strictEqual(neg.encode('plain').toString(), 'plain');
}

// 10. A DONT for an agreed option turns it off exactly once.
{
    const r = runBoth(Buffer.from([IAC, DO, OPT_SGA, IAC, DONT, OPT_SGA, IAC, DONT, OPT_SGA]));
    assert.deepStrictEqual([...r.sent], [IAC, WILL, OPT_SGA, IAC, WONT, OPT_SGA]);
}

console.log('ok - telnet negotiator (10 scenarios, whole-buffer and byte-split)');
