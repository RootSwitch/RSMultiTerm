One fix, for a paper cut older than 1.0.0.

- **Enter sends a confirmed paste to a single session.** Paste multiple
  lines into one pane, the confirmation appears, and Enter used to close
  it and throw the paste away. Enter now means Send there, which is the
  muscle memory the dialog was getting in the way of.

  Nothing changes for a broadcast, deliberately: when the paste is headed
  for more than one session, Cancel keeps the keyboard and Enter dismisses
  without sending. A reflex Enter firing a command at every device in a
  tab is the exact accident that dialog exists to prevent.

Worth knowing while you are in there: with bracketed paste (bash, zsh and
most modern shells), a confirmed multi-line paste lands in the shell's
edit buffer WITHOUT running - your Enter in the terminal runs it. That is
the shell protecting you from pasted commands executing on arrival, not
the app holding something back. Snippets are the other case on purpose:
they carry their own carriage return, because a snippet is a command you
chose to run.

Verify a download against `SHA256SUMS.txt`:

```
Get-FileHash .\RSMultiTerm-1.0.2-portable.exe -Algorithm SHA256
```

Both binaries are unsigned; SmartScreen will warn on first run
(More info > Run anyway).
