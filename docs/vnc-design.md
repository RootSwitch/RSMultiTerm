# VNC in RSMultiTerm - options, costs, and what it does to the app

Date: 2026-08-23. Written before any code, to be argued with.

The README currently says: "Deliberately absent: RDP, VNC, X11, WSL,
local shells, and the utility grab-bag. This is a terminal for SSH and
text." and "Runtime: `ssh2`, `serialport`. That is the entire tree."
Adding VNC breaks the first sentence on purpose. The question this
document tries to settle is whether it has to break the second one, and
what it costs either way.

Short version of the recommendation, for anyone who does not want to
read the rest: **vendor noVNC, run the socket in the engine, ship a
read-only viewer first, and make "over SSH" the default path rather
than an option.** The reasoning is below, along with the two rejected
alternatives and the part nobody expects to be the hard part - the
keyboard.

---

## 1. Why this is not "just another transport"

SSH, telnet and serial all deliver the same thing to the app: a byte
stream that xterm.js parses into a screen. Every feature in the
renderer is built on top of that one shape - highlight rules scan it,
the diff engine captures it, broadcast writes into it, logging tees it,
search indexes it, snippets paste into it, the SFTP panel rides its
connection.

VNC delivers pixels. Nothing above applies to it. Concretely, in
today's renderer:

| Module | What it does with `pane.term` | What a VNC pane does |
| --- | --- | --- |
| `highlight.js` | scans written text for rules | nothing |
| `multi-exec.js` | broadcast typing to N panes | nothing (see below) |
| `diff-ui.js` | captures command output | nothing |
| `search-ui.js` | xterm search addon | nothing |
| `snippets-ui.js` | pastes into the terminal | nothing |
| `palette.js`, `hints.js`, `context-menu.js` | assume a terminal | need guards |
| `sftp-panel.js` | rides the SSH connection | only if tunnelled over SSH |
| `idle.js` | samples the screen for animations | must skip VNC panes |
| `workspace-ui.js` | saves scrollback | there is no scrollback |

That is 37 references to `pane.term` across 12 files. None of them
crash today because every pane has a terminal. The real integration
cost of VNC is not the protocol - it is turning "a pane" into
"a pane that may or may not be a terminal" without turning the renderer
into a pile of `if (pane.term)`.

The cleanest shape is a small pane interface that both kinds implement
(`focus()`, `resize()`, `destroy()`, `title()`, `isDead()`), with the
terminal-only modules asking `pane.kind === 'term'` once at their entry
point and returning early. That is a refactor worth doing on its own
merits, and it is most of the work.

Broadcast deserves a specific decision: sending one keystroke to eight
switches is a defining feature of this app, and sending one keystroke
to eight VNC desktops is a plausible way to destroy eight machines at
once. My recommendation is that broadcast never includes VNC panes,
and says so in the chrome rather than silently skipping them.

---

## 2. Where the socket lives

Settled by the existing architecture, not by preference.

The renderer's CSP is `connect-src 'none'`. It cannot open a socket at
all, and that is a deliberate line - the renderer parses hostile
terminal output, so it does not get network access. So the RFB socket
lives in the engine `utilityProcess`, exactly like SSH, telnet, serial,
tunnels and the field servers.

The data path already exists and is better than it needs to be.
`main/ipc.js` hands each session a `MessageChannelMain` pair: one port
to the engine, one to the renderer. After setup, session data does not
pass through the main process at all. Framebuffer updates ride that
same port, and `ArrayBuffer`s can be transferred rather than copied.

The open question is where decoding happens.

**Decode in the engine.** Node has `zlib` built in, which Tight and ZRLE
both need. But the engine would then be shipping decoded pixels: a
1920x1080 frame is 8.3 MB of RGBA. Even at a modest frame rate that is
the wrong thing to put through a message port.

**Decode in the renderer.** Send the RFB rectangles as they arrive -
already compressed - and decode into a `<canvas>` on the renderer side.
Compressed rectangles are small, transfers are zero-copy, and the
canvas is where the pixels have to end up anyway. Zlib in the renderer
is `DecompressionStream('deflate')`, which Chromium has natively, and
Tight's JPEG rectangles decode through `createImageBitmap(blob)` - not
subject to `img-src`, since it is not a URL load, so the CSP stays as
it is.

Decode in the renderer. The engine stays a socket pump, which is what
it is for everything else.

One consequence worth stating: `engine/flow.js` - the credit-window
backpressure that makes `show tech` behave - does not transfer. Its
credit is returned when xterm has *parsed* the bytes, which is what
makes the window track true absorption. RFB has its own flow model:
the client asks for updates (`FramebufferUpdateRequest`) and the server
answers. Backpressure is therefore free and structural - if the
renderer is behind, it simply does not ask for the next update. The
Fence and ContinuousUpdates pseudo-encodings refine this. Do not try to
reuse `Flow` here; it is solving a problem RFB does not have.

