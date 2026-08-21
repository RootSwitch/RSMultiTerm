'use strict';
// Which directories may hold session logs, in preference order. Pure - no
// Electron, no filesystem - so every combination is testable; ipc.js feeds
// it the real paths and probes writability down the list.
//
// Two exclusions, each learned the embarrassing way:
//
// - The Desktop. A portable exe parked there was growing a logs/<date>/
//   tree next to the wallpaper. "Beside the app" is a self-containment
//   nicety, and it loses to that surprise.
// - Anything under the temp directory. The first fix skipped the Desktop
//   and fell through to "beside the exe" - but a portable build's exe IS
//   the extracted copy running from %TEMP%, so logs moved from the desktop
//   into an extraction directory that changes between logon sessions.
//   Sessions appeared to lose their history; the older logs were stranded
//   in earlier temp folders. Logs are a record, temp is ephemeral by
//   definition, and no fallback chain may ever marry the two.
//
// RSMT_LOGDIR is exempt from both: an explicit override is the user's call.

const path = require('path');

function norm(p) {
    try {
        return path.resolve(p).toLowerCase();
    } catch (_) {
        return null;
    }
}

// env: {envOverride, isPackaged, portableDir, exeDir, devDir,
//       desktop, tmpdir, documents}
function logDirCandidates(env) {
    const out = [];
    const desktop = env.desktop ? norm(env.desktop) : null;
    const tmp = env.tmpdir ? norm(env.tmpdir) : null;

    const usable = (dir) => {
        if (!dir) return false;
        const n = norm(dir);
        if (!n) return false;
        if (desktop && n === desktop) return false;
        if (tmp && (n === tmp || n.startsWith(tmp + path.sep))) return false;
        return true;
    };

    if (env.envOverride) out.push(env.envOverride);

    if (env.isPackaged) {
        if (env.portableDir) {
            // Beside the portable exe the USER placed - and only that. The
            // running exe's own directory is the temp extraction; offering
            // it as a fallback is how logs ended up ephemeral.
            if (usable(env.portableDir)) out.push(path.join(env.portableDir, 'logs'));
        } else if (usable(env.exeDir)) {
            out.push(path.join(env.exeDir, 'logs'));
        }
    } else if (env.devDir) {
        out.push(path.join(env.devDir, 'logs'));
    }

    if (env.documents) out.push(path.join(env.documents, 'RSMultiTerm', 'logs'));
    return out;
}

module.exports = { logDirCandidates };
