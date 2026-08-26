The first release the version number takes seriously. RSMultiTerm has been
its author's daily driver throughout, three code reviews (one external,
two independent) have been worked through end to end, and 38 test suites
gate every build.

## What it is

A multi-session terminal for network and Linux administration: SSH, Telnet
and Serial in a dynamic pane grid, broadcast with real guardrails, and the
field-work tools that usually mean carrying three extra programs.

## Highlights since 0.1.2

- **Edit remote files in your own editor.** "Edit Locally" in the file
  browser downloads the file, opens your editor, and uploads every save
  back to the device - with conflict detection instead of clobbering.
- **Serial line controls.** Send break (the ROMMON move), toggle DTR/RTS,
  change line speed mid-session.
- **Connect through a proxy.** SOCKS5 or HTTP CONNECT, set per session or
  once on a folder; everything inside inherits it.
- **Field Tools grew a syslog sink** (watch a reloading switch announce
  itself, filter by severity, save the log) and a **Copy Fetch Command**
  button that puts the device-side `copy tftp://...` / `curl` line on
  your clipboard, ports and addresses filled in.
- **Output triggers.** A highlight rule can badge the tab, note the match
  in the status line, and raise a system notification when the window is
  in the background.
- **Import from PuTTY and OpenSSH config** - and a fresh install offers
  it when it finds them, with a preview of what would be added. Nothing
  imports silently.
- **Session-list truth:** a four-state circle per session (never seen /
  seen before / connected now / last attempt failed), unread-output
  badges on tabs, drag-and-drop between folders, saved broadcast groups,
  search toggles (case / word / regex), commands-on-connect, and
  fourteen idle animations, several playable.

## Security

The whole surface was re-reviewed for this release
([docs/security-review-2026-08.md](https://github.com/RootSwitch/RSMultiTerm/blob/main/docs/security-review-2026-08.md)).
Highlights of the posture: credentials live in the OS store (DPAPI /
Keychain / keyring) and are released only to hosts a profile's scope
allows; a shared sessions file cannot carry commands, credentials, or
local paths into your tree; the renderer has no network access at all;
and everything a device sends is treated as hostile bytes.

## Install

Both binaries are unsigned (personal project, no code-signing
certificate), so SmartScreen will warn on first run: More info > Run
anyway. Verify a download against `SHA256SUMS.txt`:

```
Get-FileHash .\RSMultiTerm-1.0.0-portable.exe -Algorithm SHA256
```

For a fully self-contained copy (USB stick, share), drop a file named
`rsmultiterm-portable.txt` beside the portable exe - all state then lives
next to it instead of %APPDATA%.

Windows is the supported platform. The Linux code paths exist and are
tested, but no Linux build has been published yet.
