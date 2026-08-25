# Changelog

## Unreleased

- **Security amendments from the review (S3, S4, S5).**
  - **A corrupt settings file can no longer stop the app from starting.**
    A highlights.json that was valid JSON but the wrong shape threw
    before the window existed - no error, no recovery, nothing to
    click. Files that can be rebuilt (highlights, tunnels,
    reachability) now fall back to defaults and say so; files where
    "empty" would mean losing your data (sessions) refuse to start with
    the same recovery message a corrupt file already gave, instead of
    silently opening with an empty tree.
  - **The session-log folder is confined.** Team files already had
    their log folder stripped for exactly this reason; the same setting
    arriving from the app itself was trusted. It now has to be an
    absolute path outside system and startup locations.
  - **A team file's node identity is checked twice.** The validator
    guarded each node's key but not the id field inside it, and the
    merge writes by that field.

- **The review's low-severity batch - all twenty-four.** The ones you
  might notice:
  - The broadcast paste confirmation now opens with CANCEL focused, so
    the Enter meant to run the last pasted line can never confirm a
    multi-device send by reflex. Escape closes it, like every dialog.
  - Batch downloads confirm once ("files with the same names will be
    replaced"), and one failed file no longer abandons the rest.
  - On an SCP-only device, Enter in the path field downloads the path
    (it used to wipe the panel with an error), and the listing buttons
    that cannot work go quiet.
  - Editing a 2400 or 4800 baud session no longer silently rewrites it
    to 1200 - the editor shares the quick-connect baud list and keeps
    an unfamiliar stored rate visible.
  - Snippet parameters containing $& (or any regex replacement pattern)
    are inserted literally.
  - Renaming a session in the tree updates open panes, the tab strip
    and the status line; workspace snapshots now remember per-session
    highlight rules.
  - A failed quick connect shows a banner instead of doing nothing.
  - Settings > Font zoom keys can move zoom to Ctrl+Shift, freeing
    Ctrl+Minus for remote emacs undo (C-_).
  - HTTP field server: resumable downloads (byte ranges, 206). TFTP:
    netascii requests are refused with a message naming octet mode
    instead of being silently served untranslated; forged packets from
    the wrong port (TID) are ignored.
  - Under the hood: one SFTP channel per session even when two probes
    race; a telnet reset mid-session reports as the error it is; a
    device error mid-SCP-upload ("flash is full") surfaces instead of
    the generic "closed early"; session logs bound their memory if the
    log destination stalls and rotate on real bytes; overlapping file
    listings can no longer interleave; tunnel hops get the long
    first-contact fingerprint timeout; a missing host verifier now
    fails closed; serial paste backlogs are announced in the status
    line; and the field-server start request is validated in the main
    process before anything listens.

- **The review's medium-severity batch.**
  - **Merging tabs no longer silently arms the newcomers.** "Merge into
    MultiTerm" onto a tab with broadcast armed used to make every merged
    session - production boxes deliberately kept in their own tabs - a
    recipient of the next keystroke, with no acknowledgement. A merge
    now turns broadcast OFF and says so; adding a single pane to an
    armed tab warns with the new count.
  - **Dialogs keep the keyboard.** Tab used to walk focus out of an open
    dialog to the terminal behind it, so the next keystrokes went to a
    live device - through the broadcast router, if armed - while you
    thought you were typing into a password prompt. Tab now cycles
    inside the dialog, both directions.
  - **A device having a bad moment is no longer remembered as a device
    with no file transfer.** A transient failure while probing SFTP
    (a momentary channel limit, a timeout) was cached as "offers
    neither SFTP nor SCP" until disconnect. Working verdicts are still
    cached; failures are re-probed on the next file operation.
  - **A telnet server that starts an option string and never ends it**
    used to make the session buffer everything that followed - screen
    frozen, memory climbing. The buffer is capped and the stream falls
    back to plain data.
  - **A SOCKS client that sends without waiting no longer loses bytes.**
    Data arriving between the CONNECT request and the reply fell into a
    listener gap and vanished, corrupting the connection undetectably.
  - **SCP downloads no longer buffer without bound onto a slow disk**,
    and SCP progress updates are throttled like SFTP's instead of
    flooding one IPC message per chunk.

- **The code review's follow-up batch: transfer safety and hardening.**
  - **Downloads and uploads never leave a half-file behind, or delete a
    good one.** Every transfer - single file, folder tree, and SCP -
    now lands on a temporary name and moves into place only on success.
    A failed download deletes only what it wrote, so overwriting
    yesterday's backup with a download that then fails no longer loses
    the backup; a failed upload leaves no truncated file on the device
    under the real name.
  - **Field servers stop when you tell them to.** Stop and the time
    limit now close transfers in progress, not just the listening
    socket - a TFTP transfer no longer outlives the button or the
    deadline. A stalled upload no longer holds a file open forever.
  - **A TFTP upload can't truncate a file it never finishes writing, or
    fill the disk.** A write request opens a temp file, not the target,
    so an empty or abandoned request leaves the existing file intact; a
    declared or actual size past 4 GiB is refused.
  - **Symlinks and junctions can't escape a served folder.** Both field
    servers now resolve the real path and re-check it against the served
    root, so a link inside the folder pointing outside it is refused for
    reads and writes alike.
  - **Folder download handles hostile and awkward trees.** Windows
    reserved names (nul, con...) and illegal characters are refused
    rather than silently vanishing or aborting the batch; names that
    collide on a case-insensitive disk take the first and skip the rest;
    the walk is bounded in breadth as well as depth; and one bad
    directory name loses its subtree, not the whole download.
  - **A connection can't end up invisible.** A session that finishes
    connecting after its pane or tab was closed - a slow dial, a
    credential prompt left open - is now hung up or given a fresh tab,
    never left as a live login with no window and no close button.

- **Nine fixes from an external code review**, the ones it flagged as
  worth fixing before anything called 2.0:
  - A jump host with an SSH agent configured spent TWO authentication
    attempts per connect - the agent slot fell through to a
    keyboard-interactive answered with the stored password - against the
    exact AD/TACACS lockout policies the pool exists to protect. Agent
    auth now works on hops, and costs the one attempt it should.
  - A gateway that closed without an SSH error left its pool entry
    pending forever, so every later session and tunnel through that
    bastion hung until the app was restarted.
  - A tunnel client that reset during setup - a browser tab closed as
    it opened, a port scanner - crashed the entire engine process,
    severing every session and transfer. Same for a TFTP upload client
    that vanished mid-transfer. Both sockets now handle errors, and the
    engine carries a logged last-resort backstop besides.
  - Folder download failed on first use: it required a destination
    folder that by definition does not exist yet. It creates it now,
    and the test no longer pre-creates it (which is what hid this).
  - Folder downloads were also killed by a 30-second control timeout
    meant for quick metadata calls; big trees on slow links now run to
    completion like single-file transfers always did.
  - Broadcast counted panes that were still connecting - whose
    keystrokes were silently discarded - so "6 of 6" could deliver to
    five. Only connected panes count now, and the count updates the
    moment a pane dies or comes up.
  - Right-click paste with broadcast armed skipped the confirmation for
    single-line payloads; "reload" to eight switches now confirms like
    every other broadcast paste.
  - A corrupt known_hosts file silently EMPTIED the trust store,
    downgrading the man-in-the-middle MISMATCH block to a friendly
    first-contact prompt. It now stops with the recovery message, like
    sessions and profiles.

- **A minimum contrast setting for the terminal.** Settings > Minimum
  contrast puts a floor under text-against-background legibility, and
  it applies to the colors a REMOTE program picks as well as the
  theme's own - which is the point, and the reason no amount of theme
  tuning fixes it. A switch emitting bright green does not know what it
  is being drawn on.
  On Sakura's background, bright green sits at a contrast ratio of
  1.54, which is why it disappears. The shipped default lifts it to
  3.60 and the strong setting to 7.19, keeping the hue both times: it
  gets darker, not grey. Only colors that FAIL the ratio are touched,
  so a palette that already reads is left exactly as it was, and the
  setting applies to sessions that are already open.

- **Download a folder from the file browser**, with everything under it.
  Right-click a folder (or several) and the whole tree comes down.
  The walk and the transfers happen inside the engine rather than as a
  loop in the window, which is also why it is quick: the old multi-file
  download was one full round trip per file and waited for each, which
  is the "watch every file crawl past" pace you get elsewhere. Several
  files are now in flight at once and each one is pipelined internally.
  Symlinks are never followed - a directory link is how a walk becomes
  infinite - and are counted and reported instead. Every name in the
  listing is a name the DEVICE chose, so each component is checked
  before it steers a local path; anything that will not sit safely
  inside the folder you picked is refused and reported rather than
  written.
- **The snippet editor opens big enough for a command.** It was about
  forty columns, so every real command wrapped, and the only resize
  grip in sight belonged to the text box rather than the dialog. The
  command field now spans the dialog, starts around 100 columns and
  ten rows, and says that it drags.

- **The terminal's right-click menu no longer runs off the window.**
  Right-click near the bottom or the right edge and it flipped up and
  left onto the screen instead of being half hidden. The menu was
  hand-rolled and never used the shared menu helper, which has done
  this correctly for every other menu in the app all along; now it does
  too, and it gets Escape-to-dismiss with it.
- **Fixed: after Paste from that menu, the terminal did not have the
  keyboard.** Clicking a menu item moves focus to the button, and
  closing the menu removes the button, so focus fell to nothing at
  all - the text pasted, and then the Enter to run it went nowhere
  until you clicked back into the pane. Menus and dialogs now hand the
  keyboard back to whatever had it, unless something else has
  deliberately claimed it in the meantime.
- The menu is grouped with separators: clipboard, then this pane's
  output, then the device and session actions.

- **Fixed: the taskbar showed a sentence where the app name belongs.**
  Right-clicking the running app offered "Multi-session terminal
  emulator for network and Linux administration - SSH, Telnet,
  Serial..." as its jump-list title. Windows takes that label from the
  exe's FileDescription field, which despite the name is where an app
  puts its NAME - Firefox ships "Firefox", Chrome ships "Google
  Chrome" - and ours was carrying package.json's description. The
  sentence moved to Comments, which is the field that is for one.
  Also affects Task Manager and Explorer's Description column.
- The description itself no longer says "team session sync". The Team
  concept was re-homed as session sync a while ago; this copy of the
  old name was stamped inside the exe, which is a good place to forget
  one exists.

- **A green dot next to a session that is open right now**, and gone the
  moment it drops. The dots already in the tree are a memory - what the
  last Audit found, faded by age - and there was no way to say "this one
  is connected to me at this instant". This one is not a probe: it is
  the window reporting its own connections.
- **"Surprise me" can rotate.** A "change style every N minutes" setting
  moves it on to another of the styles you ticked, never repeating the
  one that just finished.
- **Fixed: "Terminal panes only" played over the whole window when no
  session was open.** The animation asked for the union of the open
  terminal panes, got nothing back, and fell through to the full window,
  which looked exactly like the setting had not saved. It now plays in
  the terminal AREA whether or not a session is in it, so the sidebar,
  tabs and toolbar stay put either way.
- **The idle animation now defaults to the terminal panes** rather than
  the whole window.
- **Field tools reopens with the folder and ports you used last.** The
  bind address is remembered too, but checked against this machine's
  real addresses first - a laptop that changed networks falls back to a
  live one rather than silently offering an address that has gone.

- **Field tools: a TFTP server, an HTTP server, and Wake-on-LAN.** The
  three things a laptop in a wiring closet actually needs to SERVE.
  `copy tftp: flash:` is still how an image gets onto a switch and
  Windows ships no TFTP server; newer gear pulls firmware over HTTP;
  and a magic packet wakes the lab box. All three are plain Node - no
  new dependencies, nothing bundled, nothing to license.
  The TFTP server speaks RFC 1350 plus the options that matter: without
  block-size negotiation a 1 GB image is two million lockstep round
  trips, so blksize and tsize are answered properly.

  This is where the app stops being purely a client, so the rules are
  stricter than anywhere else in it. Nothing listens until you press
  start. The bind address is chosen from this machine's actual
  addresses and "all addresses" is never the default. TFTP is
  read-only unless you tick uploads - it has no authentication of any
  kind, so the served folder is the entire security model, and every
  path is resolved and checked to be inside it, for reads and writes,
  on both servers. Every server carries a stop time, and while
  anything is listening the toolbar button says so.

- **Reachability dots fade with age, and say when they were measured.**
  Nothing is probed in the background - the dots come from the last
  Audit - but a two-week-old red circle at full strength reads as "this
  device is down right now". They now fade from solid to a ghost as the
  reading ages out to the fortnight staleness mark, and the tooltip
  says how old it is and that nothing runs in the background.
- **Opening a session updates its dot.** Connecting to a device is
  better evidence than a port probe, so a saved session you just used
  stops wearing a stale red dot. Only success is recorded - a failed
  connect can be a wrong password, which says nothing about whether the
  device is there - and nothing is ever probed on your behalf.
- **The sidebar toggle is no longer a hamburger.** At the far left of a
  title bar that promises an app menu; it only shows and hides the
  session tree. It now sits after the logo, with the panel glyph
  editors use.
- **A stray byte-order mark can no longer stop the app from starting.**
  Invisible in an editor, fatal to JSON.parse, and one Notepad save or
  PowerShell redirect away - the app refused to start with a corruption
  message. BOMs are now skipped when reading its JSON.

- **The session tree has folder and session icons.** A folder of
  folders used to be readable only by whether a row happened to show a
  host address - five folders and one session looked alike. Folders now
  wear the same amber folder as the file browser; sessions wear a
  prompt mark. The folder color moved into a `--se-folder` variable
  that tracks the theme's amber, so light themes get their own legible
  one instead of the dark-theme amber, in both the tree and the file
  browser.
- **Two light themes were missing their amber.** Sakura and Solar Light
  never took the light-tuned status colors, so anything amber on them -
  warning banners, refused-connection dots, and now folders - wore the
  dark-theme value on a pale panel. Both fixed; every light theme now
  has one.

- **The authentication-failed banner clears when you fix the profile.**
  Editing a profile's credentials now also lifts its lockout guard -
  previously you could change the password and the profile stayed
  halted until you found the banner's retry button, which is the
  opposite of obvious - and any banner for a profile disappears the
  moment a session using it connects, however you fixed it.
- **Banners stop piling up.** They can now replace each other in place
  and clear themselves: the audit shows one banner that counts "3 of 9
  devices checked" as it goes and then becomes the result, instead of
  leaving a stale "probing..." line above it. Anything with a decision
  to make, and every error, still waits for you.
- **"Set credential profile..." can create one**, like the Credentials
  dropdown in the session editor.
- **Choose which styles "Surprise me" uses.** Settings lists all seven
  with checkboxes - some are calm and some are chaotic, and which is
  which is a matter of taste.
- **The idle "Play over" setting applies immediately** instead of after
  a restart: settings are re-read at the moment an animation starts
  rather than trusted from a cache.
- **The pane close button is a real target.** Closing one session of a
  MultiTerm grid meant hunting a 9-pixel glyph; it is now a proper
  button that turns red on hover, alongside its neighbors.
- **Extras: "Full screen" is now "Full screen animation"**, so it does
  not read as a window control.

## 0.1.2 - 2026-08-22

- **Bricks and Aliens are playable, from a new Extras menu.** The
  button sits at the right end of the quick-connect row, under the
  theme picker: Play Bricks, Play Aliens, every idle effect on demand,
  and a shortcut to the idle settings. Arrows or A/D move, Space
  serves the ball or fires, Esc or a click quits; a score sits top
  right and the controls bottom left. The same rule as the idle modes
  applies - every key is swallowed, nothing reaches a terminal - and a
  nudged mouse does not end a game. Troubleshooting a stubborn tunnel?
  Blow the failed SAs away. A "Full screen" checkbox at the bottom of
  the menu is the same knob as Settings > Play over, put where people
  will see that "just the terminal panes" is an option at all.

- **Idle animations start on Windows Server and over RDP.** They never
  did: Server editions ship with "Show animations in Windows" off and
  RDP sessions turn it off too, Chromium reports both as
  prefers-reduced-motion, and the first version treated that as a
  veto - the setting looked broken on exactly those machines. The
  setting is off by default, so turning it on is the consent; Settings
  now shows a note when the OS asks for reduced motion, and plays
  anyway. Reproduced and verified with Chromium forced to report
  reduced motion and a real one-minute wait.
- **"Terminal panes only" for idle animations.** Settings > Play over:
  the whole window, or just the terminal panes with the sidebar, tabs
  and title bar showing through - so the rain falls in your terminal
  rather than over the app. Works with every style; the screen-aware
  ones keep their word positions.
- **Preview button** beside the idle style, like a Windows screensaver:
  saves the dialog, closes it, and plays the chosen style now.
- **Snow, Starfield and Fire get a dark ground on light themes.** White
  flakes on Sakura's paper was a flashbang; the ground is now a
  near-black tint of the theme's accent (Sakura: dark pink night with
  pink blossoms, Glacier: dark blue). Rain, Bricks, Life and Aliens
  keep the real terminal background, since they draw over its words.
