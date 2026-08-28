# RSMultiTerm on Ubuntu Desktop - plan

Written 2026-08-27, after 1.0.2. The question that prompted it: friends
on Linux and macOS asking whether this is Windows-only. The honest
answer today is "the code is cross-platform, the builds are not" - and
Ubuntu is the cheapest gap to close, because Linux has no Gatekeeper.

**Target: the current Ubuntu Desktop LTS**, chosen on market share
rather than affection. Confirm which LTS that is before starting: this
doc was written against knowledge ending mid-2026, and the AppArmor
note below is version-sensitive.

## Why Linux first, and why macOS waits

Linux distribution is the friendly one. An unsigned `.deb` or AppImage
installs and runs with no ceremony. macOS is the opposite: unsigned apps
are quarantined, the old right-click-Open bypass is gone on recent
versions, and the user must visit System Settings > Privacy & Security >
Open Anyway or run `xattr -d com.apple.quarantine`. Doing it properly
means the Apple Developer Program (99 USD/year) plus notarization wired
into the build - a money-and-account decision, not an engineering one,
so it waits until someone actually needs it.

## What already works, verified in the tree at 1.0.2

There are only eleven `process.platform` branches in the whole codebase.
Most of the cross-platform work landed during the pre-1.0 pass.

- **SSH, Telnet, SFTP, SCP, tunnels, proxy dialing** - pure JS over
  `ssh2` and `net`. No platform binding at all.
- **SSH agent** - `SSH_AUTH_SOCK` is checked FIRST in
  `main/ssh-keys.js`, before any Windows branch. Agent auth is cleaner
  here than on Windows.
- **Saved credentials** - `classifyBackend()` already handles Linux: the
  login keyring or KWallet when present, and an honest refusal
  (memory-only prompt mode) when only Chromium's hardcoded-key
  `basic_text` fallback exists. Ubuntu Desktop ships gnome-keyring, so
  the normal case should be the good one. VERIFY on a real desktop.
- **Serial** - `serialport` 12 ships prebuilds for `linux-x64` and
  `linux-arm64`, so no compiler is needed.
  `engine/transports/serial.js` already prints the dialout-group hint on
  a Linux EACCES.
- **Field Tools** - `dgram`/`net` are portable. TFTP 69 and syslog 514
  need root exactly as they need admin on Windows: same friction, same
  message, no code change.
- **Fonts and icons** - `main/settings.js` picks DejaVu Sans Mono on
  Linux; `main/windows.js` already prefers `icon.png` off Windows.
- **Editor launch and log confinement** - both fixed for POSIX in the
  pre-1.0 pass (association, then `$VISUAL`/`$EDITOR`; POSIX roots
  matched as prefixes rather than exact strings).
- **Packaging config** - `electron-builder.yml` already carries a
  `linux` block: AppImage + deb, Network category, maintainer set,
  `.desktop` keywords and `StartupWMClass` in place.

## The work, in order

### 1. Make the test suite pass on Linux (first, before anything else)

