A dark terminal for light themes, and idle animations that stay visible,
keep a steady pace, and hear every keypress.

- **A dark terminal that keeps the theme's colors.** Settings > Terminal
  colors has a new choice, "Follow the app theme, kept dark". A light
  theme's terminal goes dark in that theme's own colors - Sakura a dark
  plum with pale pink text, Glacier a dark navy - the same night the idle
  animations paint. Dark themes are unchanged. The old dark choice is now
  labeled "Always dark, classic colors".
- **Animations that read on every theme.** On light themes the idle
  animations could draw near-black on near-black: Mono's Aliens ship and
  lasers, half of Pipes, the clock's date line. They now get colors chosen
  for whatever they are drawn on, and themes that already looked right
  look exactly as before.
- **Snake hears every tap.** A quick tap between two moves was dropped -
  a third to half of short taps - and two fast turns in a row rarely both
  landed. Key presses are now queued and used one per move.
- **Aliens lasers hit what they pass through.** A laser could step over a
  row of words between one frame and the next, so shots went visibly
  through the middle of a word. Lasers now check the whole distance they
  travel.
- **A steady pace on every display.** Over Remote Desktop the animations
  drew at 16fps instead of 30, and Snake, Pipes and Blocks ran faster or
  slower depending on the screen's refresh rate. Everything now runs at
  the pace a 60Hz monitor shows, on any display. Blocks' game-over pause
  is a true 3 seconds, and a hard drop no longer nudges the next piece.

Verify a download against `SHA256SUMS.txt`:

```
Get-FileHash .\RSMultiTerm-1.0.7-portable.exe -Algorithm SHA256
```

Both binaries are unsigned; SmartScreen will warn on first run
(More info > Run anyway).
