Put saved sessions in any order, and idle animations that go easy on a
machine with no GPU.

- **Saved sessions can be put in any order.** Drag a session onto the top
  or bottom half of another session to place it above or below; drag a
  folder onto another folder's top or bottom edge to place it, or onto its
  middle to move it inside. A line shows where it will land. A folder's
  right-click menu has "Sort A to Z...", and the empty space below the
  list has "Sort Top Level A to Z...", each able to sort the folders
  inside too. Folders stay above sessions, numbers sort as numbers (sw2
  before sw10), and the order travels with session sync.
- **Idle animations run at 15 fps where there is no GPU.** In a virtual
  machine, or a Remote Desktop session without a GPU, the processor paints
  every frame - Rain measured at 41% of a core at full speed on a 4-vCPU
  VM, and 19% at 15 fps. The animations now notice when Chromium is
  drawing in software and default to 15 fps there, 30 everywhere else.
  The Extras menu has a "Low frame rate (15 fps)" checkbox under "Full
  screen animation" - untick it to run at full speed anyway - and Settings
  > Frame rate offers Automatic, Full or Low. Games started with Play
  always run at full speed.

Verify a download against `SHA256SUMS.txt`:

```
Get-FileHash .\RSMultiTerm-1.0.8-portable.exe -Algorithm SHA256
```

Both binaries are unsigned; SmartScreen will warn on first run
(More info > Run anyway).
