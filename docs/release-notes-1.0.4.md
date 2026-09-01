A game, and two things that were always slower or riskier than they
looked.

- **Blocks.** Falling tetrads in your theme's own colors. Under Extras >
  Play Blocks it is the game you already know - left/right move, up
  rotates, down hurries, Space slams. As an idle animation it plays
  ITSELF: a placement heuristic picks each move and walks the piece to
  its spot, ghost landing square and all. Seven-bag dealing, so piece
  droughts cannot happen.
- **The portable marker now works on a folder build.** Drop
  `rsmultiterm-portable.txt` beside `RSMultiTerm.exe` in any unzipped
  folder and everything lives beside it, self-contained, starting as
  fast as an install (~1.8s). The single-file portable re-extracts
  itself on every launch by design of its self-extracting stub - about
  five seconds per start - which the README now says plainly. For a USB
  stick or a one-file download it is a fair price; for daily use,
  install or unzip.
- **Installed builds log to Documents\RSMultiTerm\logs.** They used to
  log inside their own install folder - which the uninstaller deletes
  and every upgrade rewrites, so a session transcript could be destroyed
  by the ordinary act of updating. Portable builds still log beside
  themselves. Existing logs stay exactly where they are.
- The Extras menu is alphabetized, both the games and the effects.

Verify a download against `SHA256SUMS.txt`:

```
Get-FileHash .\RSMultiTerm-1.0.4-portable.exe -Algorithm SHA256
```

Both binaries are unsigned; SmartScreen will warn on first run
(More info > Run anyway).
