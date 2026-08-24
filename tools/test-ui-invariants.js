'use strict';
// Small structural checks on the renderer that are easy to break silently
// and annoying to notice by eye.
//
// The hidden-attribute one has now bitten twice. `hidden` carries only a
// UA-stylesheet `display: none`, so any rule of ours that sets display -
// and an id selector always wins over the UA sheet - leaves the element on
// screen while `el.hidden` reads true. The quick-connect field groups grew
// one-off `#id[hidden]` guards for it; later the command palette, the
// search bar and the tab strip all shipped with the same fault, each
// setting `hidden` to close and never visually closing. Tests that checked
// `el.hidden` passed the whole time, because the attribute was correct -
// only the pixels were wrong.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');

// 1. The global rule that makes `hidden` authoritative must exist.
assert.ok(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css),
    'style.css must keep the global `[hidden] { display: none !important }` rule - ' +
    'without it, any element whose id sets a display stays visible when hidden');

// 2. Every element the renderer closes by setting `hidden` should be in the
// HTML or created by that script; this catches a rename that leaves the JS
// toggling an element that no longer exists.
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const TOGGLED_IN_HTML = ['tabstrip', 'side-pane-files', 'qc-serial', 'qc-net', 'side-pane-sessions'];
for (const id of TOGGLED_IN_HTML) {
    assert.ok(html.includes(`id="${id}"`), `index.html lost #${id}, which the renderer hides and shows`);
}

// 3. Every script index.html loads must exist - a renamed or deleted module
// fails at load time with nothing but a console error nobody sees.
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
assert.ok(scripts.length > 10, 'expected the renderer to load its module scripts');
for (const src of scripts) {
    assert.ok(fs.existsSync(path.join(PUBLIC, src)), `index.html loads ${src}, which does not exist`);
}

// 4. Buttons the renderer wires by id must be present in the markup.
const wired = new Set();
for (const file of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.js'))) {
    const js = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    for (const m of js.matchAll(/getElementById\('([a-z0-9-]+)'\)\.addEventListener/g)) {
        wired.add(m[1]);
    }
}
assert.ok(wired.size > 5, 'expected the renderer to wire toolbar buttons by id');
for (const id of wired) {
    assert.ok(html.includes(`id="${id}"`),
        `a script wires #${id} directly, but index.html has no such element - ` +
        'that throws during startup and stops every later listener in the file');
}

