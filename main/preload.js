'use strict';
// The entire security boundary. The renderer gets exactly three things:
// invoke() on an allowlist, on() for rs:evt.* pushes, and per-session
// MessagePorts relayed through window.postMessage (ports are transferable
// across the context-isolation boundary that way; nothing else is).

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE_ALLOW = new Set([
    'rs:app.bootconfig',
    'rs:session.connect',
    'rs:session.openNodes',
    'rs:session.reconnect',
    'rs:session.duplicate',
    'rs:session.describe',
    'rs:session.saveAsNode',
    'rs:session.disconnect',
    'rs:serial.listPorts',
    'rs:sftp.op',
    'rs:sftp.pickDownload',
    'rs:sftp.pickUpload',
    'rs:sftp.pickFolder',
    'rs:term.saveText',
    'rs:team.pickSyncFile',
    'rs:tree.get',
    'rs:tree.upsert',
    'rs:tree.delete',
    'rs:tree.move',
    'rs:tree.bulkEdit',
    'rs:tree.effective',
    'rs:highlights.get',
    'rs:highlights.save',
    'rs:snippets.get',
    'rs:snippets.save',
    'rs:shell.scripts',
    'rs:workspace.get',
    'rs:workspace.save',
    'rs:session.restore',
    'rs:tunnels.list',
    'rs:tunnels.upsert',
    'rs:tunnels.delete',
    'rs:tunnels.status',
    'rs:tunnels.open',
    'rs:tunnels.close',
    'rs:profiles.list',
    'rs:secrets.storageInfo',
    'rs:logs.info',
    'rs:logs.reveal',
    'rs:profiles.upsert',
    'rs:keys.discover',
    'rs:keys.inspect',
    'rs:keys.verifyPassphrase',
    'rs:keys.pick',
    'rs:keys.install',
    'rs:profiles.delete',
    'rs:auth.reset',
    'rs:settings.get',
    'rs:settings.update',
    'rs:team.status',
    'rs:team.check',
    'rs:team.plan',
    'rs:team.apply',
    'rs:team.publish',
    'rs:team.export',
    'rs:team.importPick',
    'rs:team.applyImport',
    'rs:moba.pick',
    'rs:sshimport.scan',
    'rs:sshimport.apply',
    'rs:moba.apply',
    'rs:csv.pick',
    'rs:csv.apply',
    'rs:csv.export',
    'rs:health.audit',
    'rs:health.stop',
    'rs:health.get',
    'rs:field.start',
    'rs:field.stop',
    'rs:field.list',
    'rs:field.wake',
    'rs:field.syslog',
    'rs:health.stale',
    'rs:health.forget',
]);

// One-way renderer -> main messages (no response, fire and forget). The
// password prompt answer travels this way so no invoke result can ever echo
// it back.
const SEND_ALLOW = new Set([
    'rs:secrets.promptResult',
    'rs:profile.choice',
    'rs:hostkey.answer',
]);

const EVENT_ALLOW = new Set([
    'rs:evt.session-status',
    'rs:evt.session-closed',
    'rs:evt.connect-failed',
    'rs:evt.engine-restarted',
    'rs:evt.tree-changed',
    'rs:evt.profiles-changed',
    'rs:evt.highlights-changed',
    'rs:evt.snippets-changed',
    'rs:evt.tunnel-state',
    'rs:evt.needs-password',
    'rs:evt.needs-profile',
    'rs:evt.auth-blocked',
    'rs:evt.auth-cleared',
    'rs:evt.profile-missing',
    'rs:evt.hostkey-prompt',
    'rs:evt.hostkey-mismatch',
    'rs:evt.sftp-progress',
    'rs:evt.settings-changed',
    'rs:evt.snapshot-request',
    'rs:evt.team-changes',
    'rs:evt.team-error',
    'rs:evt.health-result',
    'rs:evt.field',
    'rs:evt.health-done',
]);

contextBridge.exposeInMainWorld('rsterm', {
    invoke(channel, args) {
        if (!INVOKE_ALLOW.has(channel)) {
            return Promise.reject(new Error(`channel not allowed: ${channel}`));
        }
        return ipcRenderer.invoke(channel, args);
    },
    send(channel, args) {
        if (!SEND_ALLOW.has(channel)) throw new Error(`channel not allowed: ${channel}`);
        ipcRenderer.send(channel, args);
    },
    on(channel, cb) {
        if (!EVENT_ALLOW.has(channel)) throw new Error(`event not allowed: ${channel}`);
        ipcRenderer.on(channel, (_e, payload) => cb(payload));
    },
    // The one sanctioned way to learn a dropped File's path. Sandboxed
    // renderers get File objects with an empty .path on purpose; webUtils
    // resolves it here in the preload, so drag-and-drop upload can hand the
    // engine a real local path without loosening the sandbox.
    pathForFile(file) {
        try { return webUtils.getPathForFile(file) || null; } catch (_) { return null; }
    },
});

// Data-plane port relay: main posts {sessionId} with a MessagePort; forward
// it into the page world. The page filters on the message type.
ipcRenderer.on('rs:session-port', (e, meta) => {
    // targetOrigin '/' = same origin only. The renderer never navigates
    // (main enforces it), so this is defense in depth: even a hypothetical
    // navigation could not receive a session's MessagePort.
    window.postMessage({ type: 'rs:session-port', sessionId: meta.sessionId }, '/', e.ports);
});
