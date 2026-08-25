'use strict';
// Editors and auth dialogs: session editor, folder editor, credential profile
// manager, the prompt-mode password dialog, and host key trust prompts.
// Inherited fields show their effective value greyed in the placeholder
// ("inherit - 22 from Core - HQ") so inheritance is visible, not mysterious.

(function () {
    const { open, row, input, select } = window.Modals;

    // --- session editor ---------------------------------------------------
    async function editSession(node, parentId) {
        const isNew = !node;
        node = node || { type: 'session', parentId: parentId || null, name: '', host: '' };

        const profiles = await rsterm.invoke('rs:profiles.list');
        const nodes = await rsterm.invoke('rs:tree.get');
        const eff = !isNew ? await rsterm.invoke('rs:tree.effective', { id: node.id }) : null;

        const inheritLabel = (field, fallback) => {
            if (!eff || !eff[field] || eff[field].value === null || eff[field].from === null) {
                return `inherit${fallback ? ' - ' + fallback : ''}`;
            }
            return `inherit - ${eff[field].value} from ${eff[field].from}`;
        };

        const body = document.createElement('div');
        const fName = input(node.name, 'core-sw-01');
        const fHost = input(node.host, 'hostname or IP');
        const fTransport = select([
            { value: '', label: inheritLabel('transport', 'ssh') },
            { value: 'ssh', label: 'SSH' },
            { value: 'telnet', label: 'Telnet' },
            { value: 'serial', label: 'Serial' },
        ], node.transport || '');
        const fPort = input(node.port, inheritLabel('port', 'by transport'), 'number');
        const profileOpts = [{ value: '', label: inheritLabel('credentialProfile', 'none') }]
            .concat(profiles.map((p) => ({ value: p.name, label: p.name })));
        const fProfile = select(profileOpts, node.credentialProfile || '');
        offerNewProfile(fProfile);
        const sessionOpts = [{ value: '', label: inheritLabel('jumpHost', 'none') },
            { value: '-', label: 'none (override inherit)' }]
            .concat(Object.values(nodes)
                .filter((n) => n.type === 'session' && n.id !== node.id)
                .map((n) => ({ value: n.id, label: n.name })));
        const fJump = select(sessionOpts, node.jumpHost === null ? '' : (node.jumpHost || ''));
        const fNotes = input(node.notes, 'notes');

        // Logging is inheritable like port and credentials, but its value
        // can be a bool OR a config object, so the inherit label is built
        // by hand rather than through inheritLabel's stringify.
        const loggingWord = (v) => (v === false || (v && v.enabled === false)) ? 'off' : 'on';
        const effLog = eff && eff.logging;
        const logInherit = !effLog || effLog.from === null
            ? 'inherit - on (app default)'
            : `inherit - ${loggingWord(effLog.value)} from ${effLog.from}`;
        const fLogging = select([
            { value: '', label: logInherit },
            { value: 'on', label: 'Log this session to a file' },
            { value: 'off', label: 'No log for this session' },
        ], node.logging === true ? 'on' : node.logging === false ? 'off' : '');

        // Serial parameters appear only for serial transport.
        const s = node.serial || {};
        const fDevice = select([{ value: '', label: 'select COM port...' }], s.device || '');
        rsterm.invoke('rs:serial.listPorts').then((ports) => {
            for (const p of ports) {
                const o = document.createElement('option');
                o.value = p.path;
                o.textContent = `${p.path} - ${p.friendlyName}`;
                fDevice.appendChild(o);
            }
            if (s.device) fDevice.value = s.device;
        });
        // The shared list, plus the stored value if it is not on it (a
        // hand-edited sessions file, a future rate): a select that cannot
        // SHOW the current value silently rewrites it on save.
        const bauds = ((window.App && window.App.BAUDS) ||
            [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200]).map(String);
        const current = String(s.baud || 9600);
        if (!bauds.includes(current)) bauds.push(current);
        const fBaud = select(bauds.map((b) => ({ value: b, label: b })), current);
        const serialRows = document.createElement('div');
        serialRows.append(row('COM port', fDevice), row('Baud', fBaud));

        const syncSerial = () => {
            serialRows.style.display = fTransport.value === 'serial' ? '' : 'none';
        };
        fTransport.addEventListener('change', syncSerial);

        body.append(
            row('Name', fName), row('Host', fHost), row('Transport', fTransport),
            row('Port', fPort), row('Credentials', fProfile), row('Jump host', fJump),
            row('Logging', fLogging),
            serialRows, row('Notes', fNotes));
        syncSerial();

        open(isNew ? 'New session' : `Edit ${node.name}`, body, [
            { label: 'Cancel' },
            {
                label: 'Save', primary: true,
                onClick: () => {
                    if (!fName.value.trim()) { fName.focus(); return false; }
                    const jump = fJump.value === '' ? null : (fJump.value === '-' ? null : fJump.value);
                    rsterm.invoke('rs:tree.upsert', {
                        ...node,
                        name: fName.value.trim(),
                        host: fHost.value.trim(),
                        transport: fTransport.value || null,
                        port: fPort.value ? Number(fPort.value) : null,
                        credentialProfile: fProfile.value || null,
                        jumpHost: jump,
                        serial: fTransport.value === 'serial'
                            ? { device: fDevice.value, baud: Number(fBaud.value) } : node.serial || null,
                        logging: fLogging.value === '' ? null : fLogging.value === 'on',
                        notes: fNotes.value,
                    });
                },
            },
        ]);
        fName.focus();
    }

    // --- folder editor ----------------------------------------------------
    async function editFolder(node, parentId) {
        const isNew = !node;
        node = node || { type: 'folder', parentId: parentId || null, name: '', defaults: {} };
        const d = node.defaults || {};
        const profiles = await rsterm.invoke('rs:profiles.list');

        const body = document.createElement('div');
        const fName = input(node.name, 'Core - HQ');
        const fProfile = select([{ value: '', label: 'no default' }]
            .concat(profiles.map((p) => ({ value: p.name, label: p.name }))), d.credentialProfile || '');
        offerNewProfile(fProfile);
        const fPort = input(d.port, 'no default', 'number');
        const fLogging = select([
            { value: '', label: 'inherit' },
            { value: 'on', label: 'Log sessions in this folder' },
            { value: 'off', label: 'No logs for this folder' },
        ], d.logging === true ? 'on' : d.logging === false ? 'off' : '');
        body.append(row('Name', fName),
            row('Default credentials', fProfile),
            row('Default port', fPort),
            row('Logging', fLogging));

        open(isNew ? 'New folder' : `Edit ${node.name}`, body, [
            { label: 'Cancel' },
            {
                label: 'Save', primary: true,
                onClick: () => {
                    if (!fName.value.trim()) { fName.focus(); return false; }
                    rsterm.invoke('rs:tree.upsert', {
                        ...node,
                        name: fName.value.trim(),
                        defaults: {
                            ...d,
                            credentialProfile: fProfile.value || null,
                            port: fPort.value ? Number(fPort.value) : null,
                            logging: fLogging.value === '' ? null : fLogging.value === 'on',
                        },
                    });
                },
            },
        ]);
        fName.focus();
    }

    // "Create a new profile..." as the last entry of a credentials dropdown.
    // Choosing it opens the profile editor on top of the current dialog; on
    // save the new profile is added to the list and selected, on cancel the
    // dropdown is back where it was. The select never rests on the sentinel
    // itself, so a form saved mid-flow cannot store '__new__' as a profile.
    const NEW_PROFILE = '__new__';
    function offerNewProfile(sel) {
        const o = document.createElement('option');
        o.value = NEW_PROFILE;
        o.textContent = 'Create a new profile...';
        sel.appendChild(o);
        let previous = sel.value;
        sel.addEventListener('change', () => {
            if (sel.value !== NEW_PROFILE) { previous = sel.value; return; }
            sel.value = previous;
            editProfile(null, (created) => {
                if (!created || !created.name) return;
                if (![...sel.options].some((x) => x.value === created.name)) {
                    const added = document.createElement('option');
                    added.value = created.name;
                    added.textContent = created.name;
                    sel.insertBefore(added, o);
                }
                sel.value = created.name;
                previous = created.name;
            });
        });
    }

    // --- credential profile manager --------------------------------------
    async function manageProfiles() {
        const body = document.createElement('div');
        const listEl = document.createElement('div');
        body.appendChild(listEl);

        const refresh = async () => {
            const profiles = await rsterm.invoke('rs:profiles.list');
            listEl.replaceChildren();
            if (!profiles.length) {
                const p = document.createElement('p');
                p.style.color = 'var(--se-txt-dim)';
                p.textContent = 'No profiles yet. Sessions reference profiles by name ' +
                    '("AD Account"), so shared session files never contain usernames.';
                listEl.appendChild(p);
            }
            for (const prof of profiles) {
                const rowEl = document.createElement('div');
                rowEl.className = 'field-row';
                const label = document.createElement('span');
                label.style.flex = '1';
                const how = prof.authMethod === 'agent' ? 'SSH agent'
                    : (prof.authMethod === 'key' || prof.authMethod === 'keyfile')
                        ? `key${prof.hasKeyPassphrase ? ', passphrase saved' : ''}`
                        : prof.storage === 'dpapi'
                            ? (prof.hasSecret ? 'password saved' : 'password: save on next edit')
                            : 'asks at connect';
                label.textContent = `${prof.name} (${prof.username || 'no username'}, ${how}` +
                    `${prof.cached ? ', cached' : ''})`;
                const edit = document.createElement('button');
                edit.textContent = 'Edit';
                edit.addEventListener('click', () => editProfile(prof, refresh));
                const del = document.createElement('button');
                del.textContent = 'Delete';
                del.addEventListener('click', async () => {
                    await rsterm.invoke('rs:profiles.delete', { name: prof.name });
                    refresh();
                });
                rowEl.append(label, edit, del);
                listEl.appendChild(rowEl);
            }
        };
        await refresh();

        open('Credential profiles', body, [
            // `refresh`, not a no-op: the list sat unchanged after a save, and
            // a user staring at it could not tell whether the profile took.
            { label: 'New profile', onClick: () => { editProfile(null, refresh); return false; } },
            { label: 'Close', primary: true },
        ]);
    }

    async function editProfile(prof, done) {
        const isNew = !prof;
        // What this machine can offer decides the default: a lab box with
        // a key in ~/.ssh should not be asked to invent a password.
        const env = await rsterm.invoke('rs:keys.discover');
        // Where a secret would actually go on this machine (Windows
        // sign-in, macOS Keychain, a Linux keyring) - and whether that is
        // trustworthy at all. On Linux with no keyring the fallback
        // "encrypts" with a hardcoded key, so the save options are withheld
        // rather than offered as a lie. Read once, above both the
        // key-passphrase and password sections that label themselves from it.
        const secretStore = await rsterm.invoke('rs:secrets.storageInfo');
        const defaultMethod = isNew
            ? (env.agent.available ? 'agent' : (env.keys.length ? 'key' : 'password'))
            : null;
        prof = prof || { name: '', username: '', storage: 'prompt', authMethod: defaultMethod };
        const body = document.createElement('div');
        // A fixed width, or the dialog resizes itself every time a hint
        // paragraph changes length - it visibly jumped when the scope note
        // swapped between its two texts.
        body.style.width = 'min(560px, 85vw)';
        const fName = input(prof.name, 'lab-key');
        if (!isNew) fName.disabled = true;   // the name is the shared contract
        const fUser = input(prof.username, 'your username');

        // 'keyfile' is what older profiles.json call key auth.
        const method = (prof.authMethod === 'keyfile') ? 'key' : (prof.authMethod || 'password');
        const fMethod = select([
            { value: 'key', label: 'SSH key file' },
            { value: 'agent', label: 'SSH agent' + (env.agent.available ? ' - ' + env.agent.detail : '') },
            { value: 'password', label: 'Password' },
        ], method);

        // --- key file ------------------------------------------------------
        // Discovered keys first, so the common case is picking from a list
        // rather than typing a path. "Another file..." covers everything
        // else, and a path already on the profile is kept even if it lives
        // outside ~/.ssh.
        const keyOpts = env.keys.map((k) => ({
            value: k.path,
            label: `${k.name}${k.type ? ' (' + k.type + ')' : ''}${k.encrypted ? ' - passphrase' : ''}` +
                `${k.comment ? ' - ' + k.comment : ''}`,
        }));
        if (prof.keyPath && !keyOpts.some((o) => o.value === prof.keyPath)) {
            keyOpts.unshift({ value: prof.keyPath, label: prof.keyPath });
        }
        if (!keyOpts.length) {
            keyOpts.push({ value: '', label: `no keys found in ${env.sshDir}` });
        }
        keyOpts.push({ value: '__browse__', label: 'Another file...' });
        const fKey = select(keyOpts, prof.keyPath || keyOpts[0].value);
        const keyRow = row('Key file', fKey);
        const keyNote = document.createElement('p');
        keyNote.style.cssText = 'margin:2px 0 8px;color:var(--se-txt-dim);font-size:11px;';

        // The passphrase field only exists for a key that actually has one.
        const fKeyPass = input('', prof.hasKeyPassphrase ? '(unchanged)' : 'passphrase', 'password');
        const keyPassRow = row('Passphrase', fKeyPass);
        const keyStoreOpts = [{ value: 'prompt', label: 'Ask when I connect (memory only)' }];
        if (secretStore.available) {
            keyStoreOpts.push({ value: 'dpapi', label: `Save encrypted (${secretStore.label})` });
        }
        const fKeyStore = select(keyStoreOpts,
            (prof.hasKeyPassphrase && secretStore.available) ? 'dpapi' : 'prompt');
        const keyStoreRow = row('Passphrase storage', fKeyStore);

        let keyInfo = null;
        async function describeKey() {
            const p = fKey.value;
            if (!p || p === '__browse__') { keyInfo = null; keyNote.textContent = ''; return; }
            const known = env.keys.find((k) => k.path === p);
            keyInfo = known || await rsterm.invoke('rs:keys.inspect', { path: p });
            if (!keyInfo.ok) {
                keyNote.textContent = keyInfo.reason;
                keyNote.style.color = 'var(--se-down)';
            } else {
                keyNote.style.color = 'var(--se-txt-dim)';
                keyNote.textContent = keyInfo.encrypted
                    ? 'This key is protected by a passphrase.'
                    : `Unencrypted ${keyInfo.type || 'key'}` +
                      (keyInfo.comment ? ` (${keyInfo.comment})` : '') + '.';
            }
            syncRows();
        }
        fKey.addEventListener('change', async () => {
            if (fKey.value === '__browse__') {
                const picked = await rsterm.invoke('rs:keys.pick');
                if (!picked) { fKey.value = keyOpts[0].value; syncRows(); return; }
                const o = document.createElement('option');
                o.value = picked.path;
                o.textContent = picked.path;
                fKey.insertBefore(o, fKey.lastChild);
                fKey.value = picked.path;
            }
            describeKey();
        });

        // --- password ------------------------------------------------------
        const storeOpts = [
            { value: 'prompt', label: 'Prompt at connect (memory only) - rotating passwords' },
        ];
        if (secretStore.available) {
            storeOpts.push({ value: 'dpapi', label: `Save encrypted (${secretStore.label}) - lab use` });
        }
        const fStorage = select(storeOpts,
            (prof.storage === 'dpapi' && secretStore.available) ? 'dpapi' : 'prompt');
        const storeNote = document.createElement('p');
        storeNote.style.cssText = 'margin:2px 0 8px;color:var(--se-txt-dim);font-size:11px;';
        storeNote.textContent = secretStore.available ? ''
            : `Saving passwords is unavailable: ${secretStore.why}. Prompt mode keeps them in ` +
              'memory for this run instead.';
        const fPass = input('', prof.storage === 'dpapi' && prof.hasSecret
            ? '(unchanged)' : 'password to save', 'password');
        const passRow = row('Password', fPass);
        const storageRow = row('Storage', fStorage);

        const agentNote = document.createElement('p');
        agentNote.style.cssText = 'margin:2px 0 8px;color:var(--se-txt-dim);font-size:11px;';
        agentNote.textContent = env.agent.available
            ? `Your agent (${env.agent.detail}) holds the key and signs for it - this app never ` +
              'sees key material, and there is nothing to store here.'
            : `No agent detected (${env.agent.detail}). Pageant is still tried when you connect, ` +
              'so this works if you start it later.';

        function syncRows() {
            const m = fMethod.value;
            const showKey = m === 'key';
            keyRow.style.display = showKey ? '' : 'none';
            keyNote.style.display = showKey ? '' : 'none';
            const wantsPass = showKey && !!(keyInfo && keyInfo.ok && keyInfo.encrypted);
            keyPassRow.style.display = wantsPass ? '' : 'none';
            keyStoreRow.style.display = wantsPass && fKeyStore.value === 'dpapi' ? '' : 'none';
            if (wantsPass) keyStoreRow.style.display = '';
            agentNote.style.display = m === 'agent' ? '' : 'none';
            storageRow.style.display = m === 'password' ? '' : 'none';
            storeNote.style.display = m === 'password' && storeNote.textContent ? '' : 'none';
            passRow.style.display = m === 'password' && fStorage.value === 'dpapi' ? '' : 'none';
        }
        fMethod.addEventListener('change', syncRows);
        fStorage.addEventListener('change', syncRows);
        fKeyStore.addEventListener('change', syncRows);

        // Which hosts this credential may be sent to. Main enforces it
        // before decrypting anything, so it holds even if this window is
        // not the one asking - and it stops the everyday mistake of
        // picking the wrong profile for someone else's device.
        const fScope = input((prof.hostScope || []).join(' '),
            '10.50.0.0/16  *.corp.local  10.50.1.7');
        const scopeNote = document.createElement('p');
        scopeNote.style.cssText = 'margin:2px 0 8px;color:var(--se-txt-dim);font-size:11px;';
        const syncScopeNote = () => {
            scopeNote.style.color = 'var(--se-txt-dim)';
            scopeNote.textContent = fScope.value.trim()
                ? "Matched against each session's HOST field - the address or DNS name " +
                  'you dial, never the display name. Refused anywhere else, before decryption.'
                : "Empty means no restriction. Patterns match the session's host field " +
                  '(IP or DNS name, not its display name): 10.50.0.0/16 ranges, ' +
                  '*.wildcards, exact addresses.';
        };
        fScope.addEventListener('input', syncScopeNote);
        syncScopeNote();

        body.append(row('Profile name', fName), row('Username', fUser),
            row('Authenticate with', fMethod),
            keyRow, keyNote, keyPassRow, keyStoreRow,
            agentNote,
            storageRow, storeNote, passRow,
            row('May be used with', fScope), scopeNote);
        await describeKey();
        syncRows();

        const m2 = open(isNew ? 'New credential profile' : `Edit ${prof.name}`, body, [
            { label: 'Cancel' },
            // Blank-means-keep is the field's contract, so forgetting a
            // stored secret needs its own button rather than a magic blank.
            ...(!isNew && prof.hasSecret ? [{
                label: 'Forget password',
                onClick: () => {
                    rsterm.invoke('rs:profiles.upsert', { name: prof.name, clearPassword: true }).then(done);
                },
            }] : []),
            {
                label: 'Save', primary: true,
                onClick: () => {
                    if (!fName.value.trim()) { fName.focus(); return false; }
                    const m = fMethod.value;
                    if (m === 'key') {
                        if (!fKey.value || fKey.value === '__browse__') {
                            keyNote.style.color = 'var(--se-down)';
                            keyNote.textContent = 'Choose a key file first.';
                            return false;
                        }
                        if (keyInfo && !keyInfo.ok) return false;   // reason already shown
                    }
                    const patch = {
                        name: fName.value.trim(),
                        username: fUser.value.trim(),
                        hostScope: fScope.value,
                        authMethod: m,
                        storage: m === 'password' ? fStorage.value : 'prompt',
                        keyPath: m === 'key' ? fKey.value : undefined,
                        password: m === 'password' ? (fPass.value || undefined) : undefined,
                    };
                    const wantsKeyPass = m === 'key' && keyInfo && keyInfo.encrypted &&
                        fKeyStore.value === 'dpapi' && fKeyPass.value;
                    // Verify before storing: a typo saved now is a failed
                    // connection later, reported at the far end where it
                    // looks like the device's fault.
                    const check = wantsKeyPass
                        ? rsterm.invoke('rs:keys.verifyPassphrase',
                            { path: fKey.value, passphrase: fKeyPass.value })
                        : Promise.resolve({ ok: true });
                    check.then((r) => {
                        if (!r.ok) {
                            keyNote.style.color = 'var(--se-down)';
                            keyNote.textContent = r.reason;
                            return;
                        }
                        if (wantsKeyPass) patch.keyPassphrase = fKeyPass.value;
                        if (m === 'key' && fKeyStore.value !== 'dpapi') patch.clearKeyPassphrase = true;
                        rsterm.invoke('rs:profiles.upsert', patch).then(() => {
                            done();
                            m2.close();
                        }, (err) => {
                            // A malformed host pattern is refused in main;
                            // say so next to the field rather than closing
                            // the dialog on a save that did not happen.
                            scopeNote.style.color = 'var(--se-down)';
                            scopeNote.textContent = err.message.replace(/^Error invoking.*?: /, '');
                        });
                    });
                    return false;   // closed by hand once the check passes
                },
            },
        ]);
        (isNew ? fName : fUser).focus();
    }

    // --- install a key on the device --------------------------------------
    // ssh-copy-id, from inside the session that is already open: you got in
    // with a password, one dialog later the key is in authorized_keys and
    // the password is history. The private key never leaves this machine -
    // main derives the public line and the engine appends it over this
    // session's existing connection.
    async function installKeyDialog(sessionId) {
        const pane = window.TermPanes.panes.get(sessionId);
        if (!pane || pane.transport !== 'ssh') {
            showBanner('warn', 'Keys can only be installed over an SSH session.');
            return;
        }
        const env = await rsterm.invoke('rs:keys.discover');
        const profiles = await rsterm.invoke('rs:profiles.list');
        // Discovered keys plus any profile key that lives outside ~/.ssh.
        const paths = new Map();
        for (const k of env.keys) paths.set(k.path, `${k.name}${k.type ? ' (' + k.type + ')' : ''}`);
        for (const p of profiles) {
            if (p.keyPath && !paths.has(p.keyPath)) paths.set(p.keyPath, p.keyPath);
        }
        if (!paths.size) {
            showBanner('warn', `No SSH keys found in ${env.sshDir}. Generate one with ` +
                'ssh-keygen, or create a key profile first.');
            return;
        }

        const body = document.createElement('div');
        const what = document.createElement('p');
        what.style.cssText = 'margin-bottom:10px;color:var(--se-txt-dim);font-size:12px;';
        what.textContent = `Adds the key's PUBLIC half to ~/.ssh/authorized_keys on ` +
            `'${pane.title}', over this session - like ssh-copy-id. The private key never ` +
            'leaves this PC. Works on Linux/Unix devices; network gear configures keys ' +
            'through its own CLI.';
        const fKey = select([...paths.entries()].map(([value, label]) => ({ value, label })),
            [...paths.keys()][0]);
        body.append(what, row('Key', fKey));

        open('Install SSH key on the device', body, [
            { label: 'Cancel' },
            {
                label: 'Install', primary: true,
                onClick: () => {
                    rsterm.invoke('rs:keys.install', { sessionId, keyPath: fKey.value })
                        .then((r) => {
                            showBanner('warn', r.alreadyInstalled
                                ? `That key is already in authorized_keys on '${pane.title}'.`
                                : `Key installed on '${pane.title}'. A profile using this key ` +
                                  'now signs in without a password.');
                        })
                        .catch((err) => showBanner('error', `Key install: ${err.message}`));
                },
            },
        ]);
    }

    // --- keep a quick connection ------------------------------------------
    // Quick connect is deliberately throwaway; this is the one click that
    // turns "I typed a host to look at something" into a saved session,
    // without retyping any of it.
    //
    // What is NOT carried over: the password. Quick connect takes one for a
    // single connection, and a saved session refers to credentials by
    // profile NAME - so this offers to make a profile carrying the
    // username, and the password is asked for next time. Saving a session
    // must not quietly turn a typed password into a stored secret.
    async function saveSessionDialog(sessionId) {
        const d = await rsterm.invoke('rs:session.describe', { sessionId });
        if (!d.savable) {
            showBanner('warn', d.reason || 'this session cannot be saved');
            return;
        }
        const a = d.args;
        const [profiles, nodes] = await Promise.all([
            rsterm.invoke('rs:profiles.list'),
            rsterm.invoke('rs:tree.get'),
        ]);

        const body = document.createElement('div');
        const what = document.createElement('p');
        what.style.cssText = 'margin-bottom:10px;color:var(--se-txt-dim);font-size:12px;';
        what.textContent = a.transport === 'serial'
            ? `${(a.serial || {}).device || 'serial port'} at ${(a.serial || {}).baud || 9600} baud`
            : `${a.transport.toUpperCase()} to ${a.host}${a.port ? ':' + a.port : ''}` +
              (a.username ? ` as ${a.username}` : '');
        body.appendChild(what);

        const defaultName = a.transport === 'serial'
            ? `${(a.serial || {}).device || 'serial'}`
            : (a.username ? `${a.username}@${a.host}` : a.host);
        const fName = input(defaultName, 'name for this session');

        // Folders only - a session cannot be saved inside another session.
        const folders = Object.values(nodes).filter((n) => n && n.type === 'folder');
        const pathOf = (n) => {
            const parts = [n.name];
            let p = n.parentId;
            const guard = new Set([n.id]);
            while (p && !guard.has(p)) {
                guard.add(p);
                const parent = nodes[p];
                if (!parent) break;
                parts.unshift(parent.name);
                p = parent.parentId;
            }
            return parts.join(' / ');
        };
        const folderOpts = [{ value: '', label: '(top level)' }]
            .concat(folders.map((f) => ({ value: f.id, label: pathOf(f) }))
                .sort((x, y) => x.label.localeCompare(y.label)));
        const selected = window.SessionTree.selectedFolder();
        const fFolder = select(folderOpts,
            selected && folderOpts.some((o) => o.value === selected) ? selected : '');

        // Credentials: an existing profile, a new one carrying this
        // username, or none (asked at connect time).
        const NEW = '__new__';
        const credOpts = [{ value: '', label: 'Ask me when I connect' }]
            .concat(profiles.map((p) => ({
                value: p.name,
                label: `${p.name}${p.username ? ' (' + p.username + ')' : ''}`,
            })));
        const suggested = a.username && !profiles.some((p) => p.name === a.username);
        if (suggested) {
            credOpts.push({ value: NEW, label: `Create profile "${a.username}"` });
        }
        const fCred = select(credOpts,
            a.username && profiles.some((p) => p.username === a.username)
                ? profiles.find((p) => p.username === a.username).name
                : (suggested ? NEW : ''));

        body.append(row('Name', fName), row('Folder', fFolder), row('Credentials', fCred));

        // Creating a profile from this connection can keep its password
        // too: it already opened the device (the session is on screen), so
        // the never-store-an-unproven-password rule is satisfied. Default
        // on - this is the home-lab convenience path - and plainly labeled.
        let fKeepPass = null;
        const keepRow = document.createElement('label');
        // Only offered when there is somewhere trustworthy to put it.
        if (d.hasPassword && d.storage && d.storage.available) {
            keepRow.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:12px;' +
                'color:var(--se-txt-dim);margin-top:8px;';
            fKeepPass = document.createElement('input');
            fKeepPass.type = 'checkbox';
            fKeepPass.checked = true;
            const span = document.createElement('span');
            span.textContent = 'Save the password from this connection with the profile ' +
                `(encrypted with ${(d.storage && d.storage.label) || 'OS encryption'})`;
            keepRow.append(fKeepPass, span);
            body.appendChild(keepRow);
        }
        const syncKeep = () => {
            keepRow.style.display = d.hasPassword && fCred.value === NEW ? '' : 'none';
        };
        fCred.addEventListener('change', syncKeep);
        syncKeep();

        open('Save as a session', body, [
            { label: 'Cancel' },
            {
                label: 'Save', primary: true,
                onClick: () => {
                    if (!fName.value.trim()) { fName.focus(); return false; }
                    rsterm.invoke('rs:session.saveAsNode', {
                        sessionId,
                        name: fName.value.trim(),
                        parentId: fFolder.value || null,
                        credentialProfile: fCred.value === NEW ? null : (fCred.value || null),
                        createProfileFor: fCred.value === NEW ? a.username : null,
                        savePassword: fCred.value === NEW && !!(fKeepPass && fKeepPass.checked),
                    }).then((res) => {
                        const pane = window.TermPanes.panes.get(sessionId);
                        if (pane) { pane.savable = false; pane.savedNodeId = res.nodeId; }
                        window.SessionTree.refresh();
                        window.Grid.render(true);   // drops the save button
                        showBanner('warn', `Saved '${res.name}' to your sessions` +
                            (res.profile ? ` using profile '${res.profile}'.` : '.'));
                    }).catch((err) => showBanner('error', `Save failed: ${err.message}`));
                },
            },
        ]);
        fName.focus();
        fName.select();
    }

    // --- prompt-mode password dialog --------------------------------------
    // One dialog per profile; every session parked behind it is released by
    // the single answer.
    const openPrompts = new Set();
    rsterm.on('rs:evt.needs-password', ({ profile, username, needUsername, host, kind, keyPath, canRemember, rememberLabel }) => {
        if (openPrompts.has(profile)) return;
        openPrompts.add(profile);
        // A key passphrase is not a password: it unlocks a file on THIS
        // machine and is never sent anywhere. Saying so is the difference
        // between a prompt people answer and a prompt people distrust.
        const isPassphrase = kind === 'passphrase';

        const body = document.createElement('div');
        const info = document.createElement('p');
        info.style.marginBottom = '10px';
        info.textContent = needUsername
            ? `Profile '${profile}' has no username yet` + (host ? ` (connecting to ${host})` : '') +
              '. The username is saved to the profile; the password stays in memory ' +
              'until the app closes and is never written to disk.'
            : isPassphrase
                ? `Unlock the SSH key for profile '${profile}'` +
                  (keyPath ? ` (${keyPath})` : '') +
                  '. The passphrase decrypts the key on this machine - it is never sent to ' +
                  'the device - and is kept in memory until the app closes.'
                : `Enter the password for profile '${profile}'` +
                  (username ? ` (${username})` : '') +
                  '. It is kept in memory until the app closes - never written to disk.';
        body.appendChild(info);

        const fUser = input(username || '', 'username');
        if (needUsername) body.appendChild(row('Username', fUser));
        const fPass = input('', isPassphrase ? 'passphrase' : 'password', 'password');
        body.appendChild(row(isPassphrase ? 'Passphrase' : 'Password', fPass));

        // The MobaXterm convenience, with two honesty rules attached: the
        // secret is encrypted with the Windows sign-in (so it is gated the
        // way the whole PC is), and it is only stored once it has WORKED -
        // a wrong password is never remembered.
        let fRemember = null;
        if (canRemember) {
            const lbl = document.createElement('label');
            lbl.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:12px;' +
                'color:var(--se-txt-dim);margin-top:8px;';
            fRemember = document.createElement('input');
            fRemember.type = 'checkbox';
            const span = document.createElement('span');
            span.textContent = `Remember this ${isPassphrase ? 'passphrase' : 'password'} on this PC ` +
                `(encrypted with ${rememberLabel || 'OS encryption'}, saved only if it works)`;
            lbl.append(fRemember, span);
            body.appendChild(lbl);
        }

        const finish = (cancelled) => {
            openPrompts.delete(profile);
            rsterm.send('rs:secrets.promptResult', {
                profile,
                username: cancelled ? undefined : fUser.value.trim(),
                password: cancelled ? undefined : fPass.value,
                remember: !cancelled && !!(fRemember && fRemember.checked),
                cancelled,
            });
        };
        const ready = () => (!needUsername || fUser.value.trim()) && fPass.value;
        const m = open(
            needUsername ? `Sign in - ${profile}`
                : isPassphrase ? `Key passphrase needed - ${profile}`
                    : `Password needed - ${profile}`, body, [
                { label: 'Cancel', onClick: () => finish(true) },
                {
                    label: 'Connect', primary: true,
                    onClick: () => {
                        if (!ready()) { (needUsername && !fUser.value.trim() ? fUser : fPass).focus(); return false; }
                        finish(false);
                    },
                },
            ], { modal: true, onCancel: () => finish(true) });
        for (const f of [fUser, fPass]) {
            f.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && ready()) {
                    m.close();
                    finish(false);
                }
            });
        }
        (needUsername && !username ? fUser : fPass).focus();
    });

    // Quick connect with no username: SSH has nowhere to put an empty one,
    // so ask before dialing rather than letting the handshake fail.
    // knownUser is set when we already know who the session was for - a
    // pane restored from a workspace snapshot keeps its username but never
    // its password, so the cursor belongs in the half that is missing.
    function askCredentials(host, knownUser) {
        return new Promise((resolve) => {
            const body = document.createElement('div');
            const info = document.createElement('p');
            info.style.marginBottom = '10px';
            info.textContent = knownUser
                ? `Enter the password for ${knownUser}@${host}. A restored session never ` +
                  'carries one - and nothing typed here is saved either.'
                : `SSH needs a username to connect to ${host}. ` +
                  'Nothing typed here is saved - use a credential profile for that.';
            const fUser = input(knownUser || '', 'username');
            const fPass = input('', 'password', 'password');
            body.append(info, row('Username', fUser), row('Password', fPass));

            let done = false;
            const finish = (value) => { if (!done) { done = true; resolve(value); } };
            const m = open(`Sign in to ${host}`, body, [
                { label: 'Cancel', onClick: () => finish(null) },
                {
                    label: 'Connect', primary: true,
                    onClick: () => {
                        if (!fUser.value.trim()) { fUser.focus(); return false; }
                        finish({ username: fUser.value.trim(), password: fPass.value });
                    },
                },
            ], { modal: true, onCancel: () => finish(null) });
            for (const f of [fUser, fPass]) {
                f.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && fUser.value.trim()) {
                        m.close();
                        finish({ username: fUser.value.trim(), password: fPass.value });
                    }
                });
            }
            (knownUser ? fPass : fUser).focus();
        });
    }

    // --- auth-blocked banner ----------------------------------------------
    rsterm.on('rs:evt.auth-blocked', ({ profile, halted }) => {
        showBanner('error',
            `Authentication failed for '${profile}'` +
            (halted ? ` - ${halted} queued connection${halted === 1 ? '' : 's'} halted` : '') +
            '. Nothing else will be attempted with this profile.',
            [{
                label: 'Re-enter password and retry',
                onClick: async () => {
                    await rsterm.invoke('rs:auth.reset', { profile });
                },
            }], { key: `auth:${profile}` });
    });

    // The profile works now - because a session using it connected, or
    // because its credentials were edited. Either way the warning is
    // history, whichever route the user took to fix it.
    rsterm.on('rs:evt.auth-cleared', ({ profile }) => clearBanner(`auth:${profile}`));

    rsterm.on('rs:evt.profile-missing', ({ profile }) => {
        showBanner('warn',
            `Sessions reference credential profile '${profile}' which is not set up on this machine.`,
            [{ label: 'Set up profiles', onClick: () => manageProfiles() }]);
    });

    // --- credentials-choice dialog ------------------------------------------
    // An SSH session with no credential profile (or one naming a profile this
    // machine does not have) parks in main and raises this. One dialog at a
    // time: bulk-opening six profile-less sessions must not stack six modals.
    const needsProfileQueue = [];
    let profileDialogOpen = false;

    rsterm.on('rs:evt.needs-profile', (req) => {
        needsProfileQueue.push(req);
        if (!profileDialogOpen) nextProfileDialog();
    });

    async function nextProfileDialog() {
        const req = needsProfileQueue.shift();
        if (!req) { profileDialogOpen = false; return; }
        profileDialogOpen = true;

        const profiles = await rsterm.invoke('rs:profiles.list');
        const body = document.createElement('div');
        const info = document.createElement('p');
        info.style.marginBottom = '10px';
        info.textContent = req.missing
            ? `${req.title || req.host} references credential profile '${req.missing}', ` +
              'which is not set up on this machine.'
            : `${req.title || req.host} has no credential profile.`;
        body.appendChild(info);

        // Pick a profile, or type credentials for just this connect.
        const options = profiles.map((p) => ({
            value: p.name,
            label: p.username ? `${p.name} (${p.username})` : p.name,
        }));
        options.push({ value: '__oneoff__', label: 'Enter credentials for this connect only...' });
        const pick = select(options, profiles.length ? profiles[0].name : '__oneoff__');
        body.appendChild(row('Credentials', pick));

        const fUser = input('', 'username');
        const fPass = input('', 'password', 'password');
        const userRow = row('Username', fUser);
        const passRow = row('Password', fPass);
        body.append(userRow, passRow);

        // Remember the choice on the session, so next time it just connects.
        // Only offered for saved sessions - a restored ad-hoc has no node.
        const remember = document.createElement('input');
        remember.type = 'checkbox';
        remember.checked = !!req.nodeId;
        const rememberLabel = document.createElement('label');
        rememberLabel.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:8px;cursor:pointer;';
        rememberLabel.append(remember, document.createTextNode('Remember this profile on the session'));
        if (req.nodeId) body.appendChild(rememberLabel);

        const sync = () => {
            const oneOff = pick.value === '__oneoff__';
            userRow.hidden = !oneOff;
            passRow.hidden = !oneOff;
            rememberLabel.hidden = oneOff;
        };
        pick.addEventListener('change', sync);
        sync();

        let answered = false;
        const answer = (payload) => {
            if (answered) return;
            answered = true;
            rsterm.send('rs:profile.choice', { sessionId: req.sessionId, nodeId: req.nodeId, ...payload });
            nextProfileDialog();
        };

        open(`Connect to ${req.title || req.host}`, body, [
            { label: 'Cancel', onClick: () => answer({ cancelled: true }) },
            {
                label: 'Connect', primary: true,
                onClick: () => {
                    if (pick.value === '__oneoff__') {
                        if (!fUser.value.trim()) { fUser.focus(); return false; }
                        answer({ username: fUser.value.trim(), password: fPass.value });
                    } else {
                        answer({ profile: pick.value, saveToNode: remember.checked });
                    }
                },
            },
        ], { modal: true, onCancel: () => answer({ cancelled: true }) });
    }

    // --- host key dialogs -------------------------------------------------
    rsterm.on('rs:evt.hostkey-prompt', ({ checkId, host, port, fingerprint }) => {
        const body = document.createElement('div');
        const p = document.createElement('p');
        p.textContent = `First connection to ${host}:${port}. Host key fingerprint:`;
        const fp = document.createElement('pre');
        fp.style.cssText = 'font-family:var(--mt-mono);margin:10px 0;padding:8px;' +
            'background:var(--se-input);border:1px solid var(--se-border);border-radius:4px;';
        fp.textContent = fingerprint;
        body.append(p, fp);
        open(`Trust ${host}?`, body, [
            { label: 'Cancel', onClick: () => rsterm.send('rs:hostkey.answer', { checkId, accept: false }) },
            {
                label: 'Trust and connect', primary: true,
                onClick: () => rsterm.send('rs:hostkey.answer', { checkId, accept: true, remember: true }),
            },
        ], { modal: true, onCancel: () => rsterm.send('rs:hostkey.answer', { checkId, accept: false }) });
    });

    rsterm.on('rs:evt.hostkey-mismatch', ({ host, port, fingerprint }) => {
        const body = document.createElement('div');
        const p = document.createElement('p');
        p.style.color = 'var(--se-down)';
        p.textContent = `HOST KEY CHANGED for ${host}:${port}. This can mean the device was ` +
            'replaced or reinstalled - or that something is intercepting the connection. ' +
            'The connection was refused. If the change is expected, remove the stored key ' +
            'and reconnect.';
        const fp = document.createElement('pre');
        fp.style.cssText = 'font-family:var(--mt-mono);margin:10px 0;padding:8px;' +
            'background:var(--se-input);border:1px solid var(--se-border);border-radius:4px;';
        fp.textContent = `offered: ${fingerprint}`;
        body.append(p, fp);
        open('SECURITY WARNING', body, [{ label: 'Close', primary: true }], { modal: true });
    });

    // --- tiny banner helper -----------------------------------------------
    // opts.key: a banner with the same key REPLACES the previous one
    // instead of stacking - "probing 9 devices" becomes "audit finished"
    // in place, rather than leaving both on screen.
    // opts.sticky: keep until dismissed. The default is to fade after a
    // while, because a finished job that never clears reads as a stuck
    // job. Errors and anything with a decision to make are sticky.
    const bannersByKey = new Map();
    function showBanner(kind, text, actions = [], opts = {}) {
        const workspace = document.getElementById('workspace');
        const previous = opts.key && bannersByKey.get(opts.key);
        if (previous) previous.remove();
        const banner = document.createElement('div');
        banner.className = `banner ${kind}`;
        if (opts.key) {
            banner.dataset.key = opts.key;
            bannersByKey.set(opts.key, banner);
        }
        const span = document.createElement('span');
        span.style.flex = '1';
        span.textContent = text;
        banner.appendChild(span);
        for (const a of actions) {
            const btn = document.createElement('button');
            btn.textContent = a.label;
            btn.addEventListener('click', () => { a.onClick(); banner.remove(); });
            banner.appendChild(btn);
        }
        const x = document.createElement('button');
        x.textContent = '×';
        x.addEventListener('click', () => banner.remove());
        banner.appendChild(x);
        workspace.prepend(banner);

        const sticky = opts.sticky !== undefined
            ? opts.sticky
            : (kind === 'error' || actions.length > 0);
        if (!sticky) setTimeout(() => banner.remove(), opts.timeout || 12000);
        return banner;
    }

    // Take a keyed banner down: the job it was reporting is over.
    function clearBanner(key) {
        const b = bannersByKey.get(key);
        if (b) { b.remove(); bannersByKey.delete(key); }
        // CSS.escape: a profile named ops"1 is a legal profile name and
        // used to throw inside the auth-cleared handler instead of taking
        // its banner down.
        for (const el of document.querySelectorAll(`.banner[data-key="${CSS.escape(key)}"]`)) el.remove();
    }

    window.Forms = { editSession, editFolder, manageProfiles, showBanner, clearBanner,
        askCredentials, saveSessionDialog, installKeyDialog, offerNewProfile };
})();