- **Fire runs at half speed.**
- **Enter submits dialogs.** Enter (or Numpad Enter) in any dialog's
  text field presses its primary button - Connect in the one-off
  credentials dialog, Save in editors - instead of needing a click.
  Dialogs with their own Enter handling are unaffected.

- **Idle animations - something amusing to find when you come back to
  your desk.** Off by default; Settings > Idle animation picks a style
  and how many idle minutes before it starts (or "Surprise me"). Five
  styles, two of them yours: Rain lets the glyphs from your own
  terminals fall in the theme's accent (Phosphor makes it green, Ember
  orange); Bricks turns every word on screen into a brick, in place,
  and plays an automatic paddle against your show run; Life seeds
  Conway's Game of Life from the screen's cells; Starfield is the warp;
  Snow drifts and piles up along the bottom. Two rules keep it safe in
  a tool that talks to switches: it is an overlay, never the terminal
  (sessions keep running, logging and acking underneath, and nothing
  here can write into a buffer - a test pins that), and the keystroke
  that wakes it is swallowed before any terminal sees it, so the Enter
  you press to come back never runs whatever was sitting on a device's
  command line. Mouse movement wakes it with no side effect; a dialog
  the app raises takes it down; it pauses while the window is hidden;
  prefers-reduced-motion disables auto-start. "Idle animation: play
  now" in the palette starts it on demand. Fire joined the set after
  the first round: the demo-scene heat buffer, simulated at a fixed
  20 Hz so flame speed does not depend on the machine, colored by the
  theme - Ember burns orange, Phosphor green, Classic is a blue flame.
  And Aliens, the three arcade lineages in one: the words on screen
  fly in along curves and reassemble where they were, march as a block
  that speeds up as it thins, and peel off one at a time to dive and
  drop glyph bombs, while an auto-piloted ship at the bottom shoots
  back and dodges most of them. With a MultiTerm grid open, every
  pane's text joins the formation. Idle is global - one overlay over
  the window, triggered by keyboard and mouse silence, not per session.

