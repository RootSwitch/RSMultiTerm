'use strict';
// Minimal telnet option negotiation, hand-rolled on purpose: every npm telnet
// client is unmaintained, and this failure mode is visible (garbage on
// screen), not silent. Policy is refuse-by-default:
//
//   agree to: SGA (both directions), server ECHO, TTYPE (answers
//   xterm-256color), NAWS (reports window size, resends on resize)
//   everything else: WONT / DONT
//
// The parser is a byte state machine, not a per-chunk regex, because IAC
// sequences split across TCP segment boundaries and a chunk-local scan
// corrupts exactly those - the bug field devices will find on day one.
//
// API: feed(buf) consumes socket bytes and emits 'data' (clean payload) and
// 'send' (negotiation replies for the socket); encode(string|Buffer) escapes
// outgoing payload; setSize(cols, rows) records and (if agreed) reports it.

const { EventEmitter } = require('events');

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const OPT_ECHO = 1, OPT_SGA = 3, OPT_TTYPE = 24, OPT_NAWS = 31;
const TTYPE_IS = 0, TTYPE_SEND = 1;

// Parser states.
const S_DATA = 0, S_IAC = 1, S_NEGOTIATE = 2, S_SB = 3, S_SB_IAC = 4;

// Subnegotiation payloads are tiny - TTYPE is a terminal name, NAWS is four
// bytes - so anything kilobytes deep is a server that never sends IAC SE
// (or binary garbage that happened to contain IAC SB). Without a cap the
// negotiator accumulated the entire remaining stream into sbBuf while
// emitting nothing: the session looked hung and memory climbed. On
// overflow: discard and fall back to data, the same "malformed, drop and
// carry on" policy the SE path already uses.
const MAX_SB = 4096;

class TelnetNegotiator extends EventEmitter {
    constructor(termType = 'xterm-256color') {
        super();
        this.termType = termType;
        this.state = S_DATA;
        this.command = 0;         // WILL/WONT/DO/DONT while in S_NEGOTIATE
        this.sbOption = -1;
        this.sbBuf = [];
        this.cols = 80;
        this.rows = 24;
        // Track what we have agreed to, both to answer NAWS/TTYPE requests
        // and to avoid ack loops (never re-answer an unchanged state).
        this.localOn = new Set();    // options we WILL
        this.remoteOn = new Set();   // options the server WILLs and we DO
    }

    feed(buf) {
        const out = [];
        for (const b of buf) {
            switch (this.state) {
                case S_DATA:
                    if (b === IAC) this.state = S_IAC;
                    else out.push(b);
                    break;
                case S_IAC:
                    if (b === IAC) { out.push(IAC); this.state = S_DATA; }        // escaped 0xFF
                    else if (b === SB) { this.state = S_SB; this.sbOption = -1; this.sbBuf = []; }
                    else if (b === WILL || b === WONT || b === DO || b === DONT) {
                        this.command = b; this.state = S_NEGOTIATE;
                    }
                    else this.state = S_DATA;   // NOP/GA/other bare commands: ignore
                    break;
                case S_NEGOTIATE:
                    this._negotiate(this.command, b);
                    this.state = S_DATA;
                    break;
                case S_SB:
                    if (this.sbOption === -1) this.sbOption = b;
                    else if (b === IAC) this.state = S_SB_IAC;
                    else if (this.sbBuf.length >= MAX_SB) { this.sbBuf = []; this.state = S_DATA; }
                    else this.sbBuf.push(b);
                    break;
                case S_SB_IAC:
                    if (b === IAC) { this.sbBuf.push(IAC); this.state = S_SB; }   // escaped inside SB
                    else if (b === SE) { this._subnegotiate(); this.state = S_DATA; }
                    else this.state = S_SB;     // malformed; drop and carry on
                    break;
            }
        }
        if (out.length) this.emit('data', Buffer.from(out));
    }

    _negotiate(cmd, opt) {
        if (cmd === DO) {
            if (opt === OPT_SGA || opt === OPT_TTYPE || opt === OPT_NAWS) {
                if (!this.localOn.has(opt)) {
                    this.localOn.add(opt);
                    this._send([IAC, WILL, opt]);
                    if (opt === OPT_NAWS) this._sendNaws();
                }
            } else {
                this._send([IAC, WONT, opt]);
            }
        } else if (cmd === DONT) {
            if (this.localOn.delete(opt)) this._send([IAC, WONT, opt]);
        } else if (cmd === WILL) {
            if (opt === OPT_ECHO || opt === OPT_SGA) {
                if (!this.remoteOn.has(opt)) {
                    this.remoteOn.add(opt);
                    this._send([IAC, DO, opt]);
                }
            } else {
                this._send([IAC, DONT, opt]);
            }
        } else if (cmd === WONT) {
            if (this.remoteOn.delete(opt)) this._send([IAC, DONT, opt]);
        }
    }

    _subnegotiate() {
        if (this.sbOption === OPT_TTYPE && this.sbBuf[0] === TTYPE_SEND) {
            const name = Buffer.from(this.termType, 'ascii');
            this._send([IAC, SB, OPT_TTYPE, TTYPE_IS, ...name, IAC, SE]);
        }
        // NAWS has no server-driven subnegotiation; anything else is refused
        // options territory and gets dropped.
    }

    _sendNaws() {
        const c = this.cols, r = this.rows;
        // 16-bit big-endian, 255 bytes doubled per the RFC.
        const raw = [c >> 8 & 0xff, c & 0xff, r >> 8 & 0xff, r & 0xff];
        const esc = [];
        for (const b of raw) { esc.push(b); if (b === IAC) esc.push(IAC); }
        this._send([IAC, SB, OPT_NAWS, ...esc, IAC, SE]);
    }

    setSize(cols, rows) {
        this.cols = cols;
        this.rows = rows;
        if (this.localOn.has(OPT_NAWS)) this._sendNaws();
    }

    // Escape outgoing payload: 0xFF doubles. Everything else passes through -
    // this is a binary-clean path.
    encode(data) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        if (!buf.includes(IAC)) return buf;
        const out = [];
        for (const b of buf) { out.push(b); if (b === IAC) out.push(IAC); }
        return Buffer.from(out);
    }

    _send(bytes) {
        this.emit('send', Buffer.from(bytes));
    }
}

module.exports = {
    TelnetNegotiator,
    IAC, DONT, DO, WONT, WILL, SB, SE,
    OPT_ECHO, OPT_SGA, OPT_TTYPE, OPT_NAWS,
};
