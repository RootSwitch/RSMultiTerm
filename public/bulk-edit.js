'use strict';
// Multi-select bulk edit with tri-state fields: keep / set a value / clear to
// inherit. "Clear to inherit" is deliberately prominent - stamping explicit
// values across sessions is the baked-username disease generalized, and the
// folder-default mechanism is usually the better fix.

(function () {
    const { open, row, select, input } = window.Modals;

    const KEEP = '__keep__';
    const CLEAR = '__clear__';

    async function openDialog(sessionIds, nodes) {
        const profiles = await rsterm.invoke('rs:profiles.list');

        const body = document.createElement('div');
        const intro = document.createElement('p');
        intro.style.cssText = 'margin-bottom:10px;color:var(--se-txt-dim)';
        intro.textContent = `Editing ${sessionIds.length} sessions. ` +
            'Fields left on "keep" are untouched; "clear to inherit" removes the ' +
            'per-session override so folder defaults apply.';
        body.appendChild(intro);

        const triState = (extraOptions) => select([
            { value: KEEP, label: 'keep' },
            { value: CLEAR, label: 'clear to inherit' },
            ...extraOptions,
        ], KEEP);

        const fProfile = triState(profiles.map((p) => ({ value: 'v:' + p.name, label: 'set: ' + p.name })));
        const fTransport = triState([
            { value: 'v:ssh', label: 'set: SSH' },
            { value: 'v:telnet', label: 'set: Telnet' },
        ]);
        const fPortMode = triState([{ value: 'v', label: 'set to:' }]);
        const fPort = input('', 'port', 'number');
        fPort.style.width = '80px';
        const portRow = document.createElement('div');
        portRow.className = 'field-row';
        const portLabel = document.createElement('label');
        portLabel.textContent = 'Port';
        portRow.append(portLabel, fPortMode, fPort);

        const jumpSessions = Object.values(nodes).filter((n) => n.type === 'session');
        const fJump = triState(jumpSessions.map((n) => ({ value: 'v:' + n.id, label: 'set: via ' + n.name })));

        body.append(
            row('Credentials', fProfile),
            row('Transport', fTransport),
            portRow,
            row('Jump host', fJump));

        const val = (f) => {
            if (f.value === KEEP) return undefined;
            if (f.value === CLEAR) return null;
            return f.value.slice(2);
        };

        open(`Bulk edit ${sessionIds.length} sessions`, body, [
            { label: 'Cancel' },
            {
                label: 'Apply', primary: true,
                onClick: () => {
                    const patch = {
                        credentialProfile: val(fProfile),
                        transport: val(fTransport),
                        jumpHost: val(fJump),
                        port: fPortMode.value === 'v' ? (Number(fPort.value) || null) : val(fPortMode),
                    };
                    rsterm.invoke('rs:tree.bulkEdit', { ids: sessionIds, patch });
                },
            },
        ]);
    }

    window.BulkEdit = { openDialog };
})();
