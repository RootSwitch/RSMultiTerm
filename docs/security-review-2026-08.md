# Security review - RSMultiTerm

Date: 2026-08-25. Supersedes the 2026-08-19 pre-release pass, which
covered an app without the syslog sink, edit-and-sync, the outbound
proxy, output triggers, serial line controls, the OpenSSH/PuTTY
importers, broadcast groups or tree moves. Everything below describes
the code as it stands at `015e87a`.

Three passes fed this document: the 2026-08-19 in-house pre-release
review, an external architectural review, and a post-feature-batch
security pass over the ten commits that followed the credential-scope
work. Findings from all three are recorded here with their disposition.

`npm test` passes: 38 suites, including planted-defect verification for
every guard described below.

## Threat model

Three parties supply bytes this app parses, and none is fully trusted.

1. **The device** you connect to (SSH / Telnet / serial). It controls
   its output, its escape sequences, its directory listings, its file
   names and its file contents. A compromised switch or server is the
   main event.
2. **The team share** - a JSON file on SMB that any teammate, or anyone
   who can write that path, can edit. This includes files a teammate
   *imported* from somewhere else.
3. **Files you import** - `.mxtsessions`, CSV, `~/.ssh/config`, the
   PuTTY registry hive, a workspace snapshot.

The local user is trusted. This is a desktop app that runs code as you,
and anything you can do in it you could do in a shell. `editorCommand`
naming an arbitrary executable, for instance, is a feature and not a
finding.

Two structural consequences shape everything else:

- **A compromised renderer cannot be gated by an in-app prompt.** The
  renderer draws the fingerprint dialog *and* answers its own
  `rs:hostkey.answer`. Any decision that must survive renderer
  compromise has to be one the main process makes alone, from data the
  renderer cannot write. That is why credential host scoping lives in
  main and is checked before decryption.
- **The engine owns every socket.** The renderer's CSP is
  `default-src 'self'; script-src 'self'; connect-src 'none'`, so even
  a successful injection into the terminal UI cannot open a connection.

## Trust boundary 1: the device

**Escape sequences.** Chrome the app writes into a terminal goes
through `App.plainText`, which strips C0/C1 bytes, so an error message
quoting a device's banner cannot emit escapes. OSC 52 *read* - a remote
asking what is on your clipboard - is refused unconditionally and as a
code guarantee, not a setting; write honors the setting, is capped at
256 KB, and announces itself in the status line. Devices cannot set
window or tab titles.

**Filenames from directory listings.** A listing is device-controlled
input, and a name like
`..\..\..\Start Menu\Programs\Startup\evil.exe` in a batch download
would write outside the chosen folder. Every path that turns a remote
name into a local one goes through the same laundering: last segment
only, refuse `.`/`..`/empty, refuse `:` (drive letters and NTFS
alternate data streams), strip trailing dots and spaces (Win32 strips
them at creation, so `evil.exe. ` and `evil.exe` are one file). That is
`localName()` in the file browser, `safeComponent()` in the folder
walk, and `safeName()` in edit-and-sync. Main does not trust the
renderer's cleaning either - the save dialog's suggested name is run
through `path.basename` again there, since a directory in
`defaultPath` silently relocates the dialog.

**File contents.** Transfers in both directions write to a `.part` file
and rename on success, so a failed download cannot clobber an existing
local file and a failed upload cannot leave a truncated image on a
device's flash under its real name. The folder walk is breadth-capped,
skips Windows reserved device names (`CON`, `NUL`, `COM1`...), and
refuses case/dot collisions rather than silently overwriting.

