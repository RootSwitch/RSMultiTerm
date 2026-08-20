'use strict';
// Diagnostics that cannot take the app down.
//
// A packaged GUI app's stdout is frequently not a healthy terminal: it was
// launched from a shell that has since exited, or from Explorer with no
// console at all, or piped to something that stopped reading. Writing there
// raises EPIPE, and an unhandled stream error in the MAIN process is not a
// log line that got dropped - it is Electron's "A JavaScript error
// occurred in the main process" dialog, i.e. a crash report for output
// nobody was listening to. That happened: a smoke run whose stdout was
// piped into a command that quit after three lines left the app sitting
// behind an error dialog.
//
// So: log lines are best effort, always. install() makes a broken pipe a
// non-event, and log()/error() never throw.

let installed = false;

function install() {
    if (installed) return;
    installed = true;
    for (const stream of [process.stdout, process.stderr]) {
        // Without a listener, an 'error' on these streams becomes an
        // uncaught exception. With one, a dead pipe is just a dead pipe.
        if (stream && typeof stream.on === 'function') stream.on('error', () => {});
    }
}

function log(...args) {
    try { console.log(...args); } catch (_) { /* stdout is gone; carry on */ }
}

function error(...args) {
    try { console.error(...args); } catch (_) { /* stderr is gone; carry on */ }
}

module.exports = { install, log, error };
