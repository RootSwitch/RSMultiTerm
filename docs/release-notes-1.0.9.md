Classic Cisco IOS over SSH, and a way back out of a MultiTerm.

- **Classic Cisco IOS connects over SSH.** IOS 15.x - including the IOSv
  and IOSvL2 images in Cisco Modeling Labs - offers only SHA-1 key
  exchange, which the app did not offer, so the device refused with
  %SSH-3-NO_MATCH. The app now offers diffie-hellman-group14-sha1 after
  every modern method, the way PuTTY and SecureCRT do: a device that
  speaks anything newer still gets that, and a session that settles for
  SHA-1 says so with a dim line in the pane and in the status bar. Jump
  hosts get the same treatment. Settings > SSH key exchange turns it off;
  the 1024-bit group1-sha1 is never offered.
- **A failed SSH handshake says what the device offered.** "No matching
  key exchange algorithm" now lists the device's methods (likewise for host
  key, cipher and MAC mismatches), and points at the setting when turning
  it on would help.
- **Split a MultiTerm back into tabs.** "Split into Tabs" appears beside
  "Merge into MultiTerm" whenever the tab in front has more than one pane,
  and puts each pane back in a tab of its own. To take out just one, "Move
  to New Tab" is on the pane's menu (Ctrl+right-click when right-click
  pastes) and the tab's menu. Nothing reconnects and no scrollback is
  lost; the pane you were typing in stays in front, and the split tabs keep
  the MultiTerm's color. A pane that leaves an armed broadcast leaves the
  broadcast too, and a banner says so.
- **Merge hands the keyboard back.** After "Merge into MultiTerm" the pane
  you were typing in keeps the focus, instead of the next keystroke going
  nowhere until a pane was clicked.
- **The connect bar fits a narrow window.** At the minimum window width the
  Extras button had been pushed out of reach; the host, username and
  password fields now give up width first.

Verify a download against `SHA256SUMS.txt`:

```
Get-FileHash .\RSMultiTerm-1.0.9-portable.exe -Algorithm SHA256
```

Both binaries are unsigned; SmartScreen will warn on first run
(More info > Run anyway).
