Logs that read like the screen, a way out of a changed host key, and three
idle-animation fixes from daily use.

- **Session logs now record what the screen showed.** The old text log
  was the byte stream with the escapes cut out, and that kept everything
  a program had erased or redrawn: a corrected typo logged as
  `echo hxlloello`, a command cleared with Ctrl-U logged as if it had run,
  a pasted heredoc logged twice with the copies glued together, every
  frame of a `\r` progress bar landed on one line (needrestart managed a
  12,725-character one), and nano's whole interface arrived as soup. The
  logger now runs the same terminal emulator the window uses, headless,
  and writes each line as the screen finishes with it - so the log is
  your scrollback: corrected commands, one copy of a paste, the final
  frame of a progress bar, and one note where a full-screen program
  (nano, less, a dialog) took over. A `clear` no longer takes the last
  screenful with it. Long commands are one log line even where the
  screen wrapped them. Raw mode is untouched and still byte-exact. Built
  and tested against real bash readline and a real apt-get run on
  Ubuntu 24.04, which are now the test fixtures.
- **A changed SSH host key can be removed from inside the app.** The
  HOST KEY CHANGED warning told you to remove the stored key and gave you
  nowhere to do it. It now has a Remove Stored Key button, and
  Settings > Known Hosts lists every pinned host with its fingerprint and
  the date you trusted it, with a Remove per row. The confirmation is a
  dialog the main process draws, showing the fingerprint from its own
  store - deliberately, since a prompt the terminal side could click
  through would be no confirmation at all. Removal rather than overwrite:
  the next connection is an ordinary first contact that shows you the
  new fingerprint before you trust it.
- **Idle animations.** Aliens keeps its formation out of the ship's lane
  and Bricks keeps bricks out of the paddle's when the screen has text on
  its bottom rows (aliens used to spawn on the ship and restart the wave
  every frame). The screensaver Bricks paddle aims at bricks instead of
  parking under a ball bouncing in a cleared column. And device output
  now counts as activity, so a long build scrolling past no longer idles
  out - output defers the start but never interrupts a running animation,
  so a chatty session cannot make one flicker.
- Quitting waits for the engine to finish writing its logs (capped at two
  seconds), so the last line on screen is never lost to the exit.

Verify a download against `SHA256SUMS.txt`:

```
Get-FileHash .\RSMultiTerm-1.0.5-portable.exe -Algorithm SHA256
```

Both binaries are unsigned; SmartScreen will warn on first run
(More info > Run anyway).