---

## 3. The three options

### Option A - vendor noVNC (recommended)

noVNC is the reference JavaScript RFB client, MPL-2.0, on npm as
`@novnc/novnc`. It is ES modules, which the renderer can load directly
with `<script type="module">` - no bundler, no build step, and `'self'`
CSP is satisfied by relative imports.

It fits the existing vendoring discipline exactly. `public/vendor/`
already holds xterm and its five addons, `tools/vendor-sync.js` copies
them from `node_modules`, and `tools/vendor-check.js` fails `npm test`
when the vendored bytes stop matching the installed package. Adding
noVNC is adding entries to that manifest. The runtime dependency tree
stays `ssh2` and `serialport`; the README sentence survives intact,
because vendored static files are already carved out of that claim.

What it buys, in rough order of how much you would hate writing it:

- The keyboard. See section 4. This is the real reason.
- Every encoding: Raw, CopyRect, RRE, Hextile, Tight, TightPNG, ZRLE,
  TRLE, and the pseudo-encodings that make a session usable (cursor,
  desktop resize, LastRect, continuous updates, fence).
- The security types beyond plain VNC auth: VeNCrypt/TLS, RA2 for
  RealVNC, Apple's ARD handshake. Each is a small pile of crypto you do
  not want to write, and between them they are the difference between
  "works on my Raspberry Pi" and "works on the thing in the rack".
- Bug-for-bug compatibility with servers that are not quite right, which
  is most of them. RealVNC, TightVNC, TigerVNC, UltraVNC, x11vnc,
  QEMU/Proxmox and Apple Screen Sharing all disagree somewhere.

Costs and caveats:

- **Licensing.** MPL-2.0 is file-level copyleft: vendored files keep
  their headers, and any file we modify must have its source available.
  A public repo satisfies that automatically. It does not infect our
  code - MPL is per-file, unlike GPL. This is a genuinely different
  situation from bundling an iperf3 binary, which was a shipped
  executable with its own CVE surface and AV heuristics.
- **Transport seam.** noVNC wants a WebSocket. The renderer has no
  network. Newer noVNC accepts a channel object in place of a URL, so a
  `MessagePort`-backed shim with `send`/`onmessage`/`close` semantics
  can stand in - **this needs confirming against the exact version we
  vendor before committing to the approach**, and it is the single
  assumption in this document I would check first.
- **Size and audit burden.** It is a meaningful amount of third-party
  code in an app whose selling point is that you can read all of it.
  The honest framing for the README is that it is vendored, hash-checked
  and auditable in-tree, same as xterm - which is already a much larger
  body of code than noVNC.
- **It brings its own UI opinions.** We would use `core/` and leave
  `app/` alone.

### Option B - write our own RFB client

Genuinely feasible for a subset, and I want to be fair to it because
the "pure Node, zero dependencies" instinct has been right every other
time on this project.

A minimum useful client is smaller than it sounds: the 3.8 handshake,
VNC authentication, Raw and CopyRect encodings, and
`FramebufferUpdateRequest` in a loop. That is a few hundred lines and
it will genuinely display a desktop. Hextile is another hundred or so
and is a large win on real links.

Where it stops being cheap:

- **Tight** is the encoding almost every modern server prefers, and it
  is not one format but four sub-encodings with a filter layer and JPEG.
  Skipping it means negotiating down to something slower on every
  connection.
- **ZRLE/TRLE** is a second tiling scheme with its own palette and RLE
  rules.
- **The security types**, as above. VNC auth alone is easy - a 16-byte
  challenge, DES-ECB, with the key bytes bit-reversed, which is the
  famous "D3DES" quirk and about a hundred lines. VeNCrypt, RA2 and ARD
  are not.
- **The keyboard**, which is section 4, and which is where a from-scratch
  implementation goes to die.

Verdict: reasonable if the scope were permanently "read-only viewer for
a machine on my bench". Not reasonable as a path to something that
works on whatever is in the rack.

### Option C - do not render it at all

Two sub-options, both nearly free, and I do not think either should be
dismissed.

**C1: launch the OS viewer through a tunnel we already have.** The
tunnel machinery is already built: `engine/tunnels.js` opens a local
forward over a pooled SSH connection. A "VNC" action on a saved session
could open `-L 5900:target:5900` and hand the address to whatever
viewer is installed. Cost: roughly a day. Benefit: a working workflow
today, on 1.x, with no new code paths in the renderer at all.

**C2: nothing, and say so.** The app is a terminal. This is a defensible
position and it is the current one.

