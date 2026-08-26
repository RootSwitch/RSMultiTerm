'use strict';
// App settings: machine/habit things (paths, mouse mode, fonts). Device
// things live on tree nodes with inheritance, not here. Tolerant load - a
// damaged settings file costs preferences, not data.

const store = require('./store');

// The default terminal font has to exist on the machine or the first launch
// shows a font name nobody has. Cascadia ships with Windows Terminal and
// recent Windows; DejaVu Sans Mono is on essentially every desktop Linux;
// Menlo is macOS. The CSS stack behind these catches the rest.
function defaultFontFamily() {
    if (process.platform === 'win32') return 'Cascadia Mono';
    if (process.platform === 'darwin') return 'Menlo';
    return 'DejaVu Sans Mono';
}

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
    font: { family: defaultFontFamily(), size: 13 },
    // Terminal palette: 'theme' follows the app theme (so Parchment does not
    // frame a near-black terminal), 'dark' pins the original dark surface,
    // 'custom' uses `background` verbatim.
    // minContrast: the floor xterm holds every foreground to against the
    // current background, including the colors a REMOTE program picked -
    // which is the whole point, because bright green from a device's own
    // escape codes is not something a theme can fix. 1 disables it. The
    // default is deliberately gentle: xterm only touches colors that fail
    // the ratio, so 3 rescues what is unreadable and leaves alone what is
    // merely stylish.
    terminalColors: { mode: 'theme', background: null, minContrast: 3 },
    defaultLogFolder: null,    // null = alongside the app
    // Edit-and-sync hands files to this. null = whatever the OS opens the
    // file type with; a path here points at a specific editor executable.
    editorCommand: null,
    logTimestamps: true,
    teamSync: { filePath: null, pollSeconds: 60, checkOnFocus: true },
    // Off by default: a sweep of a few hundred devices looks like a port
    // scan to security monitoring, so it happens when a human asks.
    healthcheck: { concurrency: 8, timeoutMs: 3000, retryDelayMs: 60000 },
    confirmations: { pasteMultilineBroadcast: true, pasteMultiline: true, closeManyTabs: true },
    // Named broadcast line-ups: which SAVED sessions participate when the
    // group is armed. Members are tree node ids; quick connects have no
    // identity to remember and cannot join.
    broadcastGroups: [],   // [{name, nodeIds: []}]
    // The one-time "this machine has PuTTY sessions - import them?" offer.
    // True once it has been shown, whatever was chosen.
    importOfferShown: false,
    // OSC 52: let a remote program (tmux, vim, kitty's kitten) put text on
    // the LOCAL clipboard. Write is the useful, low-risk half and is on by
    // default. Read - a remote asking what is ON the clipboard - is an
    // exfiltration path (a password just copied) and is NEVER honored,
    // which is a code guarantee, not a setting.
    osc52: { allowWrite: true },
    // Font-zoom modifier: 'ctrl' (Ctrl+Plus/Minus/0, the default) or
    // 'ctrl+shift'. Ctrl+Minus is also what xterm sends as C-_ - emacs
    // undo - so people who live in remote emacs can free the keystroke.
    zoomModifier: 'ctrl',
    // Idle animation: off unless asked for. 'random' picks a style each time.
    // picks: which styles "Surprise me" may choose; empty means all.
    // rotateMinutes: how long "Surprise me" stays on one style; 0 = forever.
    idle: { style: 'off', minutes: 5, area: 'panes', picks: [], rotateMinutes: 0 },
    // Field tools remembers the folder you were serving and the ports you
    // set. Nothing here starts anything - it is only what the dialog opens
    // with, so you are not re-typing a path every time you push an image.
    field: { root: null, bind: null, tftpPort: 69, httpPort: 8080, stopAfterMinutes: 60 },
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
    if (out.field && typeof out.field === 'object') {
        for (const [key, lo, hi, dflt] of [['tftpPort', 1, 65535, 69],
            ['httpPort', 1, 65535, 8080], ['stopAfterMinutes', 1, 1440, 60]]) {
            if (!(key in out.field)) continue;
            const n = Number(out.field[key]);
            out.field[key] = Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt;
        }
        for (const key of ['root', 'bind']) {
            if (key in out.field && out.field[key] !== null &&
                typeof out.field[key] !== 'string') delete out.field[key];
        }
    }
    if ('zoomModifier' in out && out.zoomModifier !== 'ctrl' && out.zoomModifier !== 'ctrl+shift') {
        out.zoomModifier = 'ctrl';
    }
    if ('editorCommand' in out && out.editorCommand !== null &&
        typeof out.editorCommand !== 'string') {
        delete out.editorCommand;
    }
    if ('importOfferShown' in out) out.importOfferShown = !!out.importOfferShown;
    // Renderer-shaped structure that lands on disk and is iterated later:
    // hold it to exactly [{name, nodeIds:[...]}] and drop the rest.
    if ('broadcastGroups' in out) {
        const src = Array.isArray(out.broadcastGroups) ? out.broadcastGroups : [];
        out.broadcastGroups = src
            .filter((g) => g && typeof g.name === 'string' && g.name.trim() &&
                Array.isArray(g.nodeIds))
            .slice(0, 100)
            .map((g) => ({
                name: g.name.trim().slice(0, 80),
                nodeIds: g.nodeIds.filter((id) => typeof id === 'string').slice(0, 500),
            }));
    }
    if (out.terminalColors && 'minContrast' in out.terminalColors) {
        // 1 is "off" and 21 is black on white; anything outside that is not
        // a ratio, and xterm would divide by it.
        const n = Number(out.terminalColors.minContrast);
        out.terminalColors.minContrast = Number.isFinite(n) ? Math.max(1, Math.min(21, n)) : 3;
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
    // A cleared font field means "use this machine's default" rather than
    // "use no font at all".
    if (patch && patch.font && !patch.font.family) {
        patch = { ...patch, font: { ...patch.font, family: defaultFontFamily() } };
    }
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
