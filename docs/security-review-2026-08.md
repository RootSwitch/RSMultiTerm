# Security review - RSMultiTerm, pre-release pass

Date: 2026-08-19. In-house pass, covering the surfaces the external
review did not reach: the renderer, untrusted-input parsers (team
share, MobaXterm/CSV import, device directory listings), the
test/environment hooks, and the trust boundary between a *device* and
this machine.

Threat model, stated plainly. Three parties supply bytes this app
parses, and none is fully trusted:

1. **The device** you connect to (SSH/Telnet/serial). It controls its
   output, its directory listings, its file contents and its escape
   sequences. A compromised switch or server is the main event.
2. **The team share** - a JSON file on SMB that any teammate (or anyone
   who can write to that path) can edit.
3. **Files you import** - .mxtsessions, CSV, a workspace snapshot.

The local user is trusted: this is a desktop app that runs code as you,
and anything you can do in it you could do in a shell.

## Findings and disposition

### 1. Device-controlled filename could steer a local write (fixed)

**Severity: high.** `downloadMany` pasted the name from a remote
directory listing straight onto the folder the user picked:

    local: dir + sep + f.name

A hostile or compromised SFTP server can answer a listing with a name
like `..\..\..\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\evil.exe`.
Selecting several files and choosing "Download N files..." would then
write outside the chosen folder - an arbitrary file write, good for
persistence, from nothing more alarming than looking at a file listing.
Introduced with multi-select download.

Fixed with `localName()`: everything that turns a remote name into a
local path now takes the last path segment and refuses `.`, `..`, empty
names, and names containing `:` (NTFS alternate data streams and drive
letters), after stripping trailing dots and spaces - Win32 strips those
when creating a file, so `evil.exe. ` and `evil.exe` are one file.
Main no longer trusts the renderer's cleaning either: the save dialog's
suggested name is run through `path.basename` there too, since a
directory in `defaultPath` silently relocates the dialog.

Verified in the running app against twelve hostile names, including
both separator styles, `..`, ADS syntax and a trailing-dot dodge:
nothing that survives can escape a folder, and ordinary names
(`.bashrc`, names with spaces) are untouched. Pinned by an invariant
test, planted-defect verified.

### 2. Code-execution test hooks shipped in the packaged build (fixed)

**Severity: medium** - low exploitability, high impact.
`RSMT_SMOKE_PROBE` is passed to `executeJavaScript` with
`userGesture: true`, and `RSMT_SMOKE_SAVETEXT` names a file to write.
Both were live in a packaged build. Setting them requires control of
the process environment - a shortcut, a wrapper script, a scheduled
task - and someone with that can usually run code as you anyway, which
is why this is not critical. But the probe hook runs *inside the app's
renderer*, which reaches every IPC channel the app has: the session
tree, live authenticated sessions, SFTP to your devices. A released
binary should not carry a code-execution hook at all.

Both now go through `main/dev-hooks.js`, which returns null when
`app.isPackaged`. The connect-and-screenshot smoke pass still works
packaged - that is what verifies a built artifact boots - and a
packaged build handed a probe logs the refusal instead of running it.
Pinned by an invariant test that also fails if either variable is ever
read directly again.

### 3. Team file read without a size ceiling (fixed)

**Severity: low** (availability). The share file is read whole and
synchronously on a 60-second poll. A runaway or hostile file stalls the
main process and can exhaust memory. Now capped at 32 MB with a clear
error; a real estate of thousands of sessions is well under a megabyte.
The same cap covers the import path.

### 4. Tab color validated only where it was written (fixed)

**Severity: low** (defense in depth). Colors are hex-validated when a
workspace snapshot is saved, but the restore path interpolated the
stored string into `style.boxShadow` unchecked. A hand-edited
workspace.json is already local-user territory, but validating at the
point of use costs one line, so it now validates there too.

## Reviewed and found sound (no change)

- **Renderer XSS**: no `innerHTML`, `outerHTML`, `insertAdjacentHTML`,
  `document.write`, `eval` or `new Function` anywhere in app code -
  every device-derived string reaches the DOM through `textContent`.
  CSP is `default-src 'self'; script-src 'self'; connect-src 'none'`,
  so even a successful injection could not phone home.
- **Escape-sequence containment**: chrome written into a terminal goes
  through `App.plainText`, which strips C0/C1 bytes, so an error
  message carrying a device's banner cannot emit escapes. OSC 52 *read*
  is refused unconditionally (a remote asking what is on your
  clipboard); write honors the setting, is capped at 256 KB and
  announces itself in the status line. Devices cannot set window or tab
  titles.
- **No external-link surface**: the app never calls
  `shell.openExternal`; a URL in terminal output is copyable, never
  clickable into a browser. That closes the usual "device prints a
  link" pivot.
- **Host key TOFU**: first contact prompts with the fingerprint; a
  later mismatch is a hard block with no override in the connect path -
  clearing it requires deliberately forgetting the key.
- **Team file ingestion**: schema pinned, prototype-poisoning ids
  (`__proto__`, `constructor`, `prototype`) refused, any node carrying
  credential material refused outright, `logging.folder` stripped - a
  hostile file could otherwise aim your session logs at Startup -
  highlight and snippet collections size- and field-capped.
- **Secrets**: DPAPI ciphertext never leaves main; the renderer sees
  only `hasSecret`. Workspace snapshots drop passwords unconditionally,
  and the team serializer whitelists fields rather than blacklisting.
- **SCP shell construction**: remote paths are POSIX single-quote
  escaped before `exec`.
- **Preload surface**: three allowlists (invoke/send/event) and one
  narrow `pathForFile` for drag-and-drop; session MessagePorts are
  relayed same-origin only.
- **Log file naming**: session and host names are sanitized of path
  separators and control characters before they become filenames.

## Accepted risks

- **Highlight-rule ReDoS.** Patterns from the team share are compiled
  with `new RegExp` and run against visible terminal rows. Patterns are
  capped at 512 characters and matching is bounded to the viewport, but
  a deliberately catastrophic pattern from someone with write access to
  the share could still stall the renderer. Fixing it properly needs a
  non-backtracking engine (RE2), a dependency this app does not
  otherwise want. The threat requires someone you already share
  sessions with; noted rather than fixed.
- **A compromised renderer implies local file access.** SFTP upload and
  download take local paths from the renderer by design, so renderer
  code execution would mean arbitrary local read/write. This is the
  normal Electron bargain; it is why the XSS surface above is kept at
  zero and why the CSP forbids network access from the renderer.
- **Smoke connect/screenshot remains available in packaged builds.** It
  writes a PNG to a path from the environment. Kept deliberately: it is
  how a built artifact is verified to boot, and it grants nothing to an
  attacker who does not already control the environment.