A VERIFIED problem, not a guess. Seven test files carry Windows paths as
DATA, and `path` behaves differently there:

    path.isAbsolute('C:\Users\me\logs')   win32: true      linux: false
    path.join('C:\', 'Apps')              win32: C:\Apps   linux: C:\/Apps

So `tools/test-log-dirs.js` - whose forbidden-roots section asserts that
ordinary Windows paths are ALLOWED - will fail on a clean Ubuntu
checkout, and `tools/test-sftp-tree.js` is likely to follow. The others
mention win32 but may only be matching strings; check each.

Fix by making the assertions platform-aware rather than deleting them.
The Windows rules still deserve testing, and they can be tested anywhere
by driving `path.win32` / `path.posix` explicitly instead of the ambient
`path`. Where the code under test uses ambient `path` (safeLogDir does),
split the expectations on `process.platform`. Prefer that to refactoring
the production function: the behavior really is platform-dependent by
design, and the test should say so.

A green suite on both platforms is the gate for everything below.

### 2. The Ubuntu-specific launch gotcha: AppArmor and user namespaces

Recent Ubuntu restricts unprivileged user namespaces through AppArmor,
which is exactly what Chromium's sandbox needs. Electron apps hit this
as a launch failure mentioning the sandbox or `chrome-sandbox`. Expect
it, and budget time for it - this is the most likely reason a first
AppImage run fails, and it looks like an app bug when it is distro
policy.

Three ways out, best first:

1. **Ship the `.deb`.** electron-builder sets the SUID bit on
   `chrome-sandbox` during a deb install, which is the sanctioned path.
2. **Ship an AppArmor profile** alongside the app for the AppImage case.
3. **`--no-sandbox`.** It works, and it discards a real security
   boundary in a program whose whole posture is "the renderer has no
   network and parses hostile bytes". Do not ship this. If it is ever a
   stopgap for local testing it belongs in a note, never in a `.desktop`
   Exec line.

### 3. Hide what the platform cannot do

The same pattern the app already uses for SCP-only devices and missing
keyrings: hide the capability, never fork the build.

- **PuTTY import** - `main/ssh-import.js` shells `reg.exe`. It already
  degrades to "nothing found" off Windows, but the Import menu still
  advertises it, and the first-run offer still probes for it. Hide both
  when `process.platform !== 'win32'`. Roughly ten lines.
- **Portable mode** - `rsmultiterm-portable.txt` beside the exe is a
  Windows portable-build concept. AppImage is already self-contained;
  decide whether the flag means anything there (probably the AppImage's
  own directory) or is simply Windows-only.
- Audit for anything else naming a Windows path or tool in the UI.

### 4. Package, then verify by hand on a real desktop

- **The `.deb` is the primary artifact** for Ubuntu: sandbox handled,
  desktop entry installed, updates by re-installing. **AppImage second**,
  for other distros and for people who dislike installers.
- **Not snap.** Confinement fights precisely what this app does - serial
  devices, arbitrary outbound ports, reading `~/.ssh` - and the review
  effort buys nothing for a small audience.
- None of this has ever run, so check by hand: HiDPI and fractional
  scaling (Ubuntu defaults to Wayland, and Electron goes through
  XWayland unless told otherwise), the window icon and Alt-Tab name,
  font rendering with the default stack, clipboard behavior under
  Wayland in both directions including middle-click paste (a
  first-class X/Wayland idiom this app already supports), and
  drag-and-drop into the file browser - which on Linux hands over
  `text/uri-list`, a different path from the Windows one that was just
  fixed for folders.
- Serial specifically: add the user to `dialout`, confirm the port list
  populates, and confirm the EACCES hint appears when they are not in
  that group.

### 5. Distribution

Add the Linux artifacts to the same GitHub release as the Windows ones,
with their hashes in the same `SHA256SUMS.txt`. Update the README's
install section to say what each artifact is for. No signing story is
needed; state plainly that the builds are unsigned, as the Windows ones
already do.

## The iteration setup

Two workable shapes, and the first is better:

- **Run Claude Code ON the Ubuntu box.** The smoke harness drives a real
  renderer and takes screenshots, and every question in step 4 is a
  "does it look right" question. Working on that machine keeps the
  feedback honest. `xvfb-run` covers headless CI later but cannot answer
  the HiDPI or Wayland-clipboard questions.
- **SSH in from Windows** for the code-only parts: the test portability
  pass, the platform branches, the packaging config. Fine for steps 1
  and 3, blind for steps 2 and 4.

Either way it is the same git remote, so work moves between machines by
branch.

## Deliberately not doing

- **A stripped-down build.** Considered and rejected. Removing Field
  Tools, credentials, serial or SFTP means deleting engine modules, IPC
  handlers, preload allowlist entries, whole test files, and the
  invariants that count wired element ids - surgery across eight-odd
  files - and it leaves two codebases to keep in step forever. The
  features are not what makes Linux hard; packaging and testing are. The
  full app is less work than the subset.
- **macOS**, until the signing decision is made.
- **An auto-updater.** Unchanged from Windows: distribution is a link.