- **Focus returns to the terminal after the multi-line paste dialog.**
  Paste a block of commands, hit Send, hit Enter to run the last line:
  the Enter now reaches the device, instead of needing a click back
  into the pane first. Cancel returns focus too.
- **A single hero image.** The four-theme quadrant grid was too busy to
  read at README scale, so it is one Classic-theme MultiTerm tab: four
  distinct fixture devices and a file browser that looks like a real
  flash: directory.

- **The profile list updates the moment a profile is saved.** It used
  to sit unchanged until closed and reopened, leaving you to wonder
  whether the save took or the wrong button got clicked - the New
  profile button was wired to a no-op instead of the refresh that Edit
  already used.
- **"Create a new profile..." in the Credentials dropdown.** Both the
  session editor and the folder editor's default-credentials list end
  with it; choosing it opens the profile editor on top, and on save the
  new profile is added to the list and selected. Cancel puts the
  dropdown back where it was.

## 0.1.1 - 2026-08-21

- **A desktop-parked portable no longer logs into %TEMP%.** The 0.1.0
  fix that kept logs/ off the Desktop skipped the desktop candidate,
  then fell through to "beside the exe" - which for a portable build
  is the EXTRACTED COPY running from a temp folder that changes
  between logon sessions. Logs looked like they vanished between runs;
  they were actually stranded across old temp folders (they are still
  there, under %LOCALAPPDATA%\Temp, until Windows cleans up, if you
  want to rescue any). Candidate selection now lives in a pure,
  tested module with two hard rules - never the Desktop, never
  anything under the temp directory - so a desktop portable goes
  straight to Documents\RSMultiTerm\logs. An explicitly configured
  Log folder was always honored and still is; RSMT_LOGDIR stays
  verbatim. Verified by running the packaged portable from a real
  Desktop: no logs/ beside it, Documents used, and the sidebar line
  says so.

- **Linux port preparation.** The app was Windows-only by assumption
  rather than by design, so the assumptions are now branches. Secret
  storage is the one that mattered: on Linux with no keyring, Chromium
  falls back to a backend that "encrypts" with a hardcoded key while
  still reporting that encryption is available - so the app would have
  offered to remember a password, stored it reversible-by-anyone, and
  said it was encrypted. The backend is now inspected, that fallback
  counts as no storage at all, and the UI names whatever is actually
  protecting the secret (Windows sign-in, macOS Keychain, a named Linux
  keyring) instead of hardcoding "Windows DPAPI" - or explains why the
  option is missing. Also: AppImage and .deb targets with a 512px PNG
  app icon (Linux ignores the .ico), a platform-appropriate default
  terminal font with a font stack that lands somewhere on every OS, a
  font-suggestion list per platform since Chromium's font enumeration
  is Windows/macOS only, and a serial-port permission error that names
  the `dialout` group instead of just saying "denied". Verified by
  running the engine and logic tests on Ubuntu unchanged - all of
  SSH, key install, hop pool, SCP and the auth guard included.

- **Four-theme hero image and a proper social preview.** The README
  hero is now a 2x2 quadrant shot - broadcast grid in Classic, the
  session tree in Garnet, the command palette in Synthwave, and the
  ssh-copy-id dialog in Ember - matching the CrossCanvas hero's four
  themes. The social preview follows the family layout: mark, name,
  tagline, and the app bleeding off the right edge. Both shot from the
  live app against the fixture estate.

## 0.1.0 - 2026-08-20

The initial public release.

- **Public-release preparation.** American spelling throughout per the
  house conventions (31 files of colour/behaviour/honours drift, all in
  comments, docs and UI labels - the code identifiers were already
  American). Test fixtures no longer use personal names. The README is
  rewritten for the current audience - single user first, sync second -
  with a real screenshot, install-and-verify instructions covering the
  SmartScreen warning and SHA-256 hashes, and a pointer to the security
  review. docs/ gains the screenshot and a 1280x640 social preview.
- **Install your SSH key on a device - ssh-copy-id, in-app.** Right
  click a connected SSH session (also in the palette): pick a key, and
  its PUBLIC half is appended to ~/.ssh/authorized_keys on the device
  over the session you already have open - you got in with a password,
  one dialog later the password is history. The key travels on stdin,
  never through a command line, so there is nothing to quote wrong;
  fresh files are born 0700/0600 the way sshd insists; a key that is
  already there - even behind a command="..." prefix - is detected
  rather than duplicated; a file without a trailing newline gets one
  before the append instead of fusing two keys onto one line; and the
  result is READ BACK to confirm, because exit 0 is not the same claim
  as "the key is in the file". The private key never leaves this PC.
  Network gear without a POSIX shell gets a plain answer pointing at
  the device's own CLI instead of a stack trace.
- **The app says it is logging, in the default view.** A quiet line
  under the session-tree toolbar reads "Logging sessions to <folder>"
  - always visible, always current, and clicking it opens the folder.
  Logging on by default is the right call for gear work; logging on
  silently reads as surveillance, so now it introduces itself. The
  Settings Log folder field gained a Browse picker - and it turned
  out both that field AND Log timestamps were decorative: saved
  faithfully, consulted by nothing. The logging resolver now honors
  both (per-session tree settings still win), and an invariant test
  pins each so neither can go quietly decorative again.
- **Logging has controls now - and stays off the Desktop.** Sessions
  and folders gained a Logging setting (log / no log / inherit, with
  the folder default flowing down like credentials and ports do), so
  what was always on by default can finally be steered per device.
  Fixing that surfaced a real bug: an explicit "no log" collapsed to
  "no opinion" on its way to the engine, which resolves back to
  logging ON - the off switch would have done nothing. And a portable
  exe parked on the Desktop no longer grows a logs/ tree next to the
  wallpaper: when "beside the app" IS the Desktop, logs go to
  Documents\RSMultiTerm\logs instead. (The logs/ folder already on
  your desktop is safe to delete or move; Settings > Log folder picks
  any location you prefer.)
- **Saved passwords, the convenient way - and only ever proven ones.**
  The password prompt now offers "Remember this password on this PC",
  encrypted with your Windows sign-in (DPAPI) - the same gating your
  PC already has, which is the home-lab trust model. Two rules keep it
  honest: the secret is only stored once it has actually opened a
  device (a typo is never remembered - the save commits on successful
  connect, and an auth failure drops it), and the profile flips to
  "saved" storage so the editor and the prompt agree about next time.
  Key passphrases get the same offer. Saving a quick connection now
  offers to keep the password you used with the new profile too - it
  already opened the device on screen, so it qualifies. The profile
  list now says what each profile actually does: "SSH agent", "key,
  passphrase saved", "password saved", or "asks at connect".
- **Session-tree buttons span the sidebar** instead of huddling on the
  left, matching the Files pane's controls.
- **Keep a quick connection.** Quick connect is throwaway by design,
  which is annoying the moment a box turns out to be worth revisiting.
  An unsaved session now offers a star in its pane header, a "Save
  '<host>' as a session..." item at the top of the tab right-click
  menu, and a command palette entry - all opening one small dialog:
  name, folder, and which credential profile to use, with an offer to
  create a profile from the username you typed. Both the button and
  the menu item disappear once the session is saved, and never appear
  on a pane opened from the tree. The password you typed is
  deliberately NOT saved: a saved session refers to credentials by
  profile name, so a new profile is created in prompt mode and the
  password is asked for next time. The running session is left exactly
  as it is, including what a reconnect will redial.