**Handing a device's file to an editor.** *Fixed in `015e87a`
(medium).* With no `editorCommand` set, edit-and-sync fell back to
`shell.openPath`, which on Windows is ShellExecute's `open` verb: for
`.exe`, `.cmd`, `.bat`, `.hta`, `.js`, `.vbs` it **runs** the file.
Both the name and the contents come from the device, and the file
browser offers "Edit locally" on every entry. `safeName()` was correct
about traversal - it is the *extension* that decides whether "edit"
means edit. The system association is now used only for a short
allowlist of inert text types; everything else opens in a plain editor
that cannot interpret it. Script extensions are deliberately excluded:
with an interpreter installed, Windows registers `.py`/`.pl`/`.rb` as
executable types too.

**Syslog input.** Datagrams are truncated at 8 KB, control bytes are
scrubbed before the text reaches the DOM or a saved file, and the kept
buffer is capped at 5,000 lines in a ring. Non-syslog and
out-of-range-PRI lines pass through as plain text rather than being
dropped, because a device spraying junk at 514 is something you want to
see.

**Output triggers do not send.** A matched watch rule badges a tab,
writes a status line, and raises a notification whose body goes through
`plainText`. Nothing is ever written back to the device. Matching runs
on parsed buffer lines, so escapes are already gone by the time a
pattern sees them.

**Field servers.** `inside()` resolves through symlinks and junctions
with `realpathSync.native` before serving anything, TFTP writes go to a
`.part` file with a 4 GiB ceiling and no truncate-on-WRQ, transfers die
with the server or its deadline, and the TID pairing per RFC 1350 is
enforced. Nothing starts by itself; the bind address is chosen from
this machine's real interfaces.

## Trust boundary 2: the team share

**A shared file could type commands into your devices.** *Fixed in
`015e87a` (high).* This was the app's own threat model failing at its
own boundary. `team-serializer` strips `defaults.onConnect` on the
**publish** path, with a comment describing the **inbound** threat -
but `validateTeamFile`, the function a hostile file actually meets,
passed the whole `defaults` object through untouched. Folder defaults
reach every session beneath them through the inheritance walk, which
makes that object the highest-value thing in a shared file:

- `defaults.onConnect` is auto-typed into every session on every
  connect, reconnects included - remote command execution on the
  reader's own gear.
- `defaults.proxy` silently routes every session in the folder through
  a host the file chose. SSH host-key TOFU limits that to a
  first-contact fingerprint prompt; telnet and raw TCP are captured
  outright.

The merge preview hid it: the **Added** group rendered only
`name - host`, so a new folder called "Core Switches" carrying a
payload in its defaults appeared in the approval dialog as the words
*Core Switches*, and the user approved an import rather than a command.

Three changes: `SHARED_DEFAULTS` whitelists what a folder's defaults
may carry across machines, applied on **ingest**; the Added group now
names the notable defaults an added folder brings (proxy, jump host,
credential profile, port, transport), so adopting one is a decision;
and the invariant that claimed to pin this was re-pointed from the
publish path to `validateTeamFile`. The exploit itself is now a test.

**Everything else on ingest.** Schema pinned; prototype-poisoning ids
(`__proto__`, `constructor`, `prototype`) refused as both keys and
`id` fields; any node carrying credential material refused outright;
`logging.folder` stripped, on sessions and inside folder defaults, so a
hostile file cannot aim your session logs at Startup; highlight and
snippet collections field- and size-capped; the file itself capped at
32 MB so a runaway cannot stall the main process.

**Hostnames from a share.** A session's `host` travels in the shared
fields and is not otherwise shape-checked, so the proxy dialer refuses
control characters in a host name before building an HTTP CONNECT
request line - CRLF there would split the request. *(Fixed in
`015e87a`, low.)* SOCKS5 was immune, being length-prefixed; the check
is on both paths because the next protocol added there will be textual
again.

**Locking.** Lock files on SMB use probe-based server-mtime comparison
rather than local clocks, with atomic claims for stale locks, because
two machines' clocks disagree by more than you would like.

## Trust boundary 3: credentials

**Storage.** DPAPI / Keychain / Keyring through `safeStorage`;
ciphertext never leaves main, and the renderer sees only `hasSecret`.
On Linux, where only the insecure `basic_text` backend may be
available, storage is refused in favor of memory-only prompting rather
than writing a hardcoded-key "encryption".

