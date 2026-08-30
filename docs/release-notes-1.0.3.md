Logging, on three fronts.

- **No timestamp on every line any more.** A date at the head of every
  line makes a folder of logs hostile to the tool you read logs with:
  searching for a date, a time, or anything shaped like one matches
  every line of every file. The session's start time now sits in a
  one-line header at the top of each log (it was always in the filename
  too), so a search costs one hit per file instead of one per line.
  Per-line stamps are still there for the change window where they earn
  it - Settings > Log timestamps - and anyone who already set that keeps
  what they chose.
- **A first-run notice.** On a fresh install, one banner says where
  terminal sessions are being logged and that Settings can change it,
  with buttons to open the folder or go there. Once, whatever you do
  with it.
- **A Logs button in the toolbar.** Logging is on by default, which is
  deliberate - but the only thing that said so lived in the sessions
  sidebar, which the file browser replaces, so on any device with SFTP
  it was invisible. This one always is. Its tooltip names the folder;
  clicking opens it.

Raw-mode logs are unchanged and stay byte-exact: they exist to replay
escape-sequence problems, so nothing this app invents is added to them.

Verify a download against `SHA256SUMS.txt`:

```
Get-FileHash .\RSMultiTerm-1.0.3-portable.exe -Algorithm SHA256
```

Both binaries are unsigned; SmartScreen will warn on first run
(More info > Run anyway).