- **SSH keys are now the default way in.** The engine could always
  authenticate with a key; nothing in the UI ever offered one, so the
  path may as well not have existed. Credential profiles now choose
  between an SSH key, an SSH agent, and a password - and a new profile
  on a machine that has keys or a running agent defaults to those
  rather than to a password. The key picker lists what is actually in
  your ~/.ssh, with type and comment, so nobody types a path from
  memory; "Another file..." opens a browser for keys kept elsewhere.
  Keys are inspected before they are saved, so the two files everyone
  picks by mistake say something useful: a .ppk points at PuTTYgen's
  Export OpenSSH key, and the .pub half says it is the public one. An
  encrypted key asks for its passphrase at connect (or saves it
  encrypted, verified before saving so a typo cannot be stored), and
  the dialog says plainly that a passphrase decrypts a local file and
  is never sent to the device. A wrong passphrase now fails as what it
  is - a local key problem - instead of counting as a refused login and
  halting the profile.
- **Reset font size in the tab right-click menu**, greyed out when the
  font is already the size from Settings, so the menu also answers
  "am I zoomed?".
- **"Team" is now "sync", and it lives where sessions live.** The
  shared-sessions file was never really a team feature: it keeps one
  session tree in step with another copy of it, which is as true of a
  laptop and a workstation over a NAS share as it is of a group on
  SMB. So the top-bar Team button is gone (the bar is shorter for it),
  the file is configured in Settings under "Sync sessions file" - with
  a Browse button, rather than a path typed from memory - and Publish
  and Check live in the session tree's Import menu, appearing only
  once a sync file is set. Someone who never sets one never sees a
  word about syncing. Nothing was removed: the same three-way merge,
  conflict review and credential-free publishing run underneath, and
  importing from MobaXTerm, CSV or a session file is where it already
  was, next to the tree it fills.
- **The build now publishes SHA-256 hashes.** `npm run release` writes
  dist/SHA256SUMS.txt beside the installer and portable and prints
  them. There is no signing certificate, so Windows will still call
  both downloads unknown-publisher - a hash cannot fix that. What it
  does answer is the question it can: whether the file someone
  downloaded is the file that was built. The format is sha256sum's, so
  `sha256sum -c` works, and the build prints the Get-FileHash line for
  Windows.
- **Security review pass (pre-release): four fixes.** A device you
  connect to could steer a local write: batch-downloading files used
  the name straight from the remote directory listing, so a hostile
  server answering with a name full of '..' segments could land a
  file outside the folder you picked - now every remote name is
  reduced to a plain filename before it touches a local path, on both
  sides of the IPC boundary. The smoke-test environment hooks that run
  JavaScript in the renderer and write a named file are now refused in
  packaged builds outright. The team share file is read with a 32 MB
  ceiling instead of unbounded. Tab colors are hex-validated where
  they are used, not only where they are saved. Full writeup, threat
  model, and the surfaces that came back clean:
  docs/security-review-2026-08.md.
- **External review pass (pre-release): five fixes.** CSV export no
  longer fails outright when a name, host, tag or note begins with
  '-', '=', '+' or '@' (the Excel formula guard tripped over its own
  const). Session logs now decode UTF-8, so box drawing, accents and
  emoji survive stripping instead of being garbled or eaten - and a
  UTF-8-encoded escape sequence still strips, so a logged file remains
  safe to cat. Closing a tunnel now removes its listeners from the
  shared bastion connection (a day of tunnel churn used to grow them
  without bound, and a reopened remote forward could double-accept).
  The engine now frees a session's resources when the remote side
  hangs up, not only when the pane closes. Credential profiles gained
  a "Forget password" button - blank still means keep, forgetting is
  now its own explicit action. Port handoff to the renderer is also
  pinned to same-origin as defense in depth.
- **Multiline pastes into a single session now confirm first.** The
  MobaXterm dialog: paste something carrying line breaks and the app
  shows exactly what is about to be sent before anything reaches the
  device - each line can execute the moment it lands in a shell. The
  dialog has a "do not ask again" checkbox for single-session pastes,
  and Settings > Multiline paste brings it back. Broadcast pastes keep
  their own confirmation, which is not optional.
- **Tabs have a fuller right-click menu.** Rename tab (with "use
  automatic name" to hand the label back to the app), a MobaXterm-style
  tab color stripe for prod-red/lab-green habits (kept across restarts
  by workspace resurrection), font size shortcuts, and "Save terminal
  output..." which writes the pane's scrollback as plain text - also
  available from the terminal's own right-click menu.
- **File browser: copy path, real icons, quieter dotfiles, and an
  overwrite warning.** Right-click copies the full remote path (or all
  selected paths, one per line). Folders wear a folder icon, files a
  file icon, and hidden dotfiles render faded the way MobaXterm does.
  Uploading a file whose name already exists on the device now says so
  and asks - it used to replace the remote file silently, and so does
  MobaXterm.
- **Ctrl+mousewheel zooms the terminal font.** Wheel over any terminal
  pane with Ctrl held to grow or shrink the text (7-40px); Ctrl+= and
  Ctrl+- do the same from the keyboard, and Ctrl+0 snaps back to the
  size from Settings. The zoom is for THIS window right now - screen
  sharing, the geezer-font request - so it applies to every pane at
  once and is never saved; restart and you are back to your settings.
  The status line shows the size as it changes.
- **The font field now suggests fonts you actually have.** The Settings
  font box lists the machine's installed monospace fonts (proportional
  faces are filtered out - a terminal in Arial helps nobody) instead of
  expecting the family name typed from memory. It is still a free-text
  field: anything can be entered, and on a machine that refuses font
  enumeration a short list of common monospace names appears instead.
- **Removed Electron's hidden default menu - Ctrl+R can no longer kill
  every session.** The stock menu bar was hidden but its keyboard
  shortcuts were still live: Ctrl+R silently reloaded the UI (dropping
  every connected session), Ctrl+Shift+I opened devtools, and Ctrl+= /
  Ctrl+- / Ctrl+0 zoomed the whole app window. All gone; those zoom keys
  now belong to the terminal font.
- **Multiline paste honors bracketed paste - and stops losing commands to
  sudo.** Pasting "sudo systemctl stop x" plus two more lines ran the
  first and silently discarded the rest: unbracketed paste leaves unread
  lines in the kernel's tty queue, and sudo flushes that queue on purpose
  (so type-ahead cannot become a stray password attempt). When the remote
  shell has switched bracketed paste on - every current bash/zsh/fish -
  pastes now travel wrapped in the markers, land in readline's own buffer
  where nothing can flush them, and nothing executes until Enter, exactly
  like every modern terminal. Devices that never enable it (network gear)
  see byte-identical input to before. Pasted content carrying a literal
  end-marker is neutralized, so a hostile paste cannot break out of the
  bracket. Snippets keep executing on send, wrapped plus one Enter.
- **Drag a file onto the file browser to upload it.** The
  iterate-on-a-build workflow: drop the bundle on the panel, run the
  installer from the terminal. Multiple files upload in order with
  progress; the panel outlines while a drag is over it; dropped folders
  are refused with a message rather than a stack trace. Works in SCP mode
  too.
- **The file browser has multi-select, and delete asks first.** Click,
  Ctrl+click and Shift+click select like the session tree; the row menu
  then offers "Download N files..." into one chosen folder and "Delete N
  items...". Deleting - one item or many - now shows exactly what is
  about to go and reminds you there is no undo on the device; it used to
  delete on the first click of a context-menu item.

- **Right-click works on the session tree.** Every row offers the
  toolbar's controls where the mouse already is: Start MultiTerm and Add
  to MultiTerm for the selection, Edit (bulk edit for a multi-select),
  Delete, and on folders New session/folder here and Audit. Right-clicking
  something outside the current selection selects it first, so the menu
  always acts on what is under the cursor. New in the menu: "Set
  credential profile...", which stamps a profile onto every selected
  session in one move - the one-click fix for imported sessions.
- **Connecting without a usable credential profile asks instead of
  failing.** An SSH session with no profile used to dial with blank
  credentials and die with whatever the server said; one naming a profile
  that does not exist on this machine showed a banner and left the pane
  dead. Both now park the connect and raise a dialog: pick an existing
  profile (with "remember on this session", on by default, so next time it
  just connects) or type credentials for this connect only - never stored,
  and a reconnect deliberately asks again. Choosing a profile re-enters
  the normal flow, so prompt-mode, canary fan-out and trip-on-failure all
  apply exactly as if the session had carried the profile from the start.
  Bulk-opening several profile-less sessions queues the dialogs one at a
  time instead of stacking six modals.

- **The remote shell is told the real window size.** A shell that thinks it
  has 80 columns while the terminal has 180 wraps its redraws at the wrong
  place, so recalling a long command from history ate a row of the screen
  and walked the cursor up - eventually clearing the window entirely. The
  size only ever reached the far end if an xterm resize event happened to
  fire after the data port attached, and nothing sent it otherwise: the
  fixture now reports what it was told, and it was 80x24 with zero resizes
  against a 180x44 terminal. The renderer now states its size the moment
  the port attaches, and the SSH transport remembers a size that arrives
  mid-handshake and applies it once the shell channel opens. Both halves
  are needed: the port can attach either side of the pane being measured.
