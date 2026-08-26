'use strict';
// Snippets: the command manager. A snippet is a named command sequence with
// {{param}} placeholders filled in at send time. Sending follows the
// broadcast discipline exactly: with broadcast on, a snippet ALWAYS
// confirms before touching more than one device - it ends in a carriage
// return, so unlike a paste there is no "I can still not press Enter"
// safety margin.

(function () {
    const { open, row, stacked, input } = window.Modals;

    let snippets = [];

    function load() {
        return rsterm.invoke('rs:snippets.get').then((s) => { snippets = s || []; });
    }
    load();
    rsterm.on('rs:evt.snippets-changed', load);

    const PARAM_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

    function paramsOf(command) {
        const out = [];
        let m;
        PARAM_RE.lastIndex = 0;
        while ((m = PARAM_RE.exec(command)) !== null) {
            if (!out.includes(m[1])) out.push(m[1]);
        }
        return out;
    }

    // --- sending ----------------------------------------------------------
    function send(text) {
        const tab = window.Tabs.active();
        const sid = tab && tab.focusedSessionId;
        if (!sid || !window.TermPanes.panes.has(sid)) {
            window.Forms.showBanner('warn', 'No focused session to send to.');
            return;
        }
        if (window.TermPanes.isDead(sid)) {
            window.Forms.showBanner('warn', 'The focused session is disconnected.');
            return;
        }
        const targets = window.MultiExec.routeInput(sid);
        const lines = text.split(/\r?\n/);
        const deliver = () => {
            // Snippets execute on send: paste payload (bracketed when the
            // remote asks) plus the accept-line, built per target pane.
            for (const t of targets) {
                const p = window.TermPanes.panes.get(t);
                if (p && p.port) {
                    p.port.postMessage({ t: 'stdin', data: window.Paste.execForTerm(p.term, text) });
                }
            }
        };
        // Stricter than paste on purpose: ANY multi-target snippet confirms,
        // single-line included, because a snippet executes on arrival.
        if (targets.length > 1) {
            window.MultiExec.confirmBroadcastPaste(text, lines.length, targets.length, deliver);
        } else {
            deliver();
        }
    }

    function run(snippet) {
        const params = paramsOf(snippet.command);
        if (!params.length) return send(snippet.command);

        const body = document.createElement('div');
        const fields = new Map();
        for (const p of params) {
            const f = input('', p);
            fields.set(p, f);
            body.appendChild(row(p, f));
        }
        const fill = () => {
            let text = snippet.command;
            for (const [p, f] of fields) {
                // A function, not a string: a parameter containing $& or $'
                // is a value the user typed, not a replacement pattern, and
                // the string form silently expanded it into the command.
                text = text.replace(new RegExp(`\\{\\{\\s*${p}\\s*\\}\\}`, 'g'),
                    () => f.value.trim());
            }
            return text;
        };
        open(snippet.name, body, [
            { label: 'Cancel' },
            {
                label: 'Send', primary: true,
                onClick: () => {
                    if ([...fields.values()].some((f) => !f.value.trim())) return false;
                    send(fill());
                },
            },
        ]);
        const first = fields.values().next().value;
        if (first) first.focus();
    }

    // --- manager ----------------------------------------------------------
    function openManager() {
        const body = document.createElement('div');
        body.style.minWidth = '520px';

        const hint = document.createElement('p');
        hint.style.cssText = 'margin-bottom:8px;color:var(--se-txt-dim);font-size:12px;';
        hint.textContent = 'Write {{name}} anywhere in a command and it is asked for at ' +
            'send time. Snippets travel to the team through the team file; ' +
            'sending to a broadcast always confirms first.';
        body.appendChild(hint);

        const list = document.createElement('div');
        list.style.cssText = 'max-height:50vh;overflow-y:auto;';
        body.appendChild(list);

        const renderList = () => {
            list.replaceChildren();
            if (!snippets.length) {
                const empty = document.createElement('p');
                empty.style.color = 'var(--se-txt-dim)';
                empty.textContent = 'No snippets yet.';
                list.appendChild(empty);
                return;
            }
            for (const s of snippets) {
                const line = document.createElement('div');
                line.className = 'merge-row';
                const label = document.createElement('span');
                label.style.flex = '1';
                label.textContent = s.name;
                label.title = s.command + (s.notes ? `\n\n${s.notes}` : '');
                const act = (txt, fn, title) => {
                    const b = document.createElement('button');
                    b.textContent = txt;
                    if (title) b.title = title;
                    b.addEventListener('click', fn);
                    return b;
                };
                line.append(label,
                    act('Send', () => run(s), 'Fill parameters (if any) and send to the focused pane / broadcast'),
                    act('Edit', () => editDialog(s, renderList)),
                    act('Delete', () => {
                        snippets = snippets.filter((x) => x.id !== s.id);
                        persist().then(renderList);
                    }));
                list.appendChild(line);
            }
        };
        renderList();

        open('Snippets', body, [
            { label: 'Close', primary: true },
            { label: 'New Snippet', onClick: () => { editDialog(null, renderList); return false; } },
        ]);
    }

    function editDialog(existing, onDone) {
        const body = document.createElement('div');
        const name = input(existing ? existing.name : '', 'Bounce interface {{interface}}');
        // Commands are the point of this dialog, so they get the room. The
        // first version put the textarea in a normal label-beside-field row
        // inside a dialog that sized itself to its content: about forty
        // columns, which wrapped every real command and made the box look
        // like it could not be made bigger at all. It stacks now, opens wide
        // enough for a long command line, and says that it drags.
        const cmd = document.createElement('textarea');
        cmd.rows = 10;
        cmd.className = 'grow-box';
        cmd.value = existing ? existing.command : '';
        cmd.placeholder = 'configure terminal\ninterface {{interface}}\n...';
        const notes = input(existing ? existing.notes || '' : '', 'optional notes');
        body.style.minWidth = 'min(760px, 80vw)';
        body.append(row('Name', name), stacked('Command', cmd,
            'One command per line. Drag the bottom-right corner to make this taller.'),
        row('Notes', notes));

        open(existing ? 'Edit snippet' : 'New snippet', body, [
            { label: 'Cancel' },
            {
                label: 'Save', primary: true,
                onClick: () => {
                    if (!name.value.trim() || !cmd.value.trim()) return false;
                    const s = {
                        id: existing ? existing.id
                            : 'snip-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                        name: name.value.trim(),
                        command: cmd.value,
                        notes: notes.value.trim(),
                    };
                    if (existing) snippets = snippets.map((x) => (x.id === s.id ? s : x));
                    else snippets = snippets.concat([s]);
                    persist().then(onDone);
                },
            },
        ]);
        name.focus();
    }

    function persist() {
        return rsterm.invoke('rs:snippets.save', { snippets }).catch((err) => {
            window.Forms.showBanner('error', `Snippets: ${err.message}`);
        });
    }

    window.Snippets = { openManager, run, all: () => snippets };
})();
