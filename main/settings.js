'use strict';
// App settings: machine/habit things (paths, mouse mode, fonts). Device
// things live on tree nodes with inheritance, not here. Tolerant load - a
// damaged settings file costs preferences, not data.

const store = require('./store');

const DEFAULTS = {
    schema: 1,
    theme: null,
    mouseMode: 1,              // 1 = select-copies/right-click-pastes, 2 = context menu
    middleClickPaste: true,
    scrollbackLines: 10000,
    // Fits "Start MultiTerm / Edit / Delete / Audit" on one line.
    sidebarWidth: 260,
    // Open the file browser by itself when a device turns out to support it,
    // the way MobaXTerm does. Only ever for the focused pane.
    autoOpenFileBrowser: true,
    font: { family: 'Cascadia Mono', size: 13 },
    // Terminal palette: 'theme' follows the app theme (so Parchment does not
    // frame a near-black terminal), 'dark' pins the original dark surface,
    // 'custom' uses `background` verbatim.
    terminalColors: { mode: 'theme', background: null },
    defaultLogFolder: null,    // null = alongside the app
    logTimestamps: true,
    teamSync: { filePath: null, pollSeconds: 60, checkOnFocus: true },
    // Off by default: a sweep of a few hundred devices looks like a port
    // scan to security monitoring, so it happens when a human asks.
    healthcheck: { concurrency: 8, timeoutMs: 3000, retryDelayMs: 60000 },
    confirmations: { pasteMultilineBroadcast: true, pasteMultiline: true, closeManyTabs: true },
    // OSC 52: let a remote program (tmux, vim, kitty's kitten) put text on
    // the LOCAL clipboard. Write is the useful, low-risk half and is on by
    // default. Read - a remote asking what is ON the clipboard - is an
    // exfiltration path (a password just copied) and is NEVER honored,
    // which is a code guarantee, not a setting.
    osc52: { allowWrite: true },
};

let data = null;
const listeners = [];

function init() {
    data = { ...DEFAULTS, ...store.load('settings', {}) };
}

function onChange(fn) { listeners.push(fn); }

function get() { return data; }

// The renderer parses hostile terminal output, so nothing it sends is
// trusted shapewise. Unknown keys are refused, and the values with teeth
// are coerced/clamped - a pollSeconds of 0.001 is a 1ms interval hammering
// the file share.
function sanitize(patch) {
    const out = {};
    for (const [k, v] of Object.entries(patch)) {
        if (!(k in DEFAULTS)) continue;
        out[k] = v;
    }
    if (out.teamSync && typeof out.teamSync === 'object') {
        if ('pollSeconds' in out.teamSync) {
            const n = Number(out.teamSync.pollSeconds);
            out.teamSync.pollSeconds = Number.isFinite(n) ? Math.max(10, Math.min(86400, n)) : 60;
        }
        if ('filePath' in out.teamSync && out.teamSync.filePath !== null &&
            typeof out.teamSync.filePath !== 'string') {
            delete out.teamSync.filePath;
        }
    }
    for (const key of ['scrollbackLines', 'sidebarWidth']) {
        if (key in out) {
            const n = Number(out[key]);
            out[key] = Number.isFinite(n) ? n : DEFAULTS[key];
        }
    }
    return out;
}

function update(patch) {
    for (const [k, v] of Object.entries(sanitize(patch))) {
        if (v !== null && typeof v === 'object' && !Array.isArray(v) &&
            data[k] && typeof data[k] === 'object') {
            data[k] = { ...data[k], ...v };
        } else {
            data[k] = v;
        }
    }
    store.save('settings', data);
    for (const fn of listeners) fn();
    return data;
}

module.exports = { init, get, update, onChange };