- **Paste works again.** Right-click, middle-click, Ctrl+Shift+V and the
  context menu all read the clipboard, and the window's permission handler
  - added to deny everything the app does not need - allowed only the
  write. Every paste failed with "Read permission denied" into a catch
  that swallowed it, so it looked like the mouse modes were broken rather
  than the permission. Clipboard read is allowed now, on both the request
  and the synchronous check handler, and a failed paste says so in the
  status bar instead of doing nothing.

- **Context menu items work again.** Clicking anything in a floating menu -
  Import, the tab right-click menu, the file browser's row menu - did
  nothing. The menu dismissed itself on ANY mousedown, which tore it out of
  the page between mousedown and mouseup, so the click never reached the
  item; worse, it landed on whatever the menu had been covering, meaning a
  menu click could press the button underneath. Dismissal now only happens
  when the mousedown is outside the menu. Tests had not caught this because
  they clicked items with `.click()`, which dispatches no mousedown at all
  and so never triggered the dismissal a real mouse does.
- **Importing is where sessions are, not buried under Team.** Bringing
  sessions in - from MobaXTerm, a spreadsheet, or an exported session file
  - was only reachable inside the Team dialog, which is the last place
  anyone looks when they want to import their old sessions; sharing with a
  team and importing from another program have nothing to do with each
  other. The session tree now has its own Import menu with all three
  sources and both exports, and the palette answers to "mobaxterm" and
  "import" as well. Nothing about the import itself changed: it has always
  been a plain file picker, so an .mxtsessions exported from a portable
  MobaXTerm anywhere on disk works - no installation, no fixed location.
- **`hidden` now actually hides.** The attribute only carries a
  UA-stylesheet `display: none`, so any rule of ours that sets display -
  and an id selector always does - beat it silently. The command palette,
  the search bar and the tab strip each set `hidden` to close and never
  visually closed; the quick-connect field groups had already grown
  one-off guards for the same fault. One global rule now makes the
  attribute mean what it says, and a test keeps it there. Tests had been
  passing throughout because they checked `el.hidden`, which was correct -
  it was only the pixels that were wrong.

- **Quick connect moved to its own row.** The toolbar had grown past the
  window: on a screen narrower than about 1525px the theme picker and the
  buttons beside it were simply off the edge when the app opened. Quick
  connect's fields are the widest thing in the bar, so they now sit on a
  second row and the top bar holds only fixed-width buttons - it fits at
  the 900px minimum window with room to spare, measured rather than
  eyeballed. The host field takes some of the space that freed up, and
  "Merge into MultiTerm" sits after a divider on the new row, separating
  connecting somewhere from rearranging what is already open. The default
  window width used to exist to fit that one long bar; it is unchanged,
  but for an honest reason now - how much terminal fits side by side.

- **One brand mark everywhere.** The header logo was a separate SVG written
  by hand in index.html, so the app literally displayed a different mark from
  the one in its title bar and taskbar - an outline square with a chevron and
  an underline, against a filled badge with a chevron and a block cursor. The
  artwork now lives in `public/brand/`, the header renders those files
  directly, and `npm run icon` generates the .ico from the same source.
- **The icon no longer changes what it depicts between sizes.** Large sizes
  used to add a pane divider and output lines that small sizes could not
  resolve, so 32px and 256px read as two different logos side by side. Both
  variants now draw the same thing; the small one only differs in stroke
  weight and margin, which is what a small size actually needs.
- **Every .ico entry is uncompressed.** The 128 and 256 pixel entries were
  PNG-compressed, which is legal but unreadable by GDI+ - so System.Drawing
  and older Windows tooling silently fell back to a smaller size.

- **A dead stdout can no longer crash the app.** Writing a diagnostic line
  to a pipe nobody is reading raises EPIPE, and an unhandled stream error
  in the main process is not a dropped log line - it is Electron's "A
  JavaScript error occurred in the main process" dialog, which is modal,
  so the app then sits there waiting to be dismissed rather than working
  or exiting. A packaged GUI app hits this easily: launched from a shell
  that has since closed, or with its output piped somewhere that stops
  reading. Diagnostics are best effort now and never throw. The test
  asserts both halves - that an unguarded write to a closed pipe really
  does kill a process, and that a guarded one does not - so it cannot
  quietly stop measuring anything.

- **The file browser shows modified, owner, group and permissions.** The
  panel listed names and sizes, which is enough to find a file and not
  enough to answer anything about it. Permissions render the way `ls -l`
  writes them, special bits included, so a stray `-rwsr-xr-x` reads as a
  finding rather than hiding in an octal; hovering gives the octal you
  would actually type into chmod. Owner and group come from the server's
  own listing line - the only place SFTP carries names rather than
  numeric ids - and fall back to the numbers when a server does not send
  it. Timestamps follow the `ls` convention of showing the time for
  recent files and the year for old ones. The sidebar starts narrow and
  is draggable, so the columns appear as it widens instead of squeezing
  the filename, which is what the panel is actually for.
- **Closing the app asks once, not twice.** Saving the workspace on the
  way out cancels the close, snapshots, and closes again - and that
  second pass asked "N sessions still connected" all over again. The
  sequencing now lives in one pure function with a test that drives a
  whole close and counts the questions.

- **xterm.js 6.0.** The terminal engine and all five addons move to the
  6.0 release set (fit 0.11, search 0.16, serialize 0.14, webgl 0.19,
  clipboard 0.2 - which finally leaves beta). Nothing in the app needed
  changing: every API in use kept its signature, and 6.0 still ships the
  UMD build this no-bundler renderer loads by script tag. What comes with
  it: **synchronized output** (DECSET 2026), so full-screen TUIs and bulk
  redraws over a slow link stop tearing mid-frame; a viewport and
  scrollbar rebuilt on VS Code's platform; and WebGL rendering fixes for
  cursor blending. The upgrade was verified by capturing a behavioral
  baseline on 5.5 first - decoration count, OSC 133 command tracking and
  exit codes, hint targets, search matches, serialized bytes, clipboard
  write - and requiring an exact match afterwards, plus a scrollback pass
  the rewritten viewport had to survive: prompt navigation still jumps
  through a 46-line scrollback and the failed-command marker still paints.

- **Remote clipboard (OSC 52).** A yank in remote tmux or vim now reaches
  your local clipboard - the daily-driver feature for anyone living in
  SSH sessions. The security split is deliberate and enforced in code, not
  just settings: WRITE (a remote program putting text on your clipboard)
  is the useful, low-risk direction and is on by default, with a size cap
  so a hostile server cannot shove megabytes in and a quiet status-line
  note so it is never invisible; READ (a remote asking what is ON your
  clipboard - which might be a password you just copied) is refused
  unconditionally and hands back an empty string, and no setting turns it
  on. A settings toggle governs the write direction. The test drives the
  real vendored addon's OSC 52 handler and asserts the read path can never
  encode the clipboard back to the device.

- **Your layout comes back.** Closing the app now remembers the tabs, the
  pane order, what each pane was connected to, and their scrollback;
  reopening offers to restore it. Restored panes come back DEAD on
  purpose - the layout, the titles and yesterday's output, with the R key
  armed - because an app that redials thirty devices because it was
  launched is a canary stampede and a lockout risk wearing a convenience
  costume. "Restore and reconnect" is there for when that IS what you
  want, and it dials one at a time behind the same auth guard.
  Reconnecting a restored ad-hoc session asks for its password (prefilled
  with the username, cursor in the password box) rather than spending an
  authentication attempt on a blank one - snapshots never carry a
  password, which the test suite asserts against the file on disk.
- **Two bugs found by testing this end to end, both worth naming.** The
  serialize addon was dropped from the page back when it was unused, so
  the first pane to ask for it threw inside pane creation and took
  *every* session in the app down with it - vendor-check now fails when
  the renderer uses an xterm addon the page does not load, and pane
  creation treats that addon as optional. And the cheap layout-only save
  that runs on every tab change used to overwrite the scrollback in the
  snapshot, so restoring a workspace and then crashing lost the very
  scrollback still on screen; saves without scrollback now carry forward
  what was already stored.