C1 is worth building regardless of what happens with A, because it is
the fallback when the built-in viewer meets a server it cannot speak
to, and because it is the honest answer for RDP (section 6).

---

## 4. The keyboard, which is the actual problem

This is the part that surprised you and it is the part that surprises
everyone. SSH needs none of it: a terminal has one input model, bytes,
and xterm.js turns key events into bytes correctly because that mapping
has been settled since the VT220.

Remote framebuffer protocols move *key events*, and a key event is not
a character. Here is what has to be solved.

**1. Keysyms, not characters.** RFB `KeyEvent` carries an X11 keysym - a
number from a table that predates every browser. The renderer has
`KeyboardEvent.key` (a character or a name) and `.code` (a physical
position). Neither is a keysym. The mapping is a large table plus rules,
and the rules are where it goes wrong: the same physical key produces
different keysyms depending on the modifier state, and `key` already
has the modifier applied while `code` does not.

There is a shortcut when the server supports it. The QEMU Extended Key
Event pseudo-encoding carries raw scancodes instead of keysyms, which
sidesteps the entire mapping problem. QEMU and Proxmox support it,
which covers a lot of home-lab use. Nothing else does.

**2. Modifiers get stuck.** Hold Alt, alt-tab away, release Alt
somewhere else. The remote never sees the key-up and now believes Alt is
held forever, and every subsequent keystroke is an Alt chord. Every
viewer has this bug at some point. The fix is to release every held key
on blur, on pane defocus, and on window minimise - and it interacts
with our idle animation, which already swallows the waking keystroke.
A VNC pane must not be sent that keystroke either.

**3. Keys the OS eats.**

- **Ctrl+Alt+Del** cannot be captured by any application on Windows;
  the secure attention sequence is handled below us. It has to be a
  toolbar button or menu item that synthesises the three key events.
  Every VNC client has this button and now you know why.
- **The Windows key, Alt+Tab, Alt+F4, Alt+Space** go to the local
  window manager. Chromium has the Keyboard Lock API
  (`navigator.keyboard.lock()`) which captures most of them, but only
  in fullscreen. So "capture all keys" becomes a mode with a visible
  indicator and an escape hatch, not a setting - if the user cannot get
  out, that is a bug report about a hung app.
- **Our own accelerators** collide too. Ctrl+Shift+C, Ctrl+F, Ctrl+W,
  the palette, the snippets - all of those currently belong to the app.
  In a focused VNC pane most of them have to be released to the remote,
  which means the app needs a single deliberate answer about which
  shortcuts survive. My suggestion: one modifier prefix is reserved
  (whatever the palette uses) and everything else goes to the remote.

**4. AltGr and international layouts.** Windows reports AltGr as
Ctrl+Alt. A German keyboard user typing `@` sends AltGr+Q, the app sees
Ctrl+Alt+Q, and the remote gets a chord instead of a character. There
is a known workaround (watching for the fake left-Ctrl that Windows
injects) and it is fiddly. IME - anything CJK - is a separate problem
again and most clients simply do not support composing over VNC.

**5. Autorepeat.** The local OS repeats key-down events; sending each
one is usually right, but for a laggy link it produces runaway repeats
in the remote. Clients differ here and there is no correct answer, only
a tuned one.

That list is the single strongest argument for Option A. noVNC has all
of it - `core/input/keyboard.js` plus its keysym tables and the vkeys
and fixedkeys workarounds - and it is all bug fixes from real reports
we have not received yet.

### The mouse, which is easier but not free

- Buttons are a bitmask in one `PointerEvent` message; the wheel is
  buttons 4-7, pressed and immediately released, which means a smooth
  trackpad scroll has to be quantised into discrete clicks.
- The cursor may be drawn by the server (it appears in the framebuffer,
  and lags) or delivered by the cursor pseudo-encoding and drawn
  locally with the real pointer hidden. Local is much better and is
  what to negotiate for.
- Scaling: if the pane is smaller than the remote desktop, either scale
  (and map coordinates back through the scale factor) or ask the server
  to resize with ExtendedDesktopSize, which real desktops support and
  bench machines often do not. Both, with a toggle.
- Relative-motion applications - 3D, games, some installers - need
  Pointer Lock. Rare in this app's use case; note it and skip it.

### Clipboard

Classic RFB cut text is Latin-1 only, which mangles anything else. The
extended clipboard pseudo-encoding fixes it where supported. This has
to line up with the policy already in the app: OSC 52 lets a remote
*write* our clipboard and never read it. A VNC desktop asking for our
clipboard is the same exfiltration question and should get the same
answer, defaulting to send-on-explicit-action rather than automatic
sync.

---

## 5. Security posture

