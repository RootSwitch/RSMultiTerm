'use strict';
// The one place pasted text becomes terminal input. Every paste path -
// right-click, middle-click, Ctrl+Shift+V, broadcast paste-all, the native
// Ctrl+V interceptor, and snippet sends - builds its payload here.
//
// Bracketed paste (DECSET 2004) is the load-bearing part. When the remote
// shell has switched it on (bash 5.1+, zsh, fish all do), the paste is
// wrapped in ESC[200~ ... ESC[201~ and readline holds the WHOLE block in
// its own buffer. Without it, pasted lines execute one at a time and the
// not-yet-read remainder sits in the kernel's tty queue - where a program
// like sudo, which flushes type-ahead on purpose (TCSAFLUSH, so stray
// input cannot become a password attempt), silently DISCARDS it. That is
// how "paste three lines starting with sudo" ran one line and ate the
// other two without a word. Wrapped, nothing executes until Enter and
// nothing can be flushed away - the same behavior as every modern
// terminal. Devices that never enable 2004 (network gear) see exactly the
// bytes they always did.

(function (root) {
    // Terminal paste semantics: newlines become carriage returns.
    function body(text) {
        return String(text).split(/\r\n|\r|\n/).join('\r');
    }

    function payload(bracketed, text) {
        let b = body(text);
        if (!bracketed) return b;
        // Pasted CONTENT must not be able to close the bracket early: text
        // carrying a literal ESC[201~ would end the paste and leave the
        // rest executing as keystrokes - paste injection, the exact attack
        // bracketed paste exists to stop.
        b = b.split('\x1b[201~').join('');
        return `\x1b[200~${b}\x1b[201~`;
    }

    function wantsBracketed(term) {
        return !!(term && term.modes && term.modes.bracketedPasteMode);
    }

    // Payload for pasting into one pane's terminal.
    function forTerm(term, text) {
        return payload(wantsBracketed(term), text);
    }

    // Payload for a snippet SEND: paste semantics plus the accept-line that
    // executes it, outside the bracket so it means "Enter", not content.
    function execForTerm(term, text) {
        return forTerm(term, text) + '\r';
    }

    const api = { body, payload, wantsBracketed, forTerm, execForTerm };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.Paste = api;
})(typeof window !== 'undefined' ? window : null);