- **Shell integration installer.** The semantic-prompt features (prompt
  navigation, copy last command output, red markers on failed commands)
  need the far end to mark where commands begin and end. Right-click a
  session or use the palette, and the app offers three ways to arrange
  that on a Linux host: apply to the running shell only (nothing written
  to disk, gone at logout), install it properly (writes
  `~/.rsmultiterm-shell-integration.sh` and adds one guarded line to the
  rc file), or copy the snippet for people who push dotfiles with
  Ansible rather than by typing. There is an uninstall for both. bash,
  zsh and fish are covered; bash uses PS0 where it exists, which is more
  reliable than a DEBUG trap and misfires on neither completion nor
  PROMPT_COMMAND. Every script is shown in full before it is sent, and
  it goes to the ONE focused pane even when broadcast is on - typing an
  rc-file heredoc into six switches at once is exactly the accident this
  app exists to prevent. The bash snippet is not merely eyeballed: the
  test suite sources it in a real interactive bash and asserts the
  emitted marks in order, including the exit status of a failing
  command. (That test earned its keep immediately - it caught a first
  draft where exit codes stopped being reported after the first
  command.)

- **Tunnels: port forwarding with a real manager.** Local forwards (-L),
  a SOCKS5 proxy (-D) and remote forwards (-R), each saved by name and
  run over one of your saved SSH sessions. The point of building it here
  rather than reaching for PuTTY: **a tunnel shares the session's pooled
  connection.** If the switch (or its jump host) is already open in a
  pane, the tunnel costs no second authentication - which on a rotating
  AD account is not a nicety but the difference between one attempt and
  two. Two tunnels and six terminals through one bastion are still one
  login. The manager lists every tunnel with live state: connection
  count, active connections and bytes each way, refreshed while it is
  open, with the real listen port shown (ask for port 0 and it reports
  the ephemeral one it got). Tunnels can open automatically when their
  session connects. Listeners bind to 127.0.0.1 unless you deliberately
  say otherwise - a forward on 0.0.0.0 turns the machine into an open
  relay onto the management network. Credentials resolve through the
  same auth guard as sessions, so a tripped profile refuses to dial and
  a prompt-mode profile with nothing cached says so instead of trying a
  blank password.

- **Snippets: the command manager.** Named, reusable command sequences
  with {{param}} placeholders that are asked for at send time - "Bounce
  interface {{interface}}" prompts for the interface and sends the
  shut/no-shut sequence to the focused pane. Managed from the Snippets
  button or the palette (every snippet is fuzzy-findable there), and
  shared with the team through the team file under the same rules as
  highlight sets: whitelisted fields only, structure-checked on read,
  adopt-missing-only so an edited snippet is never overwritten by a
  sync. Sending to a broadcast ALWAYS confirms first, single-line
  included - a snippet ends in a carriage return, so unlike a paste
  there is no not-pressing-Enter safety margin. Ships with three
  starters (save config, bounce interface, interface health), all
  editable.

- **Address purple is one step darker, and the shipped rules learned the
  two things the community actually agrees on.** A survey of the popular
  SecureCRT keyword packs, ChromaTerm's defaults and the cisco.vim family
  showed the shipped set already sits on every strong convention (green
  up, red down, flashing err-disabled, blue interfaces - and SM-yellow /
  MM-aqua mirrors the physical TIA-598 jacket colors, which no terminal
  pack even attempts). Purple addresses are this app's own choice and
  stay: the community plurality is cyan-for-IPs, which would collide
  with interface blue and lose address-vs-interface separation. The
  purple deepens from #ce93d8 to #ba68c8 - the darkest value that clears
  the display-time contrast floor on the dark theme - across IPv4, IPv6
  and MACs. Newly adopted where consensus is real: ACL verdicts (permit
  green, deny red - unanimous among packs that have them), OSPF stuck
  adjacency states in amber, and non-zero error counters ("0 CRC" stays
  quiet, "3194 CRC" is the line being hunted). Existing installs get the
  color correction only on rules whose pattern AND color are still the
  shipped ones - the seed machinery now supports color fixups with the
  same once-you-edit-it-it-is-yours rule as pattern fixups.

- **Highlighted text no longer doubles under the GPU renderer.** The
  highlight engine used to repaint matched text inside a DOM overlay -
  invisible over the DOM renderer because the metrics matched exactly,
  but under WebGL the overlay copy drifted against the glyph atlas and
  every highlighted token (which in `show ip arp` is most of the screen)
  rendered twice at a growing offset. Rule colors now go through
  xterm's decoration cell-coloring, which the renderer itself paints:
  pixel-perfect under both renderers, with contrast correction intact.
  Blink alternates the decoration itself instead of CSS opacity (same
  on-beat/off-beat behavior), underline rides an empty overlay's
  border, and bold now renders as color only - a faithful bold means
  repainting glyphs, which was the bug.

- **Quick-select hints.** Ctrl+Shift+Space overlays a key label on every
  IP, MAC address, interface name and URL visible in the focused pane.
  Type the label and it is on the clipboard; Alt+label on an IP opens an
  SSH session to it. Born for `show ip arp`: the address you need stops
  being a mouse target. Esc leaves the mode.
- **Command palette.** Ctrl+Shift+P fuzzy-finds across every saved session
  (name, host, folder path) and the app's commands. Enter opens in a new
  tab, Shift+Enter adds to the current MultiTerm. Typing anything
  host-shaped offers "SSH to <it>" directly.
- **Semantic prompts (OSC 133).** When a shell marks its prompts - any
  Linux box with shell integration, and both fixture devices - the
  terminal remembers where commands are: Ctrl+Alt+Up/Down jumps
  prompt-to-prompt through the scrollback, "Copy last command output"
  (context menu and palette) grabs exactly the last command's output with
  no mouse selection, and a command that exited non-zero carries a red
  bar at its prompt line so failures are findable in a long change
  window. Devices that mark nothing behave exactly as before.

- **Find in scrollback.** Ctrl+Shift+F opens a search bar on the focused
  pane: live match count, Enter/Shift+Enter to step, Escape hands focus
  back to the terminal. The search addon had shipped in the bundle since
  v1 without ever being wired to anything.
- **The GPU renderer is actually on.** Same story: the WebGL addon was
  loaded on the page and never instantiated, so every pane ran on the slow
  DOM renderer. Terminals now render on the GPU, with the documented
  fallback to the DOM renderer on context loss or missing GPU. The
  serialize addon, which nothing uses yet, no longer loads at all.
- **Escape closes one dialog, not all of them.** Stacked dialogs (a
  password prompt over settings, the profile editor over the manager) all
  closed on a single Escape - each firing its cancel action, including
  answering a password prompt the user never saw. Dialogs now form a
  stack and Escape only pops the top. A context menu also stops losing
  its Escape handler to the first unrelated keypress.
- **Shortcuts stay out of forms and dialogs.** Ctrl+Shift+V from inside a
  text field used to send the clipboard to a live device while the user
  thought they were editing a form. All terminal-facing shortcuts now
  ignore form fields and open dialogs - and Ctrl+Shift+C, advertised in
  the mouse-mode help but never implemented, copies the focused pane's
  selection.
- **Clicking an unfocused pane no longer rebuilds the grid.** Focus
  changes repaint in place; the full re-render (which re-parents every
  pane and killed a drag-selection started in an unfocused pane
  mid-mousedown) only happens when the layout actually changes.
- **Assorted small truths.** Tab titles shed their stale "+N" when panes
  close back down to one; error text from devices is scrubbed of escape
  bytes before being echoed into a pane; a keyboard-interactive-only
  bastion now works as a jump hop (same one-attempt auth discipline as a
  direct connect); two same-named sessions started in the same second log
  to separate files; cancelling a device audit stays cancelled when a new
  audit starts; a one-byte keystroke echo no longer ships an 8KB buffer
  slab across the data port; the highlighter no longer schedules a scan
  against a disposed terminal; the unused rs:session.write IPC channel is
  gone from the preload allowlist.

- **"ANSI-stripped" logs now actually strip everything.** Two escapes
  survived the stripper: C1 controls (0x80-0x9f - 0x9b IS CSI and 0x9d IS
  OSC to a UTF-8 terminal, so a device could plant sequences that execute
  when someone cats the log), and ESC-plus-intermediate sequences like the
  charset designation `ESC ( B` vim emits constantly, whose final byte
  leaked as a stray `B` in the log text. Both are swallowed whole now, with
  byte-split tests.
- **A failed download deletes its partial file.** SFTP left whatever
  fastGet had written; SCP reported success even when the final disk flush
  failed, and never checked the trailer byte where a device reports
  trouble after the data. A truncated startup-config that looks complete
  is the worst file this app could produce; now a download either
  completes or leaves nothing.
- **Mid-session deaths say why.** An ECONNRESET or keepalive timeout after
  connect was indistinguishable from a clean exit ("connection closed").
  The reason is captured and reported, and an auth-blocked verdict is no
  longer overwritten by the closed status that follows it.
- **2FA-style prompts fail fast with the real reason.** A server asking for
  keyboard-interactive input this app has no UI for (verification codes,
  echoed prompts, KI with no stored password) used to hang the connect and
  die 15 seconds later as a misleading "handshake timeout". It now fails
  immediately, quoting the server's prompt, without burning an auth
  attempt on a made-up answer.