VNC authentication is DES with a key silently truncated to eight
characters. It is not a password check anyone should rely on across a
routed network, and plenty of servers still offer nothing better.

This app has an answer that most viewers do not: it is already an SSH
client with a connection pool. `engine/hop-pool.js` exposes
`forwardOut(client, host, port)`, which opens a channel to a remote
host:port over an existing authenticated SSH connection. An RFB client
can speak straight down that channel - no local listener, no exposed
port on this machine, sharing the bastion connection the terminals are
already using, and the weak VNC auth is wrapped in SSH transport
security.

So the default for a saved VNC session should be "through this SSH
session", with direct TCP as the deliberate exception rather than the
default. That is both the safer posture and a genuine differentiator:
"VNC through your jump host, over the connection you already
authenticated" is not a thing most clients do well.

Also worth deciding early: a VNC pane displays a remote *desktop*, and
the session logging that runs for terminals cannot apply. Screenshots
are a feature request waiting to happen; recording is not something to
build without thinking about where those files go.

---

## 6. RDP and X11, since they were grouped together

They are not the same size of problem and should not be scheduled as if
they were.

**RDP** has no realistic pure-JavaScript path. It is a large protocol
family - security layers, virtual channels, several codecs including
RemoteFX and H.264 - and the practical implementations are FreeRDP
(C, Apache-2.0) or a Guacamole-style server-side proxy (Java). Both
mean shipping a binary or a service, which is exactly what was rejected
for iperf3, for the same reasons. The good news is that Windows already
ships a competent RDP client. Option C1 covers it properly: generate an
`.rdp` file, open a tunnel over the existing SSH connection, launch
`mstsc.exe`. No bundling, no licence question, and on Linux the same
approach hands off to whatever client is installed.

**X11** means either bundling an X server (what MobaXterm does - it is
the actual reason MobaXterm is as large as it is) or detecting a
VcXsrv/X410 install and setting `DISPLAY` with SSH X11 forwarding.
The second is small and honest and is what I would do.

Both of these are a paragraph of design and a day of work in the C1
shape, versus weeks in the A shape. That asymmetry is the argument for
building C1 first regardless.

---

## 7. Suggested phasing

**Phase 0 - tunnel and hand off (1.x, days).** A "VNC" and an "RDP"
action on a saved session that opens the tunnel and launches the
installed viewer. Ships value immediately, proves the session-model
changes (a saved node that is not a terminal), and remains the fallback
forever.

**Phase 1 - the pane refactor (2.0, no user-visible change).** Turn
"pane" into an interface; make the terminal one implementation. Guard
the 12 renderer modules. This is the bulk of the risk and none of the
glory, and it is testable on its own with the existing harness.

**Phase 2 - read-only viewer (2.0).** noVNC vendored, socket in the
engine over a MessagePort, canvas in a pane, no input at all. This
proves handshake, auth, encoding negotiation, decode and paint while
deferring every problem in section 4. And a read-only console view is
genuinely useful on its own - "is that box showing a kernel panic or a
login prompt" is most of why a network engineer opens VNC.

**Phase 3 - input.** Keyboard, mouse, the Ctrl+Alt+Del button, the
capture-mode indicator, clipboard. Budget more for this than for
phase 2, which is counterintuitive and correct.

**Phase 4 - polish.** Scaling and remote resize, local cursor, quality
and compression settings, reconnect.

---

## 8. What I need decided

1. **Vendor noVNC, or write our own?** My recommendation is vendor,
   and the deciding factor is section 4 rather than the encodings.
2. **Does phase 0 ship on 1.x?** It is small, it is useful now, and it
   is the RDP answer permanently.
3. **Is direct TCP VNC allowed at all in v1, or is it SSH-only?**
   SSH-only is the stronger posture and the better story; it also means
   nobody points this at the internet on day one.
4. **Same grid, or its own window?** A desktop in a 2x2 grid of
   terminals is cramped, but a separate window loses the tab model and
   the workspace save. My instinct is same grid, with a "maximise this
   pane" that already half-exists.
5. **Linux support as a stated 2.0 goal?** It changes small decisions
   throughout - key handling, the external-viewer hand-off, where
   `DISPLAY` comes from - and it is much cheaper to decide now than to
   retrofit.

---

## Appendix: the assumption to check first

Everything in Option A rests on noVNC accepting a non-WebSocket
transport. Before committing, the check is: install `@novnc/novnc`,
read `core/rfb.js`'s constructor, and confirm what it accepts in place
of a URL. If it turns out to require a real WebSocket, the fallback is
a loopback WebSocket server in the engine bound to 127.0.0.1 with a
single-use token - which works, but it is a listening socket on this
machine, and after the care taken over the field servers that deserves
its own conversation rather than being smuggled in as an
implementation detail.
