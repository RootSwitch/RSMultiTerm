'use strict';
// Control-plane routing: renderer <-> main <-> engine. Every renderer-facing
// channel is registered here and nowhere else, so the preload allowlist and
// this file are the two places to review when auditing what the UI can do.
// Nothing in here ever returns secret material to the renderer.

const { app, ipcMain, MessageChannelMain } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sessionStore = require('./session-store');
const secrets = require('./secrets');
const sshKeys = require('./ssh-keys');
const { logDirCandidates } = require('./log-dirs');
const connectFlow = require('./connect-flow');
const hostkeys = require('./hostkeys');
const highlights = require('./highlights');
const settings = require('./settings');
const teamSync = require('./team-sync');
const moba = require('./moba-import');
const csv = require('./csv-import');
const health = require('./health');
const snippets = require('./snippets');
const workspace = require('./workspace');
const tunnelStore = require('./tunnel-store');

// Default log folder: alongside the app per the requirement, probed for
// writability at first use (Program Files installs are read-only), falling
// back to Documents\RSMultiTerm\logs. Dev runs land in the repo's logs/.
let cachedLogDir = null;
function defaultLogDir() {
    if (cachedLogDir) return cachedLogDir;
    // Candidate selection lives in log-dirs.js, pure and tested - it owns
    // the two exclusions (never the Desktop, never anything under %TEMP%,
    // which for a portable build includes the exe's own extraction dir).
    const get = (name) => { try { return app.getPath(name); } catch (_) { return null; } };
    const candidates = logDirCandidates({
        envOverride: process.env.RSMT_LOGDIR || null,
        isPackaged: app.isPackaged,
        portableDir: process.env.PORTABLE_EXECUTABLE_DIR || null,
        exeDir: path.dirname(app.getPath('exe')),
        devDir: path.join(__dirname, '..'),
        desktop: get('desktop'),
        tmpdir: get('temp'),
        documents: get('documents'),
    });
    for (const dir of candidates) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            const probe = path.join(dir, `.write-probe-${process.pid}`);
            fs.writeFileSync(probe, 'x');
            fs.unlinkSync(probe);
            cachedLogDir = dir;
            return dir;
        } catch (_) { /* next candidate */ }
    }
    cachedLogDir = app.getPath('temp');
    return cachedLogDir;
}

// Effective logging config for the engine: tree value (bool or object) plus
// app defaults. Logging is ON by default - a terminal for network gear that
// silently didn't log the change window is the worst kind of surprise.
function resolveLogging(treeValue) {
    const v = treeValue === null || treeValue === undefined ? {} :
        (typeof treeValue === 'boolean' ? { enabled: treeValue } : treeValue);
    // The Settings dialog has offered "Log folder" and "Log timestamps"
    // from the start - and neither was consulted here, so both were
    // decorative. Tree values still win; the app settings fill the gaps.
    const appCfg = settings.get();
    return {
        enabled: v.enabled !== false,
        dir: v.folder || appCfg.defaultLogFolder || defaultLogDir(),
        mode: v.mode || 'text',
        timestamps: v.timestamps !== undefined
            ? v.timestamps !== false
            : appCfg.logTimestamps !== false,
    };
}

// Where session logs land right now, for the sidebar's visibility line.
function currentLogDir() {
    return settings.get().defaultLogFolder || defaultLogDir();
}