- **Reading a fingerprint no longer races a 15-second timer.** The
  handshake timeout kept ticking behind the first-contact host key dialog,
  so examining the fingerprint for more than ~15s failed the connect (and
  then recorded the trust anyway). First contact with an unknown host -
  target or jump hop - now gets a two-minute handshake window; known hosts
  keep the tight timeout.
- **An engine crash settles everything waiting on it.** SFTP transfer
  promises hung forever (the UI showed a transfer that would never end)
  and a host key answered after the crash posted to the new engine with a
  checkId it never issued. All waiters are now swept when the engine
  restarts. The engine also drops its cached SFTP channel state when a
  session disconnects instead of growing those maps for its lifetime.
- **The share cannot steer teammates' machines.** logging.folder is a
  local path and now never travels - stripped on publish and stripped on
  read, so a hand-edited team file cannot redirect anyone's session logs
  ("log terminal output into Startup"). Highlight sets off the share are
  structure-checked with a pattern-length cap before adoption, and
  settings updates from the renderer are validated (unknown keys refused,
  pollSeconds clamped so the share cannot be hammered at 1ms).
- **Telnet notices a dead peer.** TCP keepalive was never enabled, so a
  firewall idle-drop left sessions "connected" forever. Serial errors
  without a close event no longer zombie the session either.
- **CSV exports are Excel-safe.** A cell starting with = + - or @ is
  executable in Excel, and names and notes can arrive from the team share
  - so an export-then-open was a code path from a teammate's keyboard into
  Excel. Dangerous leading characters get Excel's own text marker.
- **The broadcast toggle lights the right button.** Three pane-header
  buttons shared one class, so exclusion state painted the Files button
  (or Duplicate) while the actual toggle never changed - on the flagship
  safety feature, the visual truth was wrong. Each button has its own
  class now.
- **Permission requests are denied by default.** Electron grants
  microphone/camera/etc. requests when no handler is set; the app now
  denies everything except the sanitized clipboard write its copy path
  uses.

- **Jump-host connections stop leaking on failure paths.** The pool's
  refcounts were only correct when everything worked: a gateway that died
  kept its hold on the gateways beneath it forever, a chain that failed at
  the last hop left every hop it did reach pinned, a gateway that could not
  reach the target never released at all, and reconnecting before the old
  riders noticed could tear down the fresh connection under them. Over a
  workday of flaky networks those add up to dead connections and phantom AD
  auths held until app restart. The pool now hands out release-once handles
  tied to the exact connection they came from, and every ending - refs
  drained, gateway death, failed build - settles its own accounts. The pool
  finally has a test file, and every scenario in it ends with the pool
  provably empty.
- **Closing a pane mid-connect really cancels the connect.** It was a no-op
  before the transport existed: an SSH connect kept dialing into a pane
  that was gone, and a serial open completed and held the COM port - which
  is exclusive on Windows, so the next open of that console cable failed
  with "Access denied" until the app restarted. Both transports now carry
  an abort flag the resumed connect honors.
- **A failed connect reports its verdict before its funeral.** The engine
  emitted 'closed' before 'connect-failed' (the transport's close event
  fires before the rejection propagates), and the canary cleanup added in
  the previous batch acts on 'closed' - so an auth-failed canary could
  release its queue in the instant before the guard tripped. The close is
  now held until the verdict is out; a test pins the order.
- **The team-file lock can no longer eat a live lock.** Three separate ways
  it could: a torn read on SMB (partial write looks like garbage, and
  garbage was treated as deletable), a check-then-delete race (the stale
  lock is replaced by a fresh one between the check and the delete), and
  clock skew between team machines (staleness compared your clock to a
  timestamp written by theirs). Lock content is now never trusted for
  anything; staleness is judged by file mtime against a probe file written
  to the same share, so both timestamps come from the file server's clock;
  and breaking a stale lock claims it by rename first, so exactly one
  breaker wins and a mid-race fresh lock is put straight back.
- **Publishing no longer freezes the app while waiting for the lock.** The
  retry loop busy-waited on the main process event loop - up to ten full
  seconds during which terminal output, IPC, and the UI all stopped.
  Publish is now async and sleeps between attempts.
- **The merge dialog refuses to apply a plan the share has outgrown.** If a
  teammate published while the dialog was open, the apply silently
  recomputed against the NEW file: conflicts the user never saw defaulted
  to "take theirs", and unseen changes folded into the sync base where they
  would be reverted on the next publish with no conflict ever shown. The
  plan now carries a fingerprint of the remote state it was computed from,
  and an apply against a moved share re-opens the dialog on current state
  instead.
- **A parent cycle can no longer hang the app.** Crossed folder moves - you
  move A under B while a teammate moves B under A - are disjoint edits to
  different nodes, so the merge auto-applied both and produced a loop that
  every ancestor walk (connect, publish, audit, CSV) would spin on forever.
  The merge now repairs cycles by reparenting the loop to root, every
  ancestor walk carries a guard, upsert validates parentId the way move
  always did, and team files with prototype-name node ids are refused.

- **A stale password now really costs one wire attempt.** The promise held
  for the canary fan-out but not inside a single connect: on gear offering
  both `password` and `keyboard-interactive` (AD or TACACS behind sshd -
  most of the estate), a rejected password fell through to the KI prompt,
  which was auto-answered with the same password. Two backend strikes per
  connect, from the feature that exists to prevent exactly that. The auth
  handler now reads the server's continue-list: if `password` is still
  offered after our attempt, the backend rejected the credential and KI is
  not tried; if the method itself was refused (KI-only boxes), the password
  never reached a backend and the KI path still works. A new wire-level test
  counts attempts at a real SSH server for all three cases.
- **Closing a connecting pane no longer strands its credential profile.**
  A canary that ended without a verdict - its pane closed mid-handshake, or
  the engine restarted under it - stayed registered forever, so every later
  connect using that profile parked behind a canary that no longer existed,
  and Reset could not recover it (the release re-parked behind the same
  ghost). Canary and parked entries are now swept when a session goes away
  and when the engine restarts (parked panes fail visibly rather than
  queueing forever), and Reset clears a stuck canary too. Closing a parked
  pane also removes it from the queue, so a later release cannot dial a
  session whose pane is already gone.
- **Ctrl+V now gets the same broadcast confirm as every other paste.** The
  app's own paste paths (Ctrl+Shift+V, right-click, middle-click) always
  confirmed a multi-line payload before fanning it out; native paste went
  through xterm's own clipboard handling straight to stdin - and with
  broadcast on, out to every pane, silently. The paste event is now
  intercepted at the pane and routed through the confirming path.
- **A session that connects no longer steals the keyboard.** Every
  `connected` event focused its terminal unconditionally - including panes
  parked offscreen and sessions in background tabs, and while a password
  prompt had focus, which could type the rest of a password into whichever
  remote shell happened to finish connecting. Focus now moves only to the
  focused pane of the active tab, and never while a dialog or form field
  has the keyboard.
- **Dead panes leave the broadcast.** A disconnected pane kept
  participating: keystrokes typed into it (the R of "press R to reconnect"
  included) fanned out to every live pane, and it still counted in
  "Broadcast: N of M". Input from or to a dead pane now stays put.
- **Press R to reconnect works from inside the terminal.** The R handler
  ignored key events from text fields, and xterm's focus target is itself a
  textarea - so the hint printed into the pane pointed at a key that did
  nothing from the one place you would press it. The terminal's own textarea
  is now recognized, and R still types normally into live sessions.
- **Rename, new remote folder, create-profile and rename-set dialogs work.**
  All four used `window.prompt()`, which Electron does not implement - it
  throws, so the clicks did nothing. They now use a proper one-field dialog
  (Enter submits, Escape cancels).

- **The file browser clears when its session goes away.** Closing a session
  left the panel showing that device's name, path and listing, as though it
  were still live - only the listing went away, and only if you switched
  sidebar tabs. It now resets on disconnect, on the pane closing, and when no
  session is focused, with its controls disabled so nothing there can be
  clicked at a device that is not there.
- **A reconnect no longer fails while the file browser is open.** Chasing the
  stale-panel report turned up a real fault behind it: the panel rebinds the
  instant a reconnect creates its session, and asking that still-handshaking
  client for a file channel wrote a channel-open into the middle of key
  exchange. The device answered "Bad packet length" and dropped the
  connection, so the reconnect failed - intermittently, depending on which
  won the race, and when it did connect the device was misreported as
  SCP-only. File requests now wait for the handshake instead of interrupting
  it, at both ends of the IPC.

- **Packaged builds no longer show Electron's icon in the title bar.** Two
  causes, both fixed. The window was given `build/icon.ico`, but that
  directory is build resources and was never packaged, so inside the asar the
  path did not resolve and Electron fell back to its own logo; the file is
  packaged now. And the app exe itself was never stamped, because disabling
  `signAndEditExecutable` - done to dodge a code-signing bundle that cannot
  unpack without Windows symlink privileges - also disables the rcedit step
  that writes the icon. `tools/after-pack.js` now does that stamping, so the
  exe carries the icon and real version metadata. The installer and portable
  stubs always looked right because NSIS icons those separately, which is
  what made this easy to miss.

