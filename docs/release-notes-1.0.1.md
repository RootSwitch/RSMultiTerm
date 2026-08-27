Fixes from the first days of 1.0.0 in daily use.

- **Folders drag-and-drop into the file browser now.** A dropped folder
  is walked and uploaded - directories first, then files, each through
  the same torn-upload protection as a single file - with a summary of
  what went. Previously a dropped folder turned into a bogus zero-byte
  file on the device; that can no longer happen from any path.
- **One broadcast confirmation at a time.** A second Send while the
  "Send N lines to M sessions?" dialog was open used to stack an
  identical dialog behind it - invisible, and each hidden copy was one
  more armed delivery of the full payload. A second request now focuses
  the confirmation already open.
- **Closing any dialog returns the keyboard to the terminal.** It used
  to return focus to the toolbar button that opened the dialog, where
  the next Enter - numpad Enter meant for the device, say - pressed the
  button and reopened the window you had just closed.

Verify a download against `SHA256SUMS.txt`:

```
Get-FileHash .\RSMultiTerm-1.0.1-portable.exe -Algorithm SHA256
```

Both binaries are unsigned; SmartScreen will warn on first run
(More info > Run anyway).
