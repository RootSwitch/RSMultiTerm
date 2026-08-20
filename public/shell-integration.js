'use strict';
// Shell integration installer: gets a remote Linux shell emitting OSC 133
// marks, which is what turns on prompt navigation, copy-last-command-output
// and the red marker on failed commands for that host.
//
// Three ways to apply it, in increasing order of commitment:
//
//   This session only  types the snippet into the running shell. Nothing on
//                      disk, gone at logout - the honest default for a box
//                      that is not yours.
//   Install            writes ~/.rsmultiterm-shell-integration.sh and adds
//                      one guarded source line to the rc file.
//   Copy               puts the snippet on the clipboard, for people who
//                      push dotfiles with Ansible rather than by typing.
//
// Everything is shown before it is sent, and it only ever goes to the ONE
// focused pane - never the broadcast. Typing an rc-file heredoc into six
// switches at once is precisely the accident this app exists to prevent.

(function () {
    const { open, row, select } = window.Modals;

    function focusedPane() {
        const tab = window.Tabs.active();
        const sid = tab && tab.focusedSessionId;
        return sid ? window.TermPanes.panes.get(sid) : null;
    }

    // Does this pane already speak OSC 133? The pane records a command the
    // moment a prompt-start mark arrives, so any recorded command with an
    // output mark means the far end is already integrated.
    function alreadyActive(pane) {
        return !!(pane && pane.commands && pane.commands.some((c) => c.output));
    }

    function sendToPane(pane, text) {
        // Deliberately not MultiExec.routeInput: this is a single-target
        // action by definition.
        if (!pane.port) return;
        const payload = text.split(/\r?\n/).join('\r') + '\r';
        pane.port.postMessage({ t: 'stdin', data: payload });
    }

    function preview(text) {
        const pre = document.createElement('pre');
        pre.style.cssText = 'font-family:var(--mt-mono);font-size:11px;max-height:34vh;' +
            'overflow:auto;background:var(--se-input);border:1px solid var(--se-border);' +
            'border-radius:4px;padding:8px;white-space:pre-wrap;';
        pre.textContent = text;
        return pre;
    }

    async function openDialog() {
        const pane = focusedPane();
        if (!pane) {
            window.Forms.showBanner('warn', 'Focus a session first - shell integration installs into one.');
            return;
        }
        if (window.TermPanes.isDead(pane.sessionId)) {
            window.Forms.showBanner('warn', 'That session is disconnected.');
            return;
        }

        let scripts = await rsterm.invoke('rs:shell.scripts', { shell: 'bash' });

        const body = document.createElement('div');
        body.style.minWidth = '580px';

        const intro = document.createElement('p');
        intro.style.cssText = 'margin-bottom:8px;color:var(--se-txt-dim);font-size:12px;';
        intro.textContent = alreadyActive(pane)
            ? `${pane.title} is already emitting prompt marks - prompt navigation and ` +
              'copy-last-output work here. Re-applying is harmless.'
            : `Teaches the shell on ${pane.title} to mark where each command starts and ` +
              'ends, which turns on Ctrl+Alt+Up/Down prompt navigation, "copy last ' +
              'command output", and a red marker on commands that fail. Network gear ' +
              '(IOS, JunOS) has no shell to install into - this is for Linux and BSD hosts.';
        body.appendChild(intro);

        const shellPick = select(
            scripts.shells.map((s) => ({ value: s, label: s })), 'bash');
        body.appendChild(row('Shell', shellPick));

        const where = document.createElement('p');
        where.style.cssText = 'margin:4px 0 8px;color:var(--se-txt-dim);font-size:11px;';
        const pre = preview('');
        const label = document.createElement('div');
        label.style.cssText = 'font-size:11px;color:var(--se-txt-dim);margin-bottom:4px;';

        let mode = 'session';
        const modePick = select([
            { value: 'session', label: 'This session only (nothing written to disk)' },
            { value: 'install', label: 'Install: write the file and source it from the rc file' },
            { value: 'uninstall', label: 'Uninstall: remove the file and the rc line' },
        ], 'session');
        body.appendChild(row('Apply', modePick));
        body.append(where, label, pre);

        const sync = () => {
            const text = mode === 'session' ? scripts.session
                : mode === 'install' ? scripts.install : scripts.uninstall;
            pre.textContent = text;
            where.textContent = mode === 'session'
                ? 'Applies to the shell running in this pane right now. Logging out undoes it.'
                : mode === 'install'
                    ? `Writes ${scripts.file} and adds one guarded line to ${scripts.rc}, then sources it. Running it twice does not duplicate the line.`
                    : `Deletes ${scripts.file} and strips the line from ${scripts.rc}. Open shells keep the marks until they exit.`;
            label.textContent = `Will be typed into ${pane.title}:`;
        };
        modePick.addEventListener('change', () => { mode = modePick.value; sync(); });
        shellPick.addEventListener('change', async () => {
            scripts = await rsterm.invoke('rs:shell.scripts', { shell: shellPick.value });
            sync();
        });
        sync();

        open('Shell integration', body, [
            { label: 'Cancel' },
            {
                label: 'Copy snippet',
                onClick: () => {
                    navigator.clipboard.writeText(scripts.session).then(
                        () => window.Forms.showBanner('warn', 'Snippet copied - drop it in your dotfiles or push it with your config management.'),
                        () => window.Forms.showBanner('error', 'Clipboard write blocked.'));
                    return false;
                },
            },
            {
                label: 'Send', primary: true,
                onClick: () => {
                    const live = focusedPane();
                    if (!live || live.sessionId !== pane.sessionId) {
                        window.Forms.showBanner('warn', 'The focused pane changed - nothing was sent.');
                        return;
                    }
                    sendToPane(pane, pre.textContent);
                    window.Forms.showBanner('warn',
                        mode === 'uninstall'
                            ? `Removal sent to ${pane.title}.`
                            : `Shell integration sent to ${pane.title}. Run a command to see it take effect.`);
                },
            },
        ]);
    }

    window.ShellIntegration = { openDialog };
})();
