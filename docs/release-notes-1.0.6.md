Three fixes from testing 1.0.5, one of them a button that did nothing.

- **Remove Stored Key now works.** In 1.0.5 the button on the HOST KEY
  CHANGED warning closed the warning and did nothing: the handler behind
  it referenced the dialog module without importing it, threw, and the
  failure was swallowed - so the old key stayed pinned and the warning
  came straight back on the next connect. Fixed; if it ever fails again
  the failure is shown as an error banner; and the test suite now removes
  a key, reconnects, and trusts the new one end to end. Anyone stuck on
  1.0.5 can edit `known_hosts.json` in the app's data folder by hand, or
  connect by a different name or port, which is a fresh first contact.
- **"Create a New Profile..."** from a Credentials dropdown now adds and
  selects the new profile in place - no closing and reopening the editor.
- **New Session and New Folder say where they are going.** Both dialogs
  carry a Location picker with Top level on offer, defaulting to where
  the tree would have put them, so a big selected folder can no longer
  trap new items inside it. Clicking blank space in the session tree also
  clears the selection.

Verify a download against `SHA256SUMS.txt`:

```
Get-FileHash .\RSMultiTerm-1.0.6-portable.exe -Algorithm SHA256
```

Both binaries are unsigned; SmartScreen will warn on first run
(More info > Run anyway).