// 5. The floating menu must dismiss only on an OUTSIDE mousedown. Closing
// on ANY mousedown removed the menu between mousedown and mouseup, so the
// click never reached the item and landed on whatever the menu had been
// covering - every context menu in the app silently did nothing, and could
// press the control underneath instead. Tests missed it for a while because
// calling .click() dispatches no mousedown at all.
const modals = fs.readFileSync(path.join(PUBLIC, 'modals.js'), 'utf8');
assert.ok(!/addEventListener\('mousedown',\s*closeMenu/.test(modals),
    "modals.js must not dismiss the menu on ANY mousedown - that tears the menu out " +
    'of the DOM before the click lands, so menu items stop working entirely');
assert.ok(/contains\(\s*ev\.target\s*\)/.test(modals),
    'the menu dismissal must test whether the mousedown was inside the menu');

// 6. The window must permit clipboard READ as well as write. Allowing only
// the write killed every paste in the app - right-click, middle-click,
// Ctrl+Shift+V and the context menu all go through
// navigator.clipboard.readText() - and it failed silently, so it read as
// "the mouse modes are broken" rather than as a permission problem.
const windows = fs.readFileSync(path.join(__dirname, '..', 'main', 'windows.js'), 'utf8');
for (const perm of ['clipboard-read', 'clipboard-sanitized-write']) {
    assert.ok(windows.includes(`'${perm}'`),
        `windows.js must allow ${perm} - without it the clipboard path fails silently`);
}
assert.ok(/setPermissionRequestHandler/.test(windows) && /setPermissionCheckHandler/.test(windows),
    'both permission handlers are needed: Chromium asks synchronously on some paths');

// 7. The settings font picker needs the local-fonts permission, or
// queryLocalFonts rejects and the list silently degrades to the hardcoded
// fallback on every machine.
assert.ok(windows.includes("'local-fonts'"),
    'windows.js must allow local-fonts - the settings font list needs queryLocalFonts');

// 8. The default Electron menu must be removed, not merely hidden.
// setMenuBarVisibility(false) leaves its accelerators live: Ctrl+R reloads
// the renderer and kills every session, and Ctrl+= / Ctrl+- / Ctrl+0
// page-zoom the whole UI instead of reaching the font-zoom shortcuts.
const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
assert.ok(/^\s*Menu\.setApplicationMenu\(null\)/m.test(mainJs),
    'main.js must call Menu.setApplicationMenu(null) - a hidden default menu ' +
    'still owns Ctrl+R (reload = all sessions dead) and the Ctrl+zoom keys');

// 9. The Ctrl+wheel font-zoom listener must be non-passive: without
// { passive: false } the preventDefault is ignored and Chromium may treat
// the gesture as page zoom. And it must only claim wheels over a terminal.
const termPane = fs.readFileSync(path.join(PUBLIC, 'term-pane.js'), 'utf8');
const wheelIdx = termPane.indexOf("addEventListener('wheel'");
assert.ok(wheelIdx !== -1, 'term-pane.js lost the Ctrl+wheel font-zoom listener');
const wheelBlock = termPane.slice(wheelIdx, wheelIdx + 600);
assert.ok(/passive:\s*false/.test(wheelBlock),
    'the wheel listener must pass { passive: false } or preventDefault is a no-op');
assert.ok(wheelBlock.includes(".closest('.rs-term-host')"),
    'the wheel zoom must only claim wheels over a terminal pane, not the whole app');

// 10. A device's directory listing is untrusted input. Anything that turns
// a remote file NAME into a LOCAL path must go through localName(), or a
// server answering with '..\..\Startup\evil.exe' writes outside the
// folder the user picked.
const sftp = fs.readFileSync(path.join(PUBLIC, 'sftp-panel.js'), 'utf8');
assert.ok(/function localName\(/.test(sftp),
    'sftp-panel.js must keep localName() - remote names steer local writes without it');
const dlMany = sftp.slice(sftp.indexOf('async function downloadMany'), sftp.indexOf('function status('));
assert.ok(dlMany.includes('localName('),
    'downloadMany must sanitize each remote name before joining it to the local folder');
assert.ok(!/local: dir \+ sep \+ f\.name/.test(dlMany),
    'downloadMany must never write to the raw remote name');

// 11. The dangerous smoke hooks (renderer code execution, arbitrary file
// write) must stay behind devOnlyHook, which refuses them when packaged.
const devHooks = fs.readFileSync(path.join(__dirname, '..', 'main', 'dev-hooks.js'), 'utf8');
assert.ok(/app\.isPackaged/.test(devHooks) && /return null/.test(devHooks),
    'dev-hooks.js must refuse test hooks in a packaged build');
// Plain string counting, not regex: the point is that the ONLY reads of
// these env vars go through the gate.
const countOf = (hay, needle) => hay.split(needle).length - 1;
for (const [file, hook] of [['main.js', 'RSMT_SMOKE_PROBE'], ['ipc.js', 'RSMT_SMOKE_SAVETEXT'],
    ['ssh-keys.js', 'RSMT_SSH_DIR']]) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main', file), 'utf8');
    assert.ok(countOf(src, "devOnlyHook('" + hook + "')") >= 1,
        `${file} must read ${hook} through devOnlyHook`);
    // Any other read of the same variable walks straight past the gate.
    // main.js keeps exactly one, to log that a packaged build refused it.
    const direct = countOf(src, 'process.env.' + hook);
    const allowed = countOf(src, 'else if (process.env.' + hook + ')');
    assert.strictEqual(direct - allowed, 0,
        `${file} reads ${hook} directly - that bypasses the packaged-build refusal`);
}

// 12. The Settings dialog sells "Log folder" and "Log timestamps"; the
// logging resolver must actually consult them. Both shipped decorative
// once - saved faithfully, read by nothing.
const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc.js'), 'utf8');
// Slice ONLY the resolver: currentLogDir below it also mentions the
// setting, and its reference must not vouch for the resolver's - that
// exact aliasing let a planted defect through once.
const resolveBody = ipcSrc.slice(ipcSrc.indexOf('function resolveLogging'),
    ipcSrc.indexOf('function currentLogDir'));
assert.ok(resolveBody.includes('defaultLogFolder'),
    'resolveLogging must consult settings defaultLogFolder - the Settings field is decorative without it');
assert.ok(resolveBody.includes('logTimestamps'),
    'resolveLogging must consult settings logTimestamps - the Settings field is decorative without it');

// 13. The idle animation is an OVERLAY. It may never write into a terminal
// or talk to a session port - a screensaver that paints frames into the
// buffer would corrupt scrollback, pollute session logs, and interleave
// with device output. And the keystroke that wakes it must be swallowed
// before a terminal sees it.
const idle = fs.readFileSync(path.join(PUBLIC, 'idle.js'), 'utf8');
assert.ok(!/term\.write\(/.test(idle) && !/postMessage\(/.test(idle),
    'idle.js must never call term.write or post to a session port - overlay only');
const wake = idle.slice(idle.indexOf('function onWakeKey'), idle.indexOf('function onWakeMouse'));
assert.ok(/preventDefault\(\)/.test(wake) && /stopImmediatePropagation\(\)/.test(wake),
    'the waking keystroke must be prevented and stopped, or an Enter reaches a device');
assert.ok(/addEventListener\('keydown', onWakeKey, \{ capture: true \}\)/.test(idle),
    'the wake listener must run in the capture phase, ahead of xterm');

// 14. What Windows shows for the app. FileDescription is misnamed: it is
// the label Windows puts on the taskbar jump list, in Task Manager and in
// Explorer's Description column, so it has to be the app's NAME. Shipping
// package.json's description there made right-clicking the taskbar button
// offer a whole sentence where "RSMultiTerm" belongs.
const { versionStrings } = require('./after-pack');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const stamped = versionStrings(pkg);
assert.strictEqual(stamped.FileDescription, 'RSMultiTerm',
    'FileDescription is the name Windows shows in the taskbar and Task Manager - ' +
    'it must be the app name, not the description');
assert.strictEqual(stamped.ProductName, 'RSMultiTerm');
assert.strictEqual(stamped.Comments, pkg.description,
    'the sentence belongs in Comments, which is the field meant for one');
// The Team concept was re-homed as session sync; user-visible strings must
// not still say "team". This one ships inside the exe, where it is easy to
// forget it exists at all.
assert.ok(!/\bteam\b/i.test(pkg.description),
    'package.json description still says "team" - it is stamped into the exe ' +
    'and shown by Windows, and the feature is called session sync now');

console.log(`ok - ui invariants (hidden rule, outside-click menus, clipboard perms, ` +
    `no default menu, wheel zoom, remote-name sanitizing, gated dev hooks, idle overlay-only, ` +
    `exe metadata, ` +
    `${scripts.length} scripts, ${wired.size} wired ids)`);
