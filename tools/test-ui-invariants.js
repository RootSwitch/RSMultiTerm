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

// 14. Popup menus come from Modals.menu, which is the only code that
// knows how to flip a menu back on screen near an edge and how to give
// the keyboard back afterwards. The terminal context menu had its own
// copy with neither, so right-clicking near the bottom of the window put
// half the menu off screen, and Paste left focus on a button that had
// just been removed - the pane had to be clicked again before Enter
// would send the command.
const ctx = fs.readFileSync(path.join(PUBLIC, 'context-menu.js'), 'utf8');
assert.ok(/Modals\.menu\(/.test(ctx),
    'context-menu.js must build its menu with Modals.menu, not by hand');
assert.ok(!/position:fixed;left:/.test(ctx),
    'context-menu.js must not position a popup itself - edge flipping lives in Modals.menu');

assert.ok(/function restoreFocus\(/.test(modals),
    'modals.js must keep restoreFocus - a menu or dialog that closes has to hand the keyboard back');
const closeMenuBody = modals.slice(modals.indexOf('function closeMenu()'),
    modals.indexOf('function restoreFocus('));
assert.ok(closeMenuBody.includes('restoreFocus()'),
    'closeMenu must restore focus, or the key after a menu action goes nowhere');
assert.ok(/returnFocusTo = cameFrom;/.test(modals),
    'closing a dialog must restore the focus it took - confirming a paste must not leave the pane dead');
// Restoring must never steal focus from something that deliberately took
// it: a menu item that opens a dialog, or a dialog that focuses a field.
const restoreBody = modals.slice(modals.indexOf('function restoreFocus('));
assert.ok(/now !== document\.body/.test(restoreBody),
    'restoreFocus must stand down when something else already holds focus');

// 15. The contrast floor must reach xterm at BOTH ends: new terminals get
// it at construction, and open ones get it when the setting changes. A
// setting that only applies to the next session opened is the "decorative
// control" failure this codebase keeps finding.
assert.ok(/minimumContrastRatio: minContrast\(\)/.test(termPane),
    'a terminal must be constructed with the configured contrast floor');
const refresh = termPane.slice(termPane.indexOf('function refreshTheme()'),
    termPane.indexOf('function create('));
assert.ok(/minimumContrastRatio = floor/.test(refresh),
    'refreshTheme must push the contrast floor to open panes, or the setting ' +
    'does nothing until the next session');

// 16. Broadcast counts only panes that can actually receive. A pane in
// 'connecting' has no shell channel, the transport's write() silently
// discards, and counting it produced "pushed the config to 5 of 6
// switches" with the toolbar claiming 6 of 6.
const multiExec = fs.readFileSync(path.join(PUBLIC, 'multi-exec.js'), 'utf8');
const partBody = multiExec.slice(multiExec.indexOf('function participants('),
    multiExec.indexOf('function routeInput('));
assert.ok(partBody.includes('isReady('),
    'participants must require a pane to be connected, not merely not-dead');
assert.ok(/isReady\(sessionId\)[\s\S]{0,120}state === 'connected'/.test(termPane),
    "TermPanes.isReady must mean state === 'connected'");
// ...and the chrome tracks state changes, or the count lies at the exact
// moment a pane dies or comes up mid-broadcast.
const setStateBody = termPane.slice(termPane.indexOf('function setState('),
    termPane.indexOf('function isReady('));
assert.ok(setStateBody.includes('refreshChrome()'),
    'setState must refresh the broadcast chrome when a pane changes state');

// 17. Right-click paste confirms exactly like every other broadcast paste.
// It used to require multiline before confirming anything, so a single-line
// "reload" fanned to eight switches with no dialog - quieter than
// Ctrl+Shift+V, which this file's own header promises it never is.
const ctxMenu = fs.readFileSync(path.join(PUBLIC, 'context-menu.js'), 'utf8');
assert.ok(/if \(targets\.length > 1 \|\|[\s\S]{0,40}\(lines\.length > 1/.test(ctxMenu),
    'pasteInto must confirm ANY broadcast paste, single-line included');

// 18. Long transfers are exempt from the 30s IPC timeout - all of them.
// downloadTree was missing from the exemption and any tree slower than 30
// seconds was reported failed while the engine kept downloading it.
// Matched per-op rather than as one literal line: the condition wraps as
// ops are added, and the property is WHICH ops are exempt, not how the
// line breaks. uploadTree joined the list the day folder upload landed -
// its walk of a big tree is exactly as legitimately slow as the download.
{
    const cond = ipcSrc.match(/if \(req\.op !== 'download'[\s\S]{0,200}?\) \{/);
    assert.ok(cond, 'the sftp op timeout exemption must exist');
    for (const op of ['download', 'upload', 'downloadTree', 'uploadTree']) {
        assert.ok(cond[0].includes(`req.op !== '${op}'`),
            `${op} must be exempt from the sftp op timeout - a long transfer is not a hang`);
    }
}

// 19. Every socket in the TFTP write path carries an error listener. An
// ICMP port-unreachable from a vanished client surfaces as 'error' on
// Windows; with no listener that throws, and the engine hosts every
// session there is. The read path had this from day one.
const fieldSrc = fs.readFileSync(path.join(__dirname, '..', 'engine', 'field-servers.js'), 'utf8');
const writeBody = fieldSrc.slice(fieldSrc.indexOf('function tftpWrite('),
    fieldSrc.indexOf('function startTftp('));
assert.ok(writeBody.includes("sock.on('error'"),
    'tftpWrite must handle socket errors - an unreachable client must not crash the engine');
const refuseBody = fieldSrc.slice(fieldSrc.indexOf('function refuse('),
    fieldSrc.indexOf('function tftpWrite('));
assert.ok(refuseBody.includes(".on('error'"),
    'the refuse sub-socket must handle errors too');

// 20. A session created after an await must land in a tab or be hung up.
// reconnect, duplicate and open-into-current-tab all capture their target
// before awaiting a dial the user can outlast; addSession/replaceSession
// used to no-op silently when the target was gone, leaving a live,
// authenticated, INVISIBLE connection with no close button. The tab
// helpers now report success, and every after-await caller must check.
const tabsSrc = fs.readFileSync(path.join(PUBLIC, 'tabs.js'), 'utf8');
assert.ok(/function addSession\(tabId, sessionId\) \{[\s\S]{0,220}?if \(!tab\) return false;/.test(tabsSrc),
    'addSession must return false when the tab is gone, not silently no-op');
assert.ok(/function replaceSession\(oldId, newId\) \{[\s\S]{0,120}?if \(!tab\) return false;/.test(tabsSrc),
    'replaceSession must return false when the old session is in no tab');
const appSrc = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
assert.ok(/function disposeOrphan\(/.test(appSrc),
    'app.js must keep disposeOrphan - the hang-up for sessions with nowhere to appear');
assert.ok(/if \(!window\.Tabs\.replaceSession\(oldSessionId, res\.sessionId\)\) \{[\s\S]{0,40}disposeOrphan/.test(appSrc),
    'reconnectPane must dispose the fresh session when its pane closed mid-dial');
assert.ok(/if \(!window\.Tabs\.addSession\(tab\.id, res\.sessionId\)\) \{[\s\S]{0,40}disposeOrphan/.test(appSrc),
    'duplicatePane must dispose the duplicate when its tab closed mid-dial');
const treeSrc = fs.readFileSync(path.join(PUBLIC, 'session-tree.js'), 'utf8');
assert.ok(/if \(!window\.Tabs\.addSession\(tab\.id, r\.sessionId\)\) \{[\s\S]{0,80}newTab\(r\.title\)/.test(treeSrc),
    'openSessions must give the session a fresh tab when the current tab closed mid-dial');

// 21. Growing an ARMED broadcast tab is a safety event. Merge disarms -
// production boxes deliberately in another tab must not silently become
// keystroke recipients - and a single added pane warns with the new count.
assert.ok(/function noteTabGrew\(/.test(multiExec),
    'multi-exec must keep noteTabGrew - armed tabs must not grow silently');
const bulkBody = multiExec.slice(multiExec.indexOf('function noteTabGrew('),
    multiExec.indexOf('window.MultiExec = {'));
assert.ok(/s\.enabled = false;/.test(bulkBody),
    'a bulk merge into an armed tab must DISARM broadcast, not merely warn');
assert.ok(/noteTabGrew\(target\.id, moved, \{ bulk: true \}\)/.test(tabsSrc),
    'mergeAll must report its growth as bulk');
assert.ok(/noteTabGrew\(tabId, 1, \{ bulk: false \}\)/.test(tabsSrc),
    'addSession must report a single-pane growth');

// 22. Dialogs trap Tab. Without it, Tab walked out to the xterm textarea
// behind the backdrop and the next keystrokes went to a live device -
// through the broadcast router if armed - mid password prompt.
assert.ok(/e\.key === 'Tab'/.test(modals) && /shiftKey && document\.activeElement === first/.test(modals),
    'modals.js must trap Tab inside the dialog, wrapping in both directions');

// 23. SCP carries the same discipline as SFTP: progress throttled to 4/s
// (every event is an engine-to-main-to-renderer IPC message) and the
// download honors write backpressure instead of buffering a whole image.
const scpSrc = fs.readFileSync(path.join(__dirname, '..', 'engine', 'scp.js'), 'utf8');
assert.ok(/Date\.now\(\) - lastProgress >= 250/.test(scpSrc),
    'scp download progress must be throttled like sftp');
assert.ok(/Date\.now\(\) - lastUp >= 250/.test(scpSrc),
    'scp upload progress must be throttled like sftp');
assert.ok(/stream\.pause\(\);\s*[\s\S]{0,80}out\.once\('drain'/.test(scpSrc),
    'scp download must pause the channel when the local disk falls behind');

// 24. The review's low-severity batch, pinned structurally.
// Overlapping file listings must not interleave (a sequence token), SCP
// mode must not route into list(), and batch downloads must continue past
// a failed file instead of abandoning the rest.
assert.ok(/\+\+listSeq/.test(sftp) && /seq !== listSeq/.test(sftp),
    'sftp-panel list() must carry a sequence token so stale listings cannot paint');
assert.ok(/transferMode === 'scp'\) return renderScpMode\(\)/.test(sftp),
    'list() must re-render SCP mode, not throw the SCP error over the panel');
assert.ok(/failed\.push/.test(sftp),
    'downloadMany must continue past a failed file, collecting failures');
// confirmPaste must ride Modals.open (Escape stack, focus trap, handback)
// and hand the keyboard to CANCEL - Send pre-focused meant the Enter meant
// for the terminal instantly confirmed a multi-device send.
const mePaste = multiExec.slice(multiExec.indexOf('function confirmPaste('));
assert.ok(/window\.Modals\.open\(/.test(mePaste),
    'confirmPaste must be built on Modals.open, not a bespoke backdrop');
assert.ok(/cancel\.focus\(\)/.test(mePaste) && !/ok\.focus\(\)/.test(mePaste),
    'confirmPaste must focus Cancel, never Send');
// The baud list is shared, and an unknown stored rate is kept visible
// rather than silently rewritten to the first option on save.
assert.ok(/window\.App\.BAUDS/.test(fs.readFileSync(path.join(PUBLIC, 'connect-forms.js'), 'utf8')),
    'the session editor must build its baud list from the shared App.BAUDS');
assert.ok(/if \(!bauds\.includes\(current\)\) bauds\.push\(current\)/.test(
    fs.readFileSync(path.join(PUBLIC, 'connect-forms.js'), 'utf8')),
    'a stored baud missing from the list must be appended, not rewritten');
// Snippet parameters are values, not replacement patterns.
assert.ok(/\(\) => f\.value\.trim\(\)/.test(fs.readFileSync(path.join(PUBLIC, 'snippets-ui.js'), 'utf8')),
    'snippet substitution must use a function so $& in a value stays literal');
// Profile names are data in selectors.
assert.ok(/CSS\.escape\(key\)/.test(fs.readFileSync(path.join(PUBLIC, 'connect-forms.js'), 'utf8')),
    'clearBanner must CSS.escape the key - a quote in a profile name broke it');
// Quick-connect failures surface.
assert.ok(/connectOrSay/.test(appSrc),
    'quick connect must catch and banner failures instead of vanishing');
// The pane record carries what snapshots and renames need.
assert.ok(/highlightSet: highlightSet \|\| null/.test(termPane),
    'the pane must store its highlight set or snapshots save null');
assert.ok(/pane\.title = n\.name/.test(treeSrc),
    'a tree rename must reach open panes');
// Zoom modifier is a choice.
assert.ok(/zoomNeedsShift/.test(appSrc),
    'font zoom must consult the zoomModifier setting (emacs undo lives on Ctrl+Minus)');
// Engine structural: logger counts bytes and survives a stalled share;
// serial says when the line is behind; hop timeouts reach tunnel chains;
// the SSH verifier fails closed; SCP surfaces mid-send errors.
const loggerSrc = fs.readFileSync(path.join(__dirname, '..', 'engine', 'logger.js'), 'utf8');
assert.ok(/Buffer\.byteLength\(data\)/.test(loggerSrc),
    'the logger must count bytes, not UTF-16 units, or rotation drifts');
assert.ok(/fell behind/.test(loggerSrc),
    'the logger must bound memory on a stalled destination and say so');
const serialSrc = fs.readFileSync(path.join(__dirname, '..', 'engine', 'transports', 'serial.js'), 'utf8');
assert.ok(/_pendingWrite/.test(serialSrc),
    'serial writes must track the backlog and surface it in the status line');
assert.ok(/hop\.timeoutMs = hostkeys\.isKnown/.test(ipcSrc) &&
    ipcSrc.indexOf('hop.timeoutMs = hostkeys.isKnown') !== ipcSrc.lastIndexOf('hop.timeoutMs = hostkeys.isKnown'),
    'tunnel chains must get the same first-contact timeout as session hops');
const sshSrc = fs.readFileSync(path.join(__dirname, '..', 'engine', 'transports', 'ssh.js'), 'utf8');
assert.ok(/return verify\(false\)/.test(sshSrc),
    'a missing host verifier must fail closed, not accept any key');
assert.ok(/phase === 'sending'/.test(scpSrc),
    'scp upload must read acks during the body - "flash is full" arrives mid-send');
// The field spec is validated in main before anything listens.
assert.ok(/is not an address on this machine/.test(ipcSrc) && /the served folder does not exist/.test(ipcSrc),
    'rs:field.start must validate bind address and root before starting a listener');

// 25. The security amendments. Loaded JSON is shape-checked (a valid-JSON
// wrong-shape highlights.json used to stop the app launching, inside
// whenReady, with no recovery message); the local logging folder is
// confined the way the team path already confined it; and the team file's
// node id FIELD is guarded, not only its map key.
const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'store.js'), 'utf8');
assert.ok(/function shaped\(/.test(storeSrc) && /function shapedCritical\(/.test(storeSrc),
    'store.js must offer shape-checked loads for rebuildable and critical files');
const hlSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'highlights.js'), 'utf8');
assert.ok(/store\.shaped\('highlights'/.test(hlSrc),
    'highlights must load shape-checked - it runs before the window exists');
assert.ok(/function safeLogDir\(/.test(ipcSrc) &&
    /dir: safeLogDir\(v\.folder\) \|\| safeLogDir\(appCfg\.defaultLogFolder\)/.test(ipcSrc),
    'the log folder must be confined in main, matching the team serializer');
const teamSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'team-serializer.js'), 'utf8');
assert.ok(/disagrees with its own id field/.test(teamSrc),
    "the team file's node id field must be checked, not only its map key");

// 26. Failures reach the PANE, even the ones main decides before the
// engine ever hears about the session (credential scope, tripped
// profiles). Those travel the broadcast event, not the per-session port -
// and they can fire before the pane exists, so app.js holds them and
// term-pane collects on create. Without this chain the first scope refusal
// in real use was an orange dot that sat there forever, wordless.
assert.ok(/earlyStatus\.set\(m\.sessionId/.test(appSrc),
    'app.js must hold status events that arrive before their pane exists');
assert.ok(/takeEarlyStatus/.test(termPane),
    'term-pane must collect held status on create, or pre-pane refusals are lost');
const deadWrite = termPane.slice(termPane.indexOf('DEAD.has(state) && !wasDead'));
assert.ok(/plainText\(detail\)/.test(deadWrite.slice(0, 600)),
    'a dead pane must say WHY in the terminal, not only in a dot color');
// "Paste to all panes" means all panes whether or not broadcast is armed -
// arming is for keystrokes; this action IS a one-shot broadcast.
const pasteAllBody = multiExec.slice(multiExec.indexOf('async function pasteAll('),
    multiExec.indexOf('function confirmPaste('));
assert.ok(!/s\.enabled \?/.test(pasteAllBody),
    'pasteAll must not gate its targets on broadcast being armed');
assert.ok(/participants\(tab\)/.test(pasteAllBody),
    'pasteAll targets the participants - connected, not excluded');
// The tree offers Duplicate on a session and a menu on the blank space.
// Case-insensitive: what this pins is that the menu item EXISTS, not how
// it is capitalized. The Title Case pass broke it once, which is the
// invariant asserting the wrong thing rather than the label being wrong.
assert.ok(/Duplicate session\.\.\./i.test(treeSrc),
    'the session context menu must offer Duplicate');
assert.ok(/function blankMenu\(/.test(treeSrc) &&
    /closest\('\.tree-row, \.tree-details'\)/.test(treeSrc),
    'the blank space below the tree must have its own menu, without stealing row clicks');
// Green means connected NOW, and nothing else: the "answered a while ago"
// dot is gone, so an imported list cannot look half-connected.
assert.ok(!/'tree-health ok'/.test(treeSrc) && !/\? 'ok' :/.test(treeSrc),
    'the tree must not paint a green audit dot - green is reserved for live sessions');

// 27. Every idle style declares a mood, or the Settings picker silently
// files it under Calm and a new lively animation joins a rotation somebody
// deliberately made quiet.
const idleSrc = fs.readFileSync(path.join(PUBLIC, 'idle.js'), 'utf8');
const styleIds = [...idleSrc.matchAll(/STYLES\.(\w+) = \{/g)].map((m) => m[1]);
assert.ok(styleIds.length >= 14, `expected the full style set, found ${styleIds.length}`);
const labelled = [...idleSrc.matchAll(/label: '[^']+', screen: (?:true|false), mood: '(calm|lively)'/g)];
assert.strictEqual(labelled.length, styleIds.length,
    `every style needs a mood - ${styleIds.length} styles, ${labelled.length} moods`);
assert.ok(/mood: s\.mood \|\| 'calm'/.test(idleSrc),
    'Idle.styles() must expose the mood so Settings can group without a second list');
// The draw-cost meter tools/bench-idle.js reads.
assert.ok(/frameCost: \(\) => \(\{ frames, ms: frameMs \}\)/.test(idleSrc),
    'idle.js must expose frameCost - an animation nobody can measure is one nobody can defend');
// The grouped picker: a select-all per mood, and "none ticked" must mean
// "no preference" rather than silently disabling Surprise me.
const settingsSrc = fs.readFileSync(path.join(PUBLIC, 'settings-ui.js'), 'utf8');
assert.ok(/const MOODS = \[/.test(settingsSrc),
    'the Surprise me picker must group by mood');
assert.ok(/\(same \|\| on\.length === 0\) \? \[\]/.test(settingsSrc),
    'ticking none, or exactly the default set, must store "no preference" - and the ' +
    'default set is the surprise-eligible styles, or a ticked clock would silently vanish');
// The clock is deliberate-only: the random pool must exclude surprise:false
// styles when no picks are stored.
assert.ok(/surprise !== false\)/.test(idleSrc),
    "'Surprise me' must skip surprise:false styles unless picked by name");

// 28. Unread output reaches the tab strip. Output landing in a
// background tab must set the pane's unread flag ONCE (per burst, not per
// chunk), the strip must show it, and ACTIVATING the tab - not focusing
// each pane - must clear it, because the grid shows every pane at once.
assert.ok(/if \(!pane\.unread && window\.Tabs\)/.test(termPane),
    'the data path must mark unread only on the transition, not per chunk');
assert.ok(/unread: false,/.test(termPane), 'the pane record carries the unread flag');
assert.ok(/function markRead\(/.test(tabsSrc) && /if \(tab\) markRead\(tab\);/.test(tabsSrc),
    'activating a tab must mark its sessions read');
assert.ok(/classList\.toggle\('unread'/.test(tabsSrc),
    'updateStatus must paint the unread badge');
assert.ok(/\.tab\.unread \.tab-label::before/.test(css),
    'style.css must draw the unread dot');
// Commands-on-connect: a shared file that can type into every reader's
// devices is an injection channel, so folder defaults must be whitelisted
// on the way IN - and the engine must cancel its timers when the session
// dies. This assertion used to grep the PUBLISH path (serializeNodes),
// which is the half that was never at risk: a hostile file meets
// validateTeamFile, and that is what must hold the line. The behavioral
// test lives in tools/test-merge.js; this pins the shape.
const serializerSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'team-serializer.js'), 'utf8');
assert.ok(/const SHARED_DEFAULTS = /.test(serializerSrc),
    'team-serializer must define a whitelist for folder defaults');
assert.ok(!/SHARED_DEFAULTS = \[[^\]]*'onConnect'/s.test(serializerSrc),
    'onConnect must NOT be an adoptable folder default - it is auto-typed into live sessions');
assert.ok(!/SHARED_DEFAULTS = \[[^\]]*'proxy'/s.test(serializerSrc),
    'proxy must NOT be an adoptable folder default - it decides where sessions dial through');
{
    // The whitelist has to be APPLIED in the ingest path, not merely
    // declared: this is the exact hole the 2026-08-25 review found.
    const ingest = serializerSrc.slice(serializerSrc.indexOf('function validateTeamFile'));
    assert.ok(/SHARED_DEFAULTS/.test(ingest),
        'validateTeamFile must apply the folder-defaults whitelist on ingest');
}
const sessionSrc = fs.readFileSync(path.join(__dirname, '..', 'engine', 'session.js'), 'utf8');
assert.ok(/for \(const t of this\._onConnectTimers \|\| \[\]\) clearTimeout\(t\);/.test(sessionSrc),
    'a dying session must cancel pending on-connect sends');

// 29. Output triggers: a watch rule matches COMPLETED buffer lines (the
// write stream splits tokens across chunks; the viewport scan never runs
// for a background pane), rate-limits per pane and rule, badges through
// Tabs.markAlert, and only notifies the OS when the window is unfocused.
const hlEngineSrc = fs.readFileSync(path.join(PUBLIC, 'highlight.js'), 'utf8');
assert.ok(/onLineFeed/.test(hlEngineSrc),
    'watch must match on completed lines via onLineFeed, not the write stream');
assert.ok(/WATCH_COOLDOWN_MS/.test(hlEngineSrc),
    'watch alerts must rate-limit - a chatty match is one alert, not a flood');
assert.ok(/document\.hasFocus\(\)/.test(hlEngineSrc),
    'system notifications only when the window is not focused');
assert.ok(/function markAlert\(/.test(tabsSrc) && /hasAlert\(/.test(tabsSrc),
    'tabs must carry the alert badge');
assert.ok(/pane\.unread \|\| pane\.alert/.test(tabsSrc),
    'activating a tab must clear alerts along with unread');
assert.ok(/'notifications'/.test(windows),
    'windows.js must allow the notifications permission or every alert is silent');
assert.ok(/'watch'/.test(fs.readFileSync(path.join(PUBLIC, 'highlight-rules-ui.js'), 'utf8')),
    'the rules editor must expose the watch column');
// The four-state session circle: live, failed (aged), seen, never - each
// with a tooltip, so the mouseover history the green dots used to carry
// survives the taxonomy.
assert.ok(/tree-health seen/.test(treeSrc) && /tree-health never/.test(treeSrc),
    'the tree must render seen and never states, not just problems');
assert.ok(/Never connected from this app/.test(treeSrc),
    'the never state must explain itself on hover');
assert.ok(/\.tree-health\.never/.test(css) && /\.tree-health\.seen/.test(css),
    'style.css must draw the seen dot and the never ring');

// 30. What Windows shows for the app. FileDescription is misnamed: it is
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
    `exe metadata, shared menus, focus handback, contrast floor, broadcast truth, no orphan sessions, ` +
    `armed-tab growth, focus trap, scp discipline, low-batch pins, shape guards, failure surfacing, ` +
    `${styleIds.length} idle styles mooded, unread badges, on-connect discipline, watch triggers, four-state dots, ` +
    `${scripts.length} scripts, ${wired.size} wired ids)`);