function wireIpc(engineRef, getWindow, bootConfig) {
    const newSessionId = () =>
        Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');

    // Runtime session bookkeeping main needs for engine-event routing.
    const liveDescriptors = new Map();   // sessionId -> descriptor (or null for quick connects)

    // How to dial a session again. Saved sessions keep only their node id, so
    // a reconnect picks up any edits and re-runs the auth guard. Quick
    // connects keep the typed args, password included: memory only, dropped
    // when the pane closes, never written anywhere - the alternative is
    // retyping a password every time a rebooting switch refuses, which is the
    // exact moment this feature exists for.
    const recipes = new Map();           // sessionId -> {nodeId} | {args, title}

    const forward = (channel, payload) => {
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    };

    connectFlow.wire((msg) => engineRef.proc && engineRef.proc.postMessage(msg), forward);
    sessionStore.onChange(() => forward('rs:evt.tree-changed', {}));
    secrets.onChange(() => forward('rs:evt.profiles-changed', {}));

    ipcMain.handle('rs:app.bootconfig', () => bootConfig);

    // --- session tree -----------------------------------------------------
    ipcMain.handle('rs:tree.get', () => sessionStore.nodes());
    ipcMain.handle('rs:tree.upsert', (_e, node) => sessionStore.upsert(node));
    ipcMain.handle('rs:tree.delete', (_e, { ids }) => sessionStore.remove(ids));
    ipcMain.handle('rs:tree.move', (_e, { id, parentId, order }) => sessionStore.move(id, parentId, order));
    ipcMain.handle('rs:tree.bulkEdit', (_e, { ids, patch }) => sessionStore.bulkEdit(ids, patch));
    ipcMain.handle('rs:tree.effective', (_e, { id }) => sessionStore.effective(id));

    // --- credential profiles (sanitized view only) ------------------------
    highlights.onChange(() => forward('rs:evt.highlights-changed', {}));
    teamSync.init(forward);

    // --- settings ---------------------------------------------------------
    ipcMain.handle('rs:settings.get', () => settings.get());
    ipcMain.handle('rs:settings.update', (_e, patch) => {
        const out = settings.update(patch);
        if (patch.teamSync) { teamSync.schedulePoll(); teamSync.check('config'); }
        forward('rs:evt.settings-changed', out);
        return out;
    });

    // --- team sync --------------------------------------------------------
    // Decisions arrive with arrays; the merge engine wants Sets (null =
    // accept all in that group).
    const toDecisions = (d) => ({
        acceptAdds: d.acceptAdds ? new Set(d.acceptAdds) : null,
        acceptChanges: d.acceptChanges ? new Set(d.acceptChanges) : null,
        acceptRemovals: d.acceptRemovals ? new Set(d.acceptRemovals) : null,
        conflictTakes: d.conflictTakes || {},
        dupAdopt: d.dupAdopt || {},
    });

    ipcMain.handle('rs:team.status', () => teamSync.status());
    ipcMain.handle('rs:team.check', () => { teamSync.check('manual'); return teamSync.status(); });
    ipcMain.handle('rs:team.plan', () => teamSync.planForUi());
    ipcMain.handle('rs:team.apply', (_e, { decisions, token }) =>
        teamSync.applyDecisions(toDecisions(decisions || {}), token));
    ipcMain.handle('rs:team.publish', () => teamSync.publish());

    ipcMain.handle('rs:team.export', async () => {
        const { dialog } = require('electron');
        const r = await dialog.showSaveDialog(getWindow(), {
            defaultPath: 'team-sessions.json',
            filters: [{ name: 'Session files', extensions: ['json'] }],
        });
        if (r.canceled) return null;
        return teamSync.exportTo(r.filePath);
    });
    ipcMain.handle('rs:team.importPick', async () => {
        const { dialog } = require('electron');
        const r = await dialog.showOpenDialog(getWindow(), {
            properties: ['openFile'],
            filters: [{ name: 'Session files', extensions: ['json'] }],
        });
        if (r.canceled) return null;
        return teamSync.importFrom(r.filePaths[0], null);
    });
    ipcMain.handle('rs:team.applyImport', (_e, { decisions }) => teamSync.applyImport(toDecisions(decisions || {})));

    // --- healthcheck ------------------------------------------------------
    // Serial sessions are excluded: a COM port has nothing to probe.
    function auditTargets(folderId) {
        const nodes = sessionStore.nodes();
        const inScope = (n) => {
            if (!folderId) return true;
            let p = n.parentId;
            const seen = new Set();   // cycle guard
            while (p && !seen.has(p)) {
                if (p === folderId) return true;
                seen.add(p);
                p = (nodes[p] || {}).parentId;
            }
            return false;
        };
        return Object.values(nodes)
            .filter((n) => n.type === 'session' && n.host && inScope(n))
            .map((n) => {
                let d;
                try { d = sessionStore.resolveDescriptor(n.id); } catch (_) { return null; }
                if (d.transport === 'serial') return null;
                return { nodeId: n.id, host: d.host, port: d.port };
            })
            .filter(Boolean);
    }

    let healthRun = 0;
    ipcMain.handle('rs:health.audit', (_e, { folderId }) => {
        const engine = engineRef.proc;
        if (!engine) throw new Error('engine not running');
        const targets = auditTargets(folderId);
        if (!targets.length) return { started: 0 };
        healthRun++;
        engine.postMessage({
            t: 'healthcheck', runId: healthRun, targets,
            opts: settings.get().healthcheck || {},
        });
        return { started: targets.length };
    });
    ipcMain.handle('rs:health.stop', () => {
        if (engineRef.proc) engineRef.proc.postMessage({ t: 'healthcheck-stop' });
    });
    // --- field tools ------------------------------------------------------
    // One channel for the lot; the engine owns the sockets. Nothing starts
    // by itself - every call here is a button somebody pressed.
    let nextFieldReq = 1;
    const fieldCall = (op, extra) => {
        const engine = engineRef.proc;
        if (!engine) throw new Error('engine not running');
        return new Promise((resolve, reject) => {
            const reqId = 'f' + (nextFieldReq++);
            fieldWaiters.set(reqId, { resolve, reject });
            engine.postMessage({ t: 'field', reqId, op, ...extra });
            setTimeout(() => {
                const w = fieldWaiters.get(reqId);
                if (w) { fieldWaiters.delete(reqId); w.reject(new Error('the engine did not answer')); }
            }, 15000);
        });
    };
    ipcMain.handle('rs:field.start', (_e, spec) => {
        // Strict on purpose: everything else in the app CONNECTS, this
        // LISTENS, so the renderer's spec is checked in main rather than
        // trusted shapewise. The engine re-checks the root; the bind
        // address must be one this machine actually has.
        if (!spec || (spec.kind !== 'tftp' && spec.kind !== 'http')) {
            throw new Error('unknown server kind');
        }
        const port = Number(spec.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
            throw new Error('the port must be between 0 and 65535');
        }
        const bind = String(spec.bind || '');
        const known = ['0.0.0.0', '127.0.0.1'];
        for (const list of Object.values(require('os').networkInterfaces())) {
            for (const iface of list || []) known.push(iface.address);
        }
        if (!known.includes(bind)) {
            throw new Error(`${bind || '(empty)'} is not an address on this machine`);
        }
        let rootStat;
        try { rootStat = fs.statSync(String(spec.root || '')); } catch (_) { /* below */ }
        if (!rootStat || !rootStat.isDirectory()) {
            throw new Error('the served folder does not exist');
        }
        return fieldCall('start', {
            spec: {
                id: String(spec.id), kind: spec.kind, root: String(spec.root),
                bind, port, allowWrites: !!spec.allowWrites, listing: !!spec.listing,
                stopAfterMinutes: Number(spec.stopAfterMinutes) || 60,
            },
        });
    });
    ipcMain.handle('rs:field.stop', (_e, { id }) => fieldCall('stop', { id }));
    ipcMain.handle('rs:field.list', () => fieldCall('list', {}));
    ipcMain.handle('rs:field.wake', (_e, { mac, broadcast, port }) =>
        fieldCall('wake', { mac, broadcast, port }));

    ipcMain.handle('rs:health.get', () => health.all());
    ipcMain.handle('rs:health.stale', (_e, { days }) => health.staleNodeIds(days || 14));
    ipcMain.handle('rs:health.forget', (_e, { nodeIds }) => health.forget(nodeIds || []));

    // --- CSV import / export ----------------------------------------------
    // The plan is held here between preview and apply so the renderer never
    // becomes the source of truth for what is about to be written.
    let csvPlan = null;
    ipcMain.handle('rs:csv.pick', async (_e, { targetFolderId }) => {
        const { dialog } = require('electron');
        const r = await dialog.showOpenDialog(getWindow(), {
            properties: ['openFile'],
            filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
        });
        if (r.canceled) return null;
        const text = fs.readFileSync(r.filePaths[0], 'utf8');
        csvPlan = { plan: csv.plan(text, targetFolderId || null), targetFolderId: targetFolderId || null };
        return csvPlan.plan;
    });
    ipcMain.handle('rs:csv.apply', (_e, { accept }) => {
        if (!csvPlan) throw new Error('no import in progress');
        const out = csv.apply(csvPlan.plan, accept || [], csvPlan.targetFolderId);
        csvPlan = null;
        return out;
    });
    // Save a pane's buffer as a text file. The renderer sends the content;
    // main owns the dialog and the disk. RSMT_SMOKE_SAVETEXT bypasses the
    // native dialog so the path is testable end to end.
    ipcMain.handle('rs:term.saveText', async (_e, { name, text }) => {
        const clean = String(name || 'output.txt').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
        const body = String(text || '');
        // Dev-only test hook; never honored in a packaged build.
        const smokeOut = require('./dev-hooks').devOnlyHook('RSMT_SMOKE_SAVETEXT');
        if (smokeOut) {
            fs.writeFileSync(smokeOut, body, 'utf8');
            return { path: smokeOut };
        }
        const { dialog } = require('electron');
        const r = await dialog.showSaveDialog(getWindow(), {
            defaultPath: clean,
            filters: [{ name: 'Text', extensions: ['txt', 'log'] }],
        });
        if (r.canceled || !r.filePath) return null;
        fs.writeFileSync(r.filePath, body, 'utf8');
        return { path: r.filePath };
    });

    ipcMain.handle('rs:csv.export', async (_e, { folderId }) => {
        const { dialog } = require('electron');
        const r = await dialog.showSaveDialog(getWindow(), {
            defaultPath: 'sessions.csv',
            filters: [{ name: 'CSV', extensions: ['csv'] }],
        });
        if (r.canceled) return null;
        const text = csv.exportFolder(folderId || null);
        fs.writeFileSync(r.filePath, text, 'utf8');
        return { path: r.filePath, lines: text.trim().split('\n').length - 1 };
    });

    // --- MobaXTerm import -------------------------------------------------
    ipcMain.handle('rs:moba.pick', async () => {
        const { dialog } = require('electron');
        const r = await dialog.showOpenDialog(getWindow(), {
            properties: ['openFile'],
            filters: [{ name: 'MobaXTerm sessions', extensions: ['mxtsessions'] }],
        });
        if (r.canceled) return null;
        return moba.parse(r.filePaths[0]);
    });
    ipcMain.handle('rs:moba.apply', (_e, { report, profileByUsername, rootName }) => {
        const nodes = moba.toNodes(report, profileByUsername || {}, rootName);
        return teamSync.importNodes(nodes);
    });
    ipcMain.handle('rs:highlights.get', () => highlights.getSets());
    ipcMain.handle('rs:highlights.save', (_e, { sets }) => highlights.saveSets(sets));

    snippets.onChange(() => forward('rs:evt.snippets-changed', {}));
    ipcMain.handle('rs:snippets.get', () => snippets.get());
    ipcMain.handle('rs:snippets.save', (_e, { snippets: list }) => snippets.save(list));

    // --- shell integration ------------------------------------------------
    // Read-only: main hands back the scripts, the renderer shows them for
    // approval and types the chosen one into the focused pane. Nothing here
    // touches a remote machine on its own.
    ipcMain.handle('rs:shell.scripts', (_e, { shell }) => {
        const s = require('./shell-snippets');
        return {
            ...s.info(shell),
            shells: s.shells(),
            session: s.sessionScript(shell),
            install: s.installScript(shell),
            uninstall: s.uninstallScript(shell),
        };
    });

    // --- tunnels ----------------------------------------------------------
    // A tunnel's chain is the endpoint's own jump chain plus the endpoint
    // itself: the last hop is where the tunnel terminates. That makes a
    // tunnel through a bastion share the bastion connection the terminal
    // sessions already authenticated - one auth, not two.
    const tunnelWaiters = new Map();
    let nextTunnelReq = 1;
    function tunnelCall(msg) {
        const engine = engineRef.proc;
        if (!engine) throw new Error('engine not running');
        return new Promise((resolve, reject) => {
            const reqId = nextTunnelReq++;
            tunnelWaiters.set(reqId, { resolve, reject });
            engine.postMessage({ ...msg, reqId });
            setTimeout(() => {
                const w = tunnelWaiters.get(reqId);
                if (w) { tunnelWaiters.delete(reqId); w.reject(new Error('tunnel request timed out')); }
            }, 30000);
        });
    }

    function tunnelChain(def) {
        const descriptor = sessionStore.resolveDescriptor(def.nodeId);
        if (descriptor.transport !== 'ssh') throw new Error('tunnels need an SSH endpoint');
        const endpoint = {
            nodeId: descriptor.nodeId,
            host: descriptor.host,
            port: descriptor.port || 22,
            credentialProfile: descriptor.credentialProfile || null,
        };
        const chain = [...(descriptor.jumpChain || []), endpoint];
        // Same first-contact allowance openNode gives its hops: an unknown
        // host pops the fingerprint dialog, and 15 seconds is not enough
        // time to read a fingerprint - the first tunnel attempt died
        // mid-dialog and only the retry (now-known host) worked.
        for (const hop of chain) {
            hop.timeoutMs = hostkeys.isKnown(hop.host, hop.port || 22) ? undefined : 120000;
        }
        return chain;
    }

    ipcMain.handle('rs:tunnels.list', () => tunnelStore.all());
    ipcMain.handle('rs:tunnels.upsert', (_e, def) => tunnelStore.upsert(def));
    ipcMain.handle('rs:tunnels.delete', (_e, { id }) => tunnelStore.remove(id));
    ipcMain.handle('rs:tunnels.status', () => tunnelCall({ t: 'tunnel-list' }));

    ipcMain.handle('rs:tunnels.open', async (_e, { id }) => {
        const def = tunnelStore.get(id);
        if (!def) throw new Error('unknown tunnel');
        const chain = tunnelChain(def);
        // Credentials for every hop INCLUDING the endpoint, resolved through
        // the same guard sessions use: a tripped profile fails here too,
        // network-untouched, and a prompt-mode profile with nothing cached
        // says so instead of dialing with a blank password.
        const profiles = new Set(chain.map((h) => h.credentialProfile).filter(Boolean));
        const authByProfile = {};
        for (const name of profiles) {
            if (connectFlow.tripped(name)) {
                throw new Error(`credential profile '${name}' is halted after an auth failure`);
            }
            const auth = secrets.getAuth(name);
            if (!auth || auth.missing || !auth.username) {
                throw new Error(`credential profile '${name}' needs a password - open a session to it first`);
            }
            authByProfile[name] = auth;
        }
        return tunnelCall({
            t: 'tunnel-open',
            spec: {
                id: def.id, kind: def.kind, chain,
                bindHost: def.bindHost, bindPort: def.bindPort,
                destHost: def.destHost, destPort: def.destPort,
            },
            authByProfile,
        });
    });

    ipcMain.handle('rs:tunnels.close', (_e, { id }) => tunnelCall({ t: 'tunnel-close', id }));

    // Logging visibility: the sidebar says logs are being written and
    // where. reveal() opens the folder - the PATH IS COMPUTED HERE, never
    // taken from the renderer, so this is not an open-arbitrary-path hole.
    ipcMain.handle('rs:logs.info', () => ({
        dir: currentLogDir(),
        customized: !!settings.get().defaultLogFolder,
    }));
    ipcMain.handle('rs:logs.reveal', () => {
        const { shell } = require('electron');
        const dir = currentLogDir();
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* exists */ }
        shell.openPath(dir);
        return { dir };
    });

    // What protects a stored secret on THIS machine, so the UI can say it
    // rather than assuming Windows.
    ipcMain.handle('rs:secrets.storageInfo', () => secrets.storageInfo());

    ipcMain.handle('rs:profiles.list', () => secrets.list());
    ipcMain.handle('rs:profiles.upsert', (_e, input) => {
        const out = secrets.upsert(input);
        // New credentials are the user saying "this is fixed". Lift the
        // lockout guard and take the failure banner down - otherwise they
        // change the password and the profile stays halted until they find
        // the banner's retry button, which is the opposite of obvious.
        const changed = input && (input.password !== undefined || input.clearPassword ||
            input.keyPath !== undefined || input.authMethod !== undefined ||
            input.keyPassphrase !== undefined);
        if (changed && input.name) {
            connectFlow.reset(input.name);
            forward('rs:evt.auth-cleared', { profile: input.name });
        }
        return out;
    });

    // --- SSH keys ---------------------------------------------------------
    // Discovery is what makes key auth the default path rather than a thing
    // you configure: most people already have ~/.ssh/id_ed25519 and should
    // not have to remember its name, let alone type it.
    ipcMain.handle('rs:keys.discover', () => ({
        keys: sshKeys.discover(),
        agent: sshKeys.agentStatus(),
        sshDir: sshKeys.sshDir(),
    }));
    ipcMain.handle('rs:keys.inspect', (_e, { path: file }) => sshKeys.inspect(file || ''));
    ipcMain.handle('rs:keys.verifyPassphrase', (_e, { path: file, passphrase }) =>
        sshKeys.verifyPassphrase(file || '', passphrase || ''));
    // ssh-copy-id, in-app: derive the public line HERE (the private key
    // and any stored passphrase never leave main) and hand only the public
    // line to the engine, which appends it over the session's existing
    // connection.
    ipcMain.handle('rs:keys.install', (_e, { sessionId, keyPath }) => {
        const engine = engineRef.proc;
        if (!engine) throw new Error('engine not running');
        const pub = sshKeys.publicLineFor(keyPath, secrets.passphraseForKey(keyPath));
        if (!pub.ok) throw new Error(pub.reason);
        return new Promise((resolve, reject) => {
            const reqId = 'ki' + (nextSftpReq++);
            keyInstallWaiters.set(reqId, { resolve, reject });
            engine.postMessage({ t: 'key-install', reqId, sessionId, publicLine: pub.line });
            setTimeout(() => {
                const w = keyInstallWaiters.get(reqId);
                if (w) { keyInstallWaiters.delete(reqId); w.reject(new Error('key install timed out')); }
            }, 60000);
        });
    });

    ipcMain.handle('rs:keys.pick', async () => {
        const { dialog } = require('electron');
        const r = await dialog.showOpenDialog(getWindow(), {
            title: 'Choose an SSH private key',
            defaultPath: sshKeys.sshDir(),
            properties: ['openFile', 'showHiddenFiles'],
            // Keys usually have no extension at all, so no filter would
            // hide the very file being looked for.
            filters: [{ name: 'All files', extensions: ['*'] }],
        });
        if (r.canceled || !r.filePaths.length) return null;
        return { path: r.filePaths[0], info: sshKeys.inspect(r.filePaths[0]) };
    });
    ipcMain.handle('rs:profiles.delete', (_e, { name }) => secrets.removeProfile(name));
    ipcMain.handle('rs:auth.reset', (_e, { profile }) => connectFlow.reset(profile));

    // One-way: the renderer's password prompt answer. Cached in memory,
    // releases every session parked behind the prompt.
    ipcMain.on('rs:secrets.promptResult', (_e, { profile, username, password, cancelled, remember }) => {
        if (cancelled) connectFlow.promptCancelled(profile);
        else connectFlow.promptAnswered(profile, password, username, !!remember);
    });

    // One-way: the credentials-choice dialog for a session with no usable
    // profile. "Remember on this session" writes the profile NAME to the
    // tree node - a name, never a secret, which is the whole profile model.
    ipcMain.on('rs:profile.choice', (_e, { sessionId, nodeId, profile, saveToNode, username, password, cancelled }) => {
        if (profile && saveToNode && nodeId) {
            const node = sessionStore.get(nodeId);
            if (node && node.type === 'session') {
                sessionStore.upsert({ ...node, credentialProfile: profile });
            }
        }
        connectFlow.profileChoice(sessionId, cancelled ? { cancelled: true }
            : profile ? { profile } : { username, password });
    });

    // --- connecting -------------------------------------------------------
    function createRuntimeSession(e) {
        const sessionId = newSessionId();
        const engine = engineRef.proc;
        if (!engine) throw new Error('engine not running');
        const { port1, port2 } = new MessageChannelMain();
        engine.postMessage({ t: 'port', sessionId }, [port1]);
        e.sender.postMessage('rs:session-port', { sessionId }, [port2]);
        return sessionId;
    }

    // Open one saved session: resolve descriptor + credentials through the
    // auth guard, connect via the engine.
    // First contact with a host means the fingerprint dialog: ssh2's
    // readyTimeout keeps ticking while it is open, and 15 seconds is not
    // enough for someone actually reading the fingerprint. Known hosts keep
    // the tight timeout, since their check answers instantly.
    function handshakeTimeout(descriptor) {
        if (descriptor.transport !== 'ssh') return undefined;
        return hostkeys.isKnown(descriptor.host, descriptor.port || 22) ? undefined : 120000;
    }

    function openNode(e, nodeId) {
        let descriptor;
        try {
            descriptor = sessionStore.resolveDescriptor(nodeId);
            descriptor.logging = resolveLogging(descriptor.logging);
            descriptor.timeoutMs = descriptor.timeoutMs || handshakeTimeout(descriptor);
            for (const hop of descriptor.jumpChain || []) {
                hop.timeoutMs = hostkeys.isKnown(hop.host, hop.port || 22) ? undefined : 120000;
            }
        } catch (err) {
            return { nodeId, error: err.message };
        }
        const sessionId = createRuntimeSession(e);
        liveDescriptors.set(sessionId, descriptor);
        recipes.set(sessionId, { nodeId });
        connectFlow.requestConnect(sessionId, descriptor, (desc, authByProfile, auth) => {
            // `auth` is set only for a one-off answer from the credentials
            // dialog: used for this one dial and nowhere else - a reconnect
            // re-resolves from the tree and asks again, on purpose.
            engineRef.proc.postMessage({
                t: 'connect', sessionId, descriptor: desc, authByProfile, auth,
            });
        });
        return {
            nodeId, sessionId,
            title: descriptor.name || descriptor.host,
            highlightSet: descriptor.highlightSet,
            transport: descriptor.transport,
        };
    }

    ipcMain.handle('rs:session.openNodes', (e, { nodeIds }) =>
        nodeIds.map((nodeId) => openNode(e, nodeId)));

    // --- workspace resurrection ------------------------------------------
    // The renderer sends its layout with pane sessionIds; the recipes that
    // can redial them live HERE, so the join happens here too. Passwords
    // are stripped inside workspace.save - a snapshot never carries one.
    ipcMain.handle('rs:workspace.get', () => workspace.get());
    ipcMain.handle('rs:workspace.save', (_e, { tabs, activeTab, final }) => {
        const layout = (tabs || []).map((t) => ({
            title: t.title,
            focusedIndex: t.focusedIndex,
            panes: (t.panes || []).map((p) => ({
                recipe: recipes.get(p.sessionId) || p.restoredRecipe || null,
                title: p.title,
                transport: p.transport,
                highlightSet: p.highlightSet,
                scrollback: p.scrollback,
            })),
        }));
        const out = workspace.save(layout, activeTab);
        if (final && finalSnapshotWaiter) {
            const w = finalSnapshotWaiter;
            finalSnapshotWaiter = null;
            w();
        }
        return out;
    });

    // Register a pane that exists only as a picture: a runtime sessionId
    // with a recipe (so R can redial it) but NO engine session and NO
    // connect. The recipe shapes accepted are exactly the two the connect
    // paths themselves accept, minus nothing a renderer could not already
    // do via rs:session.connect / openNodes.
    ipcMain.handle('rs:session.restore', (_e, { recipe, title }) => {
        const clean = workspace.sanitizeRecipe(recipe);
        if (!clean) throw new Error('unrecognized restore recipe');
        const sessionId = newSessionId();
        recipes.set(sessionId, clean.nodeId ? { nodeId: clean.nodeId }
            : { args: clean.args, title });
        return { sessionId };
    });

    let finalSnapshotWaiter = null;
    function requestFinalSnapshot() {
        return new Promise((resolve) => {
            const win = getWindow();
            if (!win || win.isDestroyed()) return resolve();
            finalSnapshotWaiter = resolve;
            forward('rs:evt.snapshot-request', {});
            // A hung or busy renderer must not hold the window hostage; the
            // continuously-saved layout is already on disk, so the worst a
            // timeout costs is the scrollback of this final snapshot.
            setTimeout(() => {
                if (finalSnapshotWaiter === resolve) {
                    finalSnapshotWaiter = null;
                    resolve();
                }
            }, 1200);
        });
    }

    // Dial the same target again in a fresh session. Saved sessions go back
    // through the tree (so an edited host or profile is picked up); quick
    // connects reuse what was typed.
    // A second, independent session to the same target, leaving the first
    // alone: one pane running htop while you work in the other.
    ipcMain.handle('rs:session.duplicate', (e, { sessionId }) => {
        const recipe = recipes.get(sessionId);
        if (!recipe) throw new Error('this session cannot be duplicated');
        if (recipe.nodeId) {
            const r = openNode(e, recipe.nodeId);
            if (r.error) throw new Error(r.error);
            return r;
        }
        return startQuickConnect(e, recipe.args);
    });

    ipcMain.handle('rs:session.reconnect', (e, { sessionId }) => {
        const recipe = recipes.get(sessionId);
        if (!recipe) throw new Error('this session cannot be reconnected');

        // A quick-connect recipe restored from a workspace snapshot has no
        // password - snapshots never carry one. Dialling anyway would spend
        // a real authentication attempt on a blank password, which is the
        // lockout this app is built to avoid. Ask for it instead, and leave
        // the recipe intact so a cancelled prompt costs nothing. (An empty
        // string is a deliberate blank password and is NOT this case.)
        if (recipe.args && (recipe.args.transport || 'ssh') === 'ssh' &&
            recipe.args.password === undefined) {
            return {
                needsCredentials: true,
                host: recipe.args.host,
                username: recipe.args.username || '',
                args: recipe.args,
            };
        }

        // Make sure the old one is really gone before dialing again.
        if (engineRef.proc) engineRef.proc.postMessage({ t: 'disconnect', sessionId });
        recipes.delete(sessionId);
        liveDescriptors.delete(sessionId);

        if (recipe.nodeId) {
            const r = openNode(e, recipe.nodeId);
            if (r.error) throw new Error(r.error);
            return r;
        }
        return startQuickConnect(e, recipe.args);
    });

    // What a live session would look like as a saved one. Never returns
    // the password: a quick-connect password was typed for one connection
    // and saving a session does not turn it into a stored secret.
    ipcMain.handle('rs:session.describe', (_e, { sessionId }) => {
        const recipe = recipes.get(sessionId);
        if (!recipe) return { savable: false, reason: 'this session cannot be saved' };
        // Either opened FROM the tree, or saved into it since. Both mean
        // there is nothing left to save.
        const known = recipe.nodeId || recipe.savedNodeId;
        if (known) {
            const node = sessionStore.get(known);
            return { savable: false, nodeId: known,
                reason: node ? `already saved as '${node.name}'` : 'already saved' };
        }
        const a = recipe.args || {};
        return {
            savable: true,
            // Whether a password EXISTS, never the password: the renderer
            // only needs to know whether to offer keeping it - and where it
            // would go if kept.
            hasPassword: !!a.password,
            storage: secrets.storageInfo(),
            args: {
                transport: a.transport || 'ssh',
                host: a.host || null,
                port: a.port || null,
                username: a.username || '',
                rawTcp: !!a.rawTcp,
                serial: a.serial || null,
            },
        };
    });

    // Save a quick-connect session into the tree. The live session is left
    // exactly as it is - this writes a saved session for NEXT time, and
    // deliberately does not re-point the running one at it, which would
    // change what a reconnect does out from under someone.
    ipcMain.handle('rs:session.saveAsNode', (_e, opts) => {
        const { sessionId, name, parentId, credentialProfile, createProfileFor, savePassword } = opts || {};
        const recipe = recipes.get(sessionId);
        if (!recipe || !recipe.args) throw new Error('this session cannot be saved');
        const a = recipe.args;

        let profile = credentialProfile || null;
        if (createProfileFor) {
            // The profile carries the username (not a secret). The password
            // is kept only when asked to - and it qualifies for storing
            // because it already opened the device this pane is showing.
            const keep = savePassword && a.password && secrets.secretStorageAvailable();
            secrets.upsert({
                name: createProfileFor,
                username: a.username || '',
                storage: keep ? 'dpapi' : 'prompt',
                authMethod: 'password',
                password: keep ? a.password : undefined,
            });
            profile = createProfileFor;
        }

        const node = sessionStore.upsert({
            type: 'session',
            name: String(name || a.host || 'session').slice(0, 200),
            parentId: parentId || null,
            host: a.host || null,
            port: a.port || null,
            transport: a.transport || 'ssh',
            rawTcp: !!a.rawTcp,
            serial: a.serial || null,
            credentialProfile: profile,
        });
        // Remembered so a second save cannot make a duplicate, while the
        // recipe keeps its args - a reconnect of THIS pane still redials
        // exactly what it dialed before.
        recipes.set(sessionId, { ...recipe, savedNodeId: node.id });
        return { nodeId: node.id, name: node.name, profile };
    });

    // Quick connect: descriptor and auth straight from the form.
    function startQuickConnect(e, args) {
        const sessionId = createRuntimeSession(e);
        liveDescriptors.set(sessionId, null);
        recipes.set(sessionId, { args });
        const descriptor = {
            transport: args.transport || 'ssh',
            host: args.host,
            port: args.port,
            rawTcp: !!args.rawTcp,
            serial: args.serial,
            cols: args.cols,
            rows: args.rows,
            logging: resolveLogging(null),
        };
        descriptor.timeoutMs = handshakeTimeout(descriptor);
        engineRef.proc.postMessage({
            t: 'connect',
            sessionId,
            descriptor,
            auth: { username: args.username, password: args.password },
        });
        const transport = args.transport || 'ssh';
        return {
            sessionId,
            transport,
            // Used when a reconnect has to name the pane itself.
            title: transport === 'serial'
                ? `${(args.serial || {}).device || 'serial'} @ ${(args.serial || {}).baud || 9600}`
                : (transport === 'ssh'
                    ? `${args.username}@${args.host}` : `${args.host}:${args.port}`),
        };
    }

    ipcMain.handle('rs:session.connect', (e, args) => startQuickConnect(e, args));

    ipcMain.handle('rs:session.disconnect', (_e, { sessionId }) => {
        liveDescriptors.delete(sessionId);
        // Closing a pane drops its recipe, and with it any quick-connect
        // password held in memory.
        recipes.delete(sessionId);
        // A parked or canary session never reached the engine, so no 'closed'
        // event will ever clean it out of the connect flow - do it here.
        connectFlow.onSessionGone(sessionId);
        if (engineRef.proc) engineRef.proc.postMessage({ t: 'disconnect', sessionId });
    });

    // --- sftp -------------------------------------------------------------
    const sftpWaiters = new Map();
    const keyInstallWaiters = new Map();
    const fieldWaiters = new Map();
    let nextSftpReq = 1;
    ipcMain.handle('rs:sftp.op', (_e, { sessionId, req }) => {
        const engine = engineRef.proc;
        if (!engine) throw new Error('engine not running');
        return new Promise((resolve, reject) => {
            const reqId = nextSftpReq++;
            sftpWaiters.set(reqId, { resolve, reject });
            engine.postMessage({ t: 'sftp', reqId, sessionId, req });
            // Transfers can legitimately run for a long time; only cap the
            // quick metadata ops.
            // Transfers run as long as the data takes; only the quick
            // metadata ops get a deadline. downloadTree was missing here
            // and any tree slower than 30s was reported failed while the
            // engine kept downloading it in the background.
            if (req.op !== 'download' && req.op !== 'upload' && req.op !== 'downloadTree') {
                setTimeout(() => {
                    const w = sftpWaiters.get(reqId);
                    if (w) { sftpWaiters.delete(reqId); w.reject(new Error('sftp timeout')); }
                }, 30000);
            }
        });
    });

    ipcMain.handle('rs:sftp.pickDownload', async (_e, { name }) => {
        const { dialog } = require('electron');
        // The suggested name originates in a DEVICE's directory listing.
        // The renderer cleans it; main does not take that on trust, since
        // a directory in defaultPath silently relocates the dialog.
        const suggested = path.basename(String(name || 'download')) || 'download';
        const r = await dialog.showSaveDialog(getWindow(), { defaultPath: suggested });
        return r.canceled ? null : r.filePath;
    });
    // The sync file may not exist yet (the first machine creates it), so
    // this is a save dialog rather than an open one - typing the path by
    // hand was the only way before.
    ipcMain.handle('rs:team.pickSyncFile', async () => {
        const { dialog } = require('electron');
        const r = await dialog.showSaveDialog(getWindow(), {
            title: 'Sessions sync file',
            defaultPath: 'rsmultiterm-sessions.json',
            filters: [{ name: 'Sessions file', extensions: ['json'] }],
            properties: ['createDirectory', 'showOverwriteConfirmation'],
        });
        return r.canceled ? null : r.filePath;
    });

    ipcMain.handle('rs:sftp.pickUpload', async () => {
        const { dialog } = require('electron');
        const r = await dialog.showOpenDialog(getWindow(), { properties: ['openFile'] });
        return r.canceled ? null : r.filePaths[0];
    });
    // Where to put a multi-file download: one directory for the batch, not
    // one save-as dialog per file.
    ipcMain.handle('rs:sftp.pickFolder', async () => {
        const { dialog } = require('electron');
        const r = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory'] });
        return r.canceled ? null : r.filePaths[0];
    });

    // --- serial listing ---------------------------------------------------
    const serialWaiters = new Map();
    let nextReqId = 1;
    ipcMain.handle('rs:serial.listPorts', () => {
        const engine = engineRef.proc;
        if (!engine) return [];
        return new Promise((resolve) => {
            const reqId = nextReqId++;
            serialWaiters.set(reqId, resolve);
            engine.postMessage({ t: 'list-serial', reqId });
            setTimeout(() => {
                if (serialWaiters.delete(reqId)) resolve([]);
            }, 5000);
        });
    });

    // --- host keys --------------------------------------------------------
    // checkId -> {host, port, fingerprint} while a first-contact prompt is
    // out with the renderer.
    const hostkeyPending = new Map();

    ipcMain.on('rs:hostkey.answer', (_e, { checkId, accept, remember }) => {
        const p = hostkeyPending.get(checkId);
        if (!p) return;
        hostkeyPending.delete(checkId);
        if (accept && remember !== false) hostkeys.trust(p.host, p.port, p.fingerprint);
        if (engineRef.proc) engineRef.proc.postMessage({ t: 'hostkey-answer', checkId, accept: !!accept });
    });

    // --- engine -> main ---------------------------------------------------
    const onEngineMessage = function onEngineMessage(m) {
        switch (m.t) {
            case 'sftp-result': {
                const w = sftpWaiters.get(m.reqId);
                if (w) {
                    sftpWaiters.delete(m.reqId);
                    if (m.ok) w.resolve(m.result);
                    else w.reject(new Error(m.error));
                }
                break;
            }
            case 'sftp-progress':
                forward('rs:evt.sftp-progress', m);
                break;
            case 'health-result':
                health.record(m.nodeId, m.reachable, m.state);
                forward('rs:evt.health-result', m);
                break;
            case 'health-done':
                health.flush();
                forward('rs:evt.health-done', m);
                break;
            case 'serial-ports': {
                const resolve = serialWaiters.get(m.reqId);
                if (resolve) { serialWaiters.delete(m.reqId); resolve(m.ports); }
                break;
            }
            case 'tunnel-result': {
                const w = tunnelWaiters.get(m.reqId);
                if (w) {
                    tunnelWaiters.delete(m.reqId);
                    if (m.ok) w.resolve(m.result);
                    else w.reject(new Error(m.error));
                }
                break;
            }
            case 'tunnel-state':
                forward('rs:evt.tunnel-state', m);
                break;
            case 'hostkey-check': {
                const verdict = hostkeys.check(m.host, m.port, m.fingerprint);
                if (verdict === 'known') {
                    engineRef.proc.postMessage({ t: 'hostkey-answer', checkId: m.checkId, accept: true });
                } else if (verdict === 'MISMATCH') {
                    // Hard block. No prompt, no override in the connect path -
                    // fixing this requires deliberately forgetting the old key.
                    engineRef.proc.postMessage({ t: 'hostkey-answer', checkId: m.checkId, accept: false });
                    forward('rs:evt.hostkey-mismatch', {
                        host: m.host, port: m.port, fingerprint: m.fingerprint,
                    });
                } else {
                    hostkeyPending.set(m.checkId, { host: m.host, port: m.port, fingerprint: m.fingerprint });
                    forward('rs:evt.hostkey-prompt', {
                        checkId: m.checkId, host: m.host, port: m.port, fingerprint: m.fingerprint,
                    });
                }
                break;
            }
            case 'status': {
                if (m.state === 'connected') {
                    connectFlow.onConnected(m.sessionId);
                    // A remember-me prompt answer is only stored once it has
                    // opened a device; this is that moment.
                    const desc = liveDescriptors.get(m.sessionId);
                    if (desc) {
                        // Connecting to a device proves it is reachable far
                        // better than a port probe does, so a saved session
                        // that just opened stops wearing a red dot from an
                        // audit days ago. Only success is recorded: a failed
                        // connect can be a wrong password, which says nothing
                        // about whether the device is there.
                        if (desc.nodeId) {
                            health.record(desc.nodeId, true, 'open');
                            health.flush();
                        }
                        const used = [desc.credentialProfile,
                            ...(desc.jumpChain || []).map((h) => h.credentialProfile)].filter(Boolean);
                        for (const p of used) {
                            secrets.commitSaved(p);
                            // It works: retire any "authentication failed"
                            // banner for it, however the user fixed it.
                            forward('rs:evt.auth-cleared', { profile: p });
                        }
                    }
                }
                // Carry the tree node id so the renderer can tell WHICH saved
                // session came up - auto-start tunnels key off it.
                const d = liveDescriptors.get(m.sessionId);
                forward('rs:evt.session-status', d && d.nodeId ? { ...m, nodeId: d.nodeId } : m);
                break;
            }
            case 'field-result': {
                const fw = fieldWaiters.get(m.reqId);
                if (fw) {
                    fieldWaiters.delete(m.reqId);
                    if (m.ok) fw.resolve(m.result);
                    else fw.reject(new Error(m.error));
                }
                break;
            }
            case 'engine-warning':
                // The engine survived an uncaught exception. Surviving is
                // the backstop doing its job; silence would be it hiding a
                // bug, so it lands in the main log where a report can find it.
                require('./safe-log').error('engine uncaught exception (survived):', m.error);
                break;
            case 'field-log':
            case 'field-state':
                forward('rs:evt.field', m);
                break;
            case 'key-install-result': {
                const kw = keyInstallWaiters.get(m.reqId);
                if (kw) {
                    keyInstallWaiters.delete(m.reqId);
                    if (m.ok) kw.resolve(m.result);
                    else kw.reject(new Error(m.error));
                }
                break;
            }
            case 'closed':
                liveDescriptors.delete(m.sessionId);
                // A canary that closed without a connected/connect-failed
                // verdict (user closed the pane mid-handshake) must not park
                // its profile forever.
                connectFlow.onSessionGone(m.sessionId);
                forward('rs:evt.session-closed', m);
                break;
            case 'connect-failed':
                connectFlow.onConnectFailed(m.sessionId, liveDescriptors.get(m.sessionId), !!m.isAuthFailure);
                forward('rs:evt.connect-failed', m);
                break;
        }
    };

    // Engine died: every promise waiting on an engine reply is now waiting
    // on a ghost. Settle them all with the truth rather than letting SFTP
    // transfers hang forever and host-key answers post to a fresh engine
    // that never issued the checkId.
    function onEngineExit() {
        connectFlow.onEngineRestart();
        for (const [reqId, w] of sftpWaiters) {
            sftpWaiters.delete(reqId);
            w.reject(new Error('the engine restarted - transfer aborted'));
        }
        for (const [reqId, w] of keyInstallWaiters) {
            keyInstallWaiters.delete(reqId);
            w.reject(new Error('the engine restarted - key install aborted'));
        }
        for (const [reqId, w] of fieldWaiters) {
            fieldWaiters.delete(reqId);
            w.reject(new Error('the engine restarted - the servers stopped with it'));
        }
        for (const [reqId, resolve] of serialWaiters) {
            serialWaiters.delete(reqId);
            resolve([]);
        }
        for (const [reqId, w] of tunnelWaiters) {
            tunnelWaiters.delete(reqId);
            w.reject(new Error('the engine restarted - tunnel request aborted'));
        }
        hostkeyPending.clear();
        liveDescriptors.clear();
    }

    return {
        onEngineMessage, onEngineExit, requestFinalSnapshot,
        liveCount: () => liveDescriptors.size,
    };
}

module.exports = { wireIpc };