- **"Add to MultiTerm" now exists for saved sessions too.** The top-bar
  button of that name only ever acted on the quick-connect fields, so there
  was no way to add a session from the tree to the tab already on screen -
  every open made its own tab. The sidebar has its own Add to MultiTerm, and
  the toolbar is laid out in rows so no label wraps.
- **A second session to a device you are already on.** Selecting a connected
  session and adding it, or the duplicate button in a pane header, opens
  another independent session to the same box - htop in one pane, commands in
  the next. This always worked underneath; nothing in the UI reached it.
- **Merge into MultiTerm** collapses every open tab into one multi-pane tab,
  from the top bar or the tab right-click menu. Sessions keep running: only
  the tab holding them changes, so nothing reconnects and no scrollback is
  lost.

- **Session rows expand.** The marker beside a saved session used to be
  decoration; it is now a real expander showing what that session will
  actually do - host, port, transport, credentials, jump host, logging,
  highlight set, tags, notes, and the last probe result. Inherited values say
  which folder they came from, so a surprising setting leads straight to its
  source. Read-only: the editor is for changing things, this is for the far
  more common question of what something is set to.
- **"Open in grid" is now "Start MultiTerm"**, and "Split into tab" is
  "Add to MultiTerm". The default window is wider and the sidebar a little
  wider so both, and every other toolbar label, sit on one line; below that
  width the top bar scrolls instead of swallowing the buttons at its end.
- **Serial in quick connect picks a real port.** It offered Serial as a
  transport with nowhere to say which COM port, so it could never have
  worked. Choosing Serial now swaps the host and credential fields for a list
  of the machine's serial ports plus a baud rate, and the list re-reads when
  opened so a console cable plugged in after launch appears.

- **Tab labels carry session status.** A tab reports the worst state among
  its sessions - amber while connecting, red and italic once something is
  disconnected - so one dead pane in a six-pane grid is visible from the tab
  strip even when that tab is in the background.
- **The file browser moved into the sidebar.** It was a right-hand panel,
  which took its width from the terminals: on a smaller window the panes it
  was meant to complement became unusable. It is now a second sidebar tab
  beside the session tree, so the terminal area never changes size - the grid
  measures the same with Files open or closed. It follows the focused pane,
  and opens by itself the first time a focused device turns out to support
  SFTP or SCP (switchable in settings).
- **The sidebar can be dragged wider**, and the width is remembered. Panes
  re-measure on the drag and on window resize.

- **A missing username asks instead of failing.** SSH carries the username in
  the auth request, so an empty one cannot be resolved by the device later -
  it died with "Invalid username". Quick connect now asks for username and
  password before dialing, and a saved session whose credential profile has
  no username prompts for one and saves it to the profile. The password still
  never touches disk.
- **Right-click a tab** for Close, Close all but this tab, and Close tabs to
  the right. Anything that closes more than the tab under the cursor confirms
  first and says how many.
- **Press R in a disconnected pane to reconnect.** The pane says so when a
  session dies, and R dials the same target into the same grid slot - for
  reloading a switch and catching it as it comes back. Saved sessions
  re-resolve from the tree, so an edited host or profile is picked up.
- **The taskbar shows the app icon.** Windows picks taskbar icons by
  AppUserModelID, not by the window's icon, so a running app wore Electron's
  icon however the window was configured.

- **App icon.** A prompt chevron and cursor on a two-pane screen, in the
  suite's colors. `npm run icon` renders `build/icon.svg` through Electron
  and packs a seven-size .ico with no image dependency; sizes at or below
  32px come from a separate simplified drawing rather than a downscale,
  because the pane divider and output lines turn to mush down there.
- **The portable exe wears the app icon too.** It is a self-extracting stub,
  so by default it looked like an installer rather than like the app someone
  is about to run.

- **CSV import and export.** Import always previews first: one row per line
  with the exact field changes, and nothing is written until Apply. Devices
  are matched by name, not host - the common amendment is a changed IP, and
  matching on host would duplicate the device that moved instead of updating
  it. A blank cell leaves a field alone, so a partial file of names and new
  IPs is safe. No name match but exactly one host match is offered as a
  rename rather than silently added. Import never deletes.
- **Device audit.** Probes the selected folder by TCP connect and marks what
  did not answer: green for a usable port, amber for refused (something is at
  that address but not this service - usually a reassigned IP), red for
  silence. Gentle by design - eight at a time with a retry before anything is
  flagged, because a fast sweep of hundreds of devices reads as a port scan.
  Flagged devices can be selected in one click; deleting stays a human
  decision.
- **Diff.** Compare the last command output of two panes, or paste two
  captures into a blank one. Side by side keeps columns aligned (network
  output is columnar); inline is a toggle. Trailing whitespace is ignored by
  default and a strip regex kills volatile fields like uptime counters. The
  prompt heuristic pre-fills the panes and they stay editable, because a
  capture heuristic that is treated as ground truth is one that loses trust.
- **SCP fallback for gear without SFTP.** Devices with `ip scp server enable`
  and no SFTP subsystem now work in the file panel: it detects the missing
  subsystem, probes for SCP, and switches to a transfer form. SCP cannot list
  directories, so the panel says so rather than showing a misleading empty
  folder. Device error text is surfaced verbatim - "No such file" is what
  tells someone they typed flash: instead of bootflash:.

- **The terminal surface is themeable.** Settings offers "Follow the app
  theme" (the default - a light chrome no longer frames a near-black
  terminal), "Always dark", or a custom color. Following the theme derives
  background, foreground, cursor and selection from the active palette's
  `--se-*` values, and live sessions re-color on the spot when the theme
  changes.
- **Highlight colors stay legible on light backgrounds.** Rule colors are
  authored against a dark terminal, so they are contrast-corrected at paint
  time against whatever background is in use - hue preserved, so green still
  reads as green. The stored rule is never modified: correction is display
  only, and a rule that already has its own background is left alone.
- **Blink alternates styled and plain instead of fading.** Fading to 25%
  opacity composites against whatever is behind it: fine over near-black, but
  over a light theme `err-disabled` washed out to unreadable pink. It now
  behaves like a real terminal blink attribute, with the plain text showing
  through on the off beat.

- **Eleven more shipped highlight rules**, all editable: duplex (full green,
  half red), interface speeds (10M/100M amber because a gig port at 100M is
  usually a finding, 1G and above cyan), interface names in short and long
  form (Gi1/0/1, Twe1/1/3, Loopback0, Port-channel10, GigabitEthernet1/0/1),
  transceiver reach (single-mode yellow, multi-mode aqua - both the SM/MM
  tokens and the LR/SR/LX/SX optic codes that imply them), and MAC and IP
  addresses in purple (Cisco dotted, colon and dash MACs, IPv4 with prefix
  length, IPv6 including :: compression).
- **Interface names require their number.** `Vlan120` and `Loopback0` color;
  the bare words do not, so the `Vlan` column header in `show int status` and
  prose in a login banner are left alone.
- **New rules reach existing installs without touching your edits.** The
  shipped set carries a seed version; a newer batch is appended once, below
  any rule you have ordered, and rules you deleted from an older seed are
  not resurrected. Corrections to an already-seeded rule apply only when it
  still carries exactly the shipped pattern - once you edit a rule it is
  yours, and an update leaves it alone.
- **IPv6 highlighting deliberately ignores log timestamps.** A pattern loose
  enough for `fe80::1` also matches `23:17:12`, which would paint every clock
  in syslog output purple; the rule now needs either a `::` or four-plus
  groups. Both behaviors are pinned by tests.

- **First feature-complete v1 build.** SSH / Telnet / Serial sessions in a
  dynamic N-pane grid with tabs; multi-exec broadcast with paste
  confirmation; context highlighting with editable, ordered rules and a
  shipped network-default set (err-disabled flashes); session tree with
  folder-defaults inheritance and tri-state bulk edit; credential profiles
  (DPAPI-saved or prompt-and-cache) referenced by name so shared files carry
  no usernames; per-batch canary connects and trip-on-first-auth-failure to
  protect rotating AD accounts; chainable pooled jump hosts; TOFU host keys
  with mismatch hard-block; per-session logging (text or raw); SFTP browser
  over the session's own connection; team file sync with three-way
  approve/merge and locked publish; manual export/import; MobaXTerm
  .mxtsessions migration wizard; both mouse modes; portable and installer
  packaging.
- **Renderer background throttling disabled.** Chromium clamps timers in
  occluded windows to 1 Hz, which strangled xterm's write scheduler to
  ~300 KB/s for minimized windows - a terminal must keep parsing, acking
  flow-control credit, and feeding logs while covered.
- **Decoration positioning bug fixed during development.** Assigning
  className inside a decoration's onRender wiped xterm's own positioning
  class, dropping every highlight overlay into static flow at the container
  bottom. Symptom: highlighted words rendering stacked below the terminal.
