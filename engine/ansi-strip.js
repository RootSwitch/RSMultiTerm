'use strict';
// Stateful ANSI escape stripper for text-mode session logs. A regex per
// chunk is wrong at exactly the place logs get corrupted: an escape sequence
// split across two socket reads. This is a byte state machine that carries
// its state between feed() calls, same discipline as the telnet negotiator.
//
// Output: printable text with \n line endings (\r dropped), tabs kept.
// CSI, OSC (BEL or ST terminated), DCS/APC/PM/SOS, and two-byte ESC
// sequences are swallowed whole.
//
// UTF-8 is decoded here, byte by byte, for two reasons. First, logs of
// modern Linux sessions carry multi-byte text (box drawing, accents) and
// treating bytes as Latin-1 garbled all of it. Second - the security half -
// UTF-8 continuation bytes land in 0x80-0xbf, overlapping 0x80-0x9f where
// the 8-bit C1 escapes live: U+2502 (the box-drawing bar htop paints)
// encodes as e2 94 82, and the old byte rules read that 0x94 as a C1
// control and dropped it - worse, a continuation byte of 0x9b was read as
// 8-bit CSI and ATE the following text up to an imaginary final byte.
// Decoding first means the C1 checks apply to real code points only. A
// high byte that turns out not to be UTF-8 (a genuinely Latin-1 device) is
// dropped rather than guessed at - but a raw 8-bit C1 control (0x9b et
// al.) still routes into its swallow state, and a UTF-8-ENCODED C1 (c2 9b)
// is caught after decoding, so a "stripped" log can never carry an
// executable sequence by either spelling.

// OSC/DCS payload cap - see the S_OSC state for why.
const MAX_STR = 2048;
const S_TEXT = 0, S_ESC = 1, S_CSI = 2, S_OSC = 3, S_OSC_ESC = 4, S_STR = 5, S_STR_ESC = 6,
    S_ESC_INT = 7, S_UTF8 = 8;

class AnsiStripper {
    constructor() {
        this.state = S_TEXT;
        this.u8 = null;      // UTF-8 bytes collected so far: [lead, ...]
        this.u8need = 0;     // continuation bytes the lead promised
    }

    // buf: Buffer -> string of clean text
    feed(buf) {
        let out = '';
        for (const b of buf) out += this._byte(b);
        return out;
    }

    _byte(b) {
        switch (this.state) {
            case S_TEXT:
                if (b === 0x1b) this.state = S_ESC;
                else if (b === 0x0a) return '\n';
                else if (b === 0x09) return '\t';
                // C1 controls (0x80-0x9f) are the 8-bit escapes: 0x9b IS
                // CSI, 0x9d IS OSC to a terminal. Letting them into a
                // "stripped" log means the log executes sequences when
                // someone cats it - the exact thing text mode prevents.
                // Route the sequence-openers into their states, drop the
                // rest (and DEL) with the other controls.
                else if (b === 0x9b) this.state = S_CSI;
                else if (b === 0x9d) { this.state = S_OSC; this.strLen = 0; }
                else if (b === 0x90 || b === 0x98 || b === 0x9e || b === 0x9f) { this.state = S_STR; this.strLen = 0; }
                else if (b >= 0xc2 && b <= 0xf4) {
                    // UTF-8 lead byte: collect the sequence, decode it
                    // whole. 0xc0/0xc1 and 0xf5-0xff can never start a
                    // valid sequence and fall through to the drop below.
                    this.state = S_UTF8;
                    this.u8 = [b];
                    this.u8need = b >= 0xf0 ? 3 : (b >= 0xe0 ? 2 : 1);
                }
                else if (b >= 0x20 && b < 0x7f) return String.fromCharCode(b);
                // \r, BEL, backspace and other C0 controls, stray UTF-8
                // continuations and invalid leads are dropped; logs are a
                // record, not a replay.
                break;
            case S_UTF8:
                if (b >= 0x80 && b <= 0xbf) {
                    this.u8.push(b);
                    if (this.u8.length === this.u8need + 1) {
                        const bytes = this.u8;
                        this.u8 = null;
                        this.state = S_TEXT;
                        // UTF-8 can spell the C1 controls (c2 80..c2 9f).
                        // Those must strip exactly like their raw 8-bit
                        // twins, or an "encoded" CSI walks straight through
                        // the guard above.
                        if (bytes[0] === 0xc2 && bytes[1] <= 0x9f) {
                            const c1 = bytes[1];
                            if (c1 === 0x9b) this.state = S_CSI;
                            else if (c1 === 0x9d) { this.state = S_OSC; this.strLen = 0; }
                            else if (c1 === 0x90 || c1 === 0x98 || c1 === 0x9e || c1 === 0x9f) { this.state = S_STR; this.strLen = 0; }
                            break;
                        }
                        // Invalid-but-well-formed sequences (overlongs,
                        // surrogates) decode to U+FFFD here, which is the
                        // honest thing for a log to show.
                        return Buffer.from(bytes).toString('utf8');
                    }
                    break;
                }
                // Not a continuation: the collected bytes were not UTF-8
                // after all. Drop them and reprocess this byte as text.
                this.u8 = null;
                this.state = S_TEXT;
                return this._byte(b);
            case S_ESC:
                if (b === 0x5b) this.state = S_CSI;                 // ESC [
                else if (b === 0x5d) { this.state = S_OSC; this.strLen = 0; }            // ESC ]
                else if (b === 0x50 || b === 0x5e || b === 0x5f ||  // DCS APC PM
                         b === 0x58) { this.state = S_STR; this.strLen = 0; }            // SOS
                else if (b >= 0x20 && b <= 0x2f) this.state = S_ESC_INT;
                // ^ intermediates: charset designations (ESC ( B), DECALN
                //   (ESC # 8), etc. run "ESC, intermediates, final" - the
                //   old two-byte assumption leaked the final byte into the
                //   log, so vim sessions accumulated stray Bs.
                else this.state = S_TEXT;                           // two-byte ESC x
                break;
            case S_ESC_INT:
                // Stay through further intermediates, exit on the final.
                if (b < 0x20 || b > 0x2f) this.state = S_TEXT;
                break;
            case S_CSI:
                // Parameter/intermediate bytes 0x20-0x3f; final 0x40-0x7e.
                if (b >= 0x40 && b <= 0x7e) this.state = S_TEXT;
                break;
            case S_OSC:
                // Real terminals cap OSC length for exactly this reason: a
                // stray 0x9d in binary output enters this state, and with no
                // bound the rest of the session's log vanished into an
                // unterminated string. Past the cap, fall back to text.
                if (b === 0x07) this.state = S_TEXT;                // BEL
                else if (b === 0x1b) this.state = S_OSC_ESC;
                else if (++this.strLen > MAX_STR) this.state = S_TEXT;
                break;
            case S_OSC_ESC:
                this.state = b === 0x5c ? S_TEXT : S_OSC;           // ESC \ = ST
                break;
            case S_STR:
                if (b === 0x1b) this.state = S_STR_ESC;
                else if (++this.strLen > MAX_STR) this.state = S_TEXT;
                break;
            case S_STR_ESC:
                this.state = b === 0x5c ? S_TEXT : S_STR;
                break;
        }
        return '';
    }
}

module.exports = { AnsiStripper };
