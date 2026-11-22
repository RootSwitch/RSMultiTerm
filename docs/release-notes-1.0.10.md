A file browser for SCP-only devices that have a shell, and a credential
profile made right from the connect dialog.

- **A file browser for SCP-only devices that have a shell.** OpenWrt/LEDE
  gear (BusyBox and Dropbear) offers SCP but no SFTP, and the file panel
  was a type-the-path form there. It now lists folders the way MobaXterm's
  SCP browser does, by reading `ls` over the session's own connection: it
  opens in the account's home folder, Up, Refresh, double-click and the
  path field navigate, a link to a folder opens, and Download and Upload
  work on what is listed. The header says "(SCP)". Tried on LEDE 17.01
  (BusyBox 1.25): browsing and downloading.
- **It is read-only, and this is everything it sends.** `pwd` once per
  session, then `LC_ALL=C ls -la '<folder>/'` for each folder opened, and
  the same with `-L` when a folder holds symlinks. Nothing else. It never
  creates, renames or deletes on the device: New Folder is greyed out
  there, and Rename, Delete, Edit Locally and folder download stay
  SFTP-only. An upload over SCP still writes straight onto the target
  name, as before.
- **Which devices are asked.** A device whose SSH banner says Cisco is
  never sent `pwd` or `ls` - IOS has no shell behind SSH. Any other
  SCP-only device is sent `pwd` once per session; if the answer is not a
  single absolute path, it keeps the type-the-path form and is not asked
  again that session. That one `pwd` is new for SCP-only devices that are
  not Cisco and have no shell.
- **Create a credential profile from the connect dialog.** Opening a saved
  session that has no credential profile asks which credentials to use.
  That list now has "Create a New Profile...": the profile editor opens on
  top, and on Save the new profile is selected, ready to connect with.
  "Remember this profile on the session" is ticked for a saved session, so
  it connects without asking next time. For a session that names a profile
  this machine does not have, the editor opens with that name filled in.
- **File panel errors read plainly.** A folder that would not list or a
  transfer that failed showed "Error invoking remote method 'rs:sftp.op':
  Error:" in front of the reason. Only the reason is shown now.

Verify a download against `SHA256SUMS.txt`:

```
Get-FileHash .\RSMultiTerm-1.0.10-portable.exe -Algorithm SHA256
```

Both binaries are unsigned; SmartScreen will warn on first run
(More info > Run anyway).