**Host scoping, and a bypass in it.** *Fixed in `015e87a` (medium).*
A profile carries optional host patterns, checked in main **before**
decryption, so a renderer that can name a host cannot have a stored
password delivered to a machine of its choosing. The wildcard compiled
to `.+`, which made the module's own documented pattern `10.50.1.*`
match `10.50.1.7.evil.com` - a name anyone who can register a domain
can create, admitted by a scope written to exclude exactly that, and
reachable from a share that can set a session's `host`.

A wildcard may now cross a dot only when the text following it starts
with one, because then the **end** is still pinned:

| Pattern | Matches | Does not match |
| --- | --- | --- |
| `*.corp.local` | `a.b.corp.local` | `corp.local`, `sw.corp.local.evil.com` |
| `10.50.1.*` | `10.50.1.7` | `10.50.1.7.evil.com` |
| `sw-*-01` | `sw-core-01` | `sw-core.evil-01` |

CIDR is unchanged and remains the right tool for ranges: hostnames are
never resolved to test one, because a scope that widens on a DNS answer
is not a scope. An empty scope still means unrestricted, for upgrade
compatibility.

**Lockout protection.** Bulk connects group by profile and send a
single canary; a failure trips the profile and halts everything queued
behind it without touching the network. Auth methods are offered once
each, so a wrong password cannot be re-offered through
keyboard-interactive and spend two attempts per connect.

## The renderer

- **XSS surface is zero**: no `innerHTML`, `outerHTML`,
  `insertAdjacentHTML`, `document.write`, `eval` or `new Function` in
  app code. Every device-derived string reaches the DOM through
  `textContent`. (One `innerHTML = ''` appeared with edit-and-sync and
  was returned to `replaceChildren()` in `015e87a` - harmless in
  itself, but "there is no innerHTML here" is a property worth being
  able to grep for.)
- **Preload**: three allowlists (invoke / send / event) plus one narrow
  `pathForFile` for drag-and-drop. Session MessagePorts are relayed
  same-origin only.
- **Navigation**: `will-navigate` blocked, `setWindowOpenHandler`
  denies popups, permissions denied except clipboard, notifications and
  local fonts.
- **External launch**: the app still never calls `shell.openExternal`,
  so a URL in device output is copyable but never clickable into a
  browser. It *does* now call `shell.openPath` for edit-and-sync, under
  the extension allowlist described above - this is the one external
  launch surface, and it exists deliberately.
- **Settings from the renderer** are shape-validated in main before
  they reach disk: unknown keys dropped, values coerced and clamped,
  `broadcastGroups` typed and capped at 100 groups of 500 members.
- **Log file naming**: session and host names are sanitized of path
  separators and control characters before they become filenames, and
  `safeLogDir` refuses Startup, system directories and the temp tree -
  on the per-folder default route as well as the per-session one.

## Availability

**The syslog panel could peg the renderer.** *Fixed in `015e87a`
(medium).* Every datagram triggered a full re-render: filter up to
5,000 entries, slice, map, join, assign `textContent`, then read
`scrollHeight` and force layout. A chatty estate at debug level was
enough, with no attacker involved. Rendering is now coalesced onto an
animation frame, the buffers are rings rather than `shift()` (which is
O(n) per message on a full array, on both sides of the IPC), and the
render callback is released when the panel closes - it used to keep
painting a detached `<pre>` for the life of the process.

That teardown hangs off **both** exits. `Modals.open` calls `onCancel`
for Escape and backdrop clicks, but an action button only calls its own
`onClick`, so cleanup attached to `onCancel` alone skipped the Close
button - which is how nearly everyone shuts the dialog. A live probe
caught that; the first version of the fix was wrong in exactly the way
the finding described.

