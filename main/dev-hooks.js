'use strict';
// Test hooks that must not exist in a shipped build.
//
// The smoke harness drives the app through environment variables, and two
// of them are dangerous to ship: RSMT_SMOKE_PROBE is handed to
// executeJavaScript (arbitrary code inside the renderer, with every IPC
// channel the app itself has), and RSMT_SMOKE_SAVETEXT names a file to
// write (an arbitrary write). Setting either requires control of the
// process environment, which is not a low bar - but a released binary
// should not carry a code-execution hook at all, so packaged builds refuse
// them outright. The connect-and-screenshot pass keeps working packaged:
// that is what proves a built artifact boots.

// Required by plain-node tests too, where `electron` resolves to a path
// string and there is no app object. No app means no packaged build, which
// is exactly the development case these hooks exist for.
let app = null;
try { app = require('electron').app || null; } catch (_) { /* not electron */ }

function devOnlyHook(name) {
    if (app && app.isPackaged) return null;
    return process.env[name] || null;
}

module.exports = { devOnlyHook };