**Unbounded maps.** `earlyStatus` (held pane states) and
`lastWatchAlert` (watch cooldowns, keyed by a session id that changes
on every reconnect) both grew for the life of the process; both are now
bounded. The watch subset of compiled highlight rules is cached
alongside the rules instead of being filtered on every line feed.

**A dead listener reported as running.** *Fixed in `015e87a` (low).*
A syslog socket error after bind was routed into an already-settled
promise, so the sink could be dead while the panel listed it as
running. Post-bind errors now surface and take the entry down.

## Correctness fixes with a security flavor

- **A baud change retyped your on-connect commands.** Transports
  re-emit `connected` to refresh the status detail - a serial speed
  change does it, and so does a backpressure notice clearing - and the
  session re-armed its on-connect timers on every `connected` event.
  Changing line speed silently retyped `enable` / `sudo -i` into a live
  session. Only a transition *into* connected fires now; a genuine
  redial passes through another state first, so it still fires.
- **`reg` resolved by bare name.** Windows searches the application and
  working directories before PATH, so the PuTTY importer now runs
  `%SystemRoot%\System32\reg.exe` by absolute path.
- **Parser edges.** `ssh_config`'s legal `Port=2222` form was silently
  skipped, so an imported session quietly carried the wrong port; an
  unknown SOCKS reply address type fell through to a zero length and
  misparsed the reply instead of erroring.
- **Tab alert dots** were dropped whenever the tab strip was rebuilt,
  while the pane still considered itself alerting.

## Accepted risks

Restated deliberately, not inherited.

- **Highlight-rule ReDoS.** Patterns from the team share are compiled
  with `new RegExp`. The previous acceptance rested on matching being
  bounded to the viewport - and output triggers broke that bound by
  running rules on every completed line, including in background panes
  that never render. The bound is now explicit instead: a watch rule
  matches at most `WATCH_MAX_LINE` (4096) characters of a line, and
  patterns are still capped at 512 characters. A catastrophic pattern
  from someone with write access to the share can still cost time;
  fixing it *properly* needs a non-backtracking engine (RE2), a
  dependency this app does not otherwise want. Re-accepted with the
  bound made real.
- **A compromised renderer implies local file access.** SFTP upload and
  download take local paths from the renderer by design, and
  `rs:edit.start` takes a remote path that main then downloads and
  opens. This is the normal Electron bargain; it is why the XSS surface
  is kept at zero, why the CSP forbids network access from the
  renderer, and why credential scoping is enforced in main.
- **`editorCommand` is an arbitrary executable.** Local-user territory
  by design. The settings sanitizer type-checks it and nothing more.
- **Smoke connect/screenshot in packaged builds.** The probe and
  save-text hooks are refused when packaged (`main/dev-hooks.js`, with
  an invariant test that also fails if either variable is ever read
  directly again). The connect-and-screenshot pass stays available,
  because it is how a built artifact is verified to boot, and it grants
  nothing to someone who does not already control the environment.
- **No proxy authentication.** The outbound proxy speaks unauthenticated
  SOCKS5 and HTTP CONNECT only. Supporting proxy credentials would mean
  storing another secret beside the session; the common egress for raw
  TCP is unauthenticated, so this is deferred rather than half-built.

## What has not changed

The architecture holds: main owns credentials, host keys and storage;
the engine `utilityProcess` owns every socket; the renderer is
sandboxed, with no network access and no Node integration. Two
production dependencies (`ssh2`, `serialport`); terminal addons are
vendored and hash-checked in the test chain. Stores are written
atomically with `fsync` before rename, and the critical ones fail
closed on corruption rather than starting empty - a store that "loses"
every saved session after a power cut is worse than one that refuses to
load.

Earlier findings, all still fixed and pinned by tests: the
device-controlled filename that could steer a local write (high, 2026-
08-19), code-execution test hooks in packaged builds (medium), the team
file read without a size ceiling (low), and tab colors validated only
where they were written (low).
