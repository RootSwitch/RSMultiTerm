'use strict';
// Connect orchestration with the two AD-lockout protections designed in from
// day one:
//
//   1. Trip-on-first-failure: one authentication failure for a profile halts
//      every queued and future connect that references it, network-untouched,
//      until the user explicitly resets (usually by re-entering the password).
//      Timeouts and refusals do NOT trip - only real auth rejections.
//
//   2. Canary fan-out: a bulk connect groups sessions by credential profile
//      and sends ONE canary per profile first. Only when the canary
//      authenticates does the rest of the batch go, so a stale password costs
//      one attempt, not thirty.
//
// Prompt-mode profiles with nothing cached park their whole group behind a
// single renderer password prompt; the answer releases the queue.

const secrets = require('./secrets');

// profileName -> 'ok' | 'tripped'
const guard = new Map();
// profileName -> [{descriptor, launch}] parked while a canary or prompt is out
const parked = new Map();
// profileName -> sessionId of the in-flight canary
const canaries = new Map();
// Sessions waiting on the "which credentials?" dialog: an SSH session with
// no credential profile, or one whose profile does not exist on this
// machine. sessionId -> {descriptor, launch}
const awaitingProfile = new Map();
// One-shot credentials the dialog handed us, consumed at launch. Memory
// only, exactly like a quick connect's.
const oneOff = new Map();

let engineSend = null;    // (msg) => engine.postMessage
let notify = null;        // (channel, payload) => renderer

function wire(sendToEngine, notifyRenderer) {
    engineSend = sendToEngine;
    notify = notifyRenderer;
}

function tripped(profileName) {
    return guard.get(profileName) === 'tripped';
}

function reset(profileName) {
    guard.delete(profileName);
    // A canary that never resolved (pane closed mid-connect, engine died)
    // would otherwise park every future connect for this profile - and the
    // release below would immediately re-park them behind the stale entry.
    canaries.delete(profileName);
    releaseParked(profileName);
}

// Attach per-hop auth to a resolved descriptor. Returns null if any needed
// profile is prompt-mode-uncached (prompt flow required) or missing.
function resolveAuth(descriptor) {
    const profs = new Set();
    if (descriptor.credentialProfile && descriptor.transport === 'ssh') {
        profs.add(descriptor.credentialProfile);
    }
    for (const hop of descriptor.jumpChain || []) {
        if (hop.credentialProfile) profs.add(hop.credentialProfile);
    }
    const authByProfile = {};
    for (const name of profs) {
        const auth = secrets.getAuth(name);
        if (auth && auth.missing) return { missingProfile: name };
        if (!auth) return { needsPrompt: name };
        // SSH sends the username in the auth request, so an empty one is not
        // something the device can prompt for later - it fails the handshake
        // outright. Ask for it here instead of shipping a blank and letting
        // ssh2 report "Invalid username".
        if (!auth.username) return { needsPrompt: name, needUsername: true };
        authByProfile[name] = auth;
    }
    return { authByProfile };
}

// launch(descriptor, authByProfile) actually tells the engine to connect;
// injected so this module stays free of IPC plumbing.
function requestConnect(sessionId, descriptor, launch, skipCanary = false) {
    const profile = descriptor.credentialProfile;

    // Profile already tripped: fail fast, zero network.
    const guardProfiles = [profile, ...(descriptor.jumpChain || []).map((h) => h.credentialProfile)]
        .filter(Boolean);
    const trippedProfile = guardProfiles.find((p) => tripped(p));
    if (trippedProfile) {
        notify('rs:evt.session-status', {
            sessionId, state: 'auth-blocked',
            detail: `profile '${trippedProfile}' halted after an auth failure`,
        });
        return;
    }

    // No profile at all on an SSH session: the old behavior dialed with
    // blank credentials and let the handshake fail with something cryptic.
    // Ask instead - pick a profile (and optionally remember it on the
    // session) or type credentials for just this connect.
    if (descriptor.transport === 'ssh' && !profile && !oneOff.has(sessionId)) {
        awaitingProfile.set(sessionId, { descriptor, launch });
        notify('rs:evt.session-status', { sessionId, state: 'queued', detail: 'choosing credentials' });
        notify('rs:evt.needs-profile', {
            sessionId,
            nodeId: descriptor.nodeId || null,
            host: descriptor.host || null,
            title: descriptor.name || descriptor.host || null,
            missing: null,
        });
        return;
    }

    const res = resolveAuth(descriptor);
    if (res.missingProfile) {
        // The session names a profile this machine does not have. Same
        // dialog as no-profile, with the missing name called out - the old
        // banner told the user, then left the pane dead anyway.
        awaitingProfile.set(sessionId, { descriptor, launch });
        notify('rs:evt.session-status', {
            sessionId, state: 'queued',
            detail: `profile '${res.missingProfile}' is not set up - choosing credentials`,
        });
        notify('rs:evt.needs-profile', {
            sessionId,
            nodeId: descriptor.nodeId || null,
            host: descriptor.host || null,
            title: descriptor.name || descriptor.host || null,
            missing: res.missingProfile,
        });
        return;
    }
    if (res.needsPrompt) {
        // Only the first session parked behind a profile raises the prompt;
        // the whole batch rides on that one answer.
        const firstWaiter = !parked.has(res.needsPrompt);
        park(res.needsPrompt, sessionId, descriptor, launch);
        const asks = secrets.promptKind(res.needsPrompt);
        notify('rs:evt.session-status', {
            sessionId, state: 'queued',
            detail: `waiting for '${res.needsPrompt}' ${asks.kind}`,
        });
        if (firstWaiter) {
            notify('rs:evt.needs-password', {
                profile: res.needsPrompt,
                username: (secrets.byName(res.needsPrompt) || {}).username || '',
                needUsername: !!res.needUsername,
                host: descriptor.host || null,
                kind: asks.kind,
                keyPath: asks.keyPath,
                canRemember: secrets.dpapiAvailable(),
            });
        }
        return;
    }

    // Canary rule, per batch: the first session for a profile goes alone;
    // the rest park until it authenticates (skipCanary marks the release
    // pass after that success, so the batch then fans out freely). The next
    // batch pays its own single canary - cheap insurance against a password
    // that rotated since.
    if (profile && descriptor.transport === 'ssh' && !skipCanary) {
        if (canaries.has(profile)) {
            park(profile, sessionId, descriptor, launch);
            notify('rs:evt.session-status', { sessionId, state: 'queued', detail: `waiting for '${profile}' canary` });
            return;
        }
        canaries.set(profile, sessionId);
    }
    const auth = oneOff.get(sessionId);
    oneOff.delete(sessionId);
    launch(descriptor, res.authByProfile, auth);
}

function park(profileName, sessionId, descriptor, launch) {
    if (!parked.has(profileName)) parked.set(profileName, []);
    parked.get(profileName).push({ sessionId, descriptor, launch });
}

function releaseParked(profileName, skipCanary = false) {
    const queue = parked.get(profileName) || [];
    parked.delete(profileName);
    for (const item of queue) {
        requestConnect(item.sessionId, item.descriptor, item.launch, skipCanary);
    }
}

function failParked(profileName, detail) {
    const queue = parked.get(profileName) || [];
    parked.delete(profileName);
    for (const item of queue) {
        notify('rs:evt.session-status', { sessionId: item.sessionId, state: 'auth-blocked', detail });
    }
    return queue.length;
}

// Engine outcome hooks, called from ipc.js.
function onConnected(sessionId) {
    for (const [profile, canary] of canaries) {
        if (canary === sessionId) {
            canaries.delete(profile);
            releaseParked(profile, true);
        }
    }
}

function onConnectFailed(sessionId, descriptor, isAuthFailure) {
    const profile = descriptor ? descriptor.credentialProfile : null;
    let wasCanary = false;
    for (const [p, canary] of canaries) {
        if (canary === sessionId) { canaries.delete(p); wasCanary = true; }
    }
    if (!isAuthFailure || !profile) {
        // A canary that died of a NETWORK failure (dead box, timeout) says
        // nothing about the password - release the queue and let the next
        // session take over as canary. A non-canary failure releases nothing;
        // the queue is waiting on the canary, not on it.
        if (profile && wasCanary) releaseParked(profile);
        return;
    }
    guard.set(profile, 'tripped');
    secrets.clearCached(profile);
    const halted = failParked(profile, `profile '${profile}' halted after an auth failure`);
    notify('rs:evt.auth-blocked', { profile, halted });
}

// A session that ended without ever reaching onConnected/onConnectFailed -
// pane closed mid-connect, engine crashed under it - must not leave canary
// or parked entries behind. A stale canary parks every future connect for
// its profile forever, and a stale parked entry means a released queue later
// dials a session whose pane the user already closed.
function onSessionGone(sessionId) {
    // A pane closed while its credentials dialog was open.
    awaitingProfile.delete(sessionId);
    oneOff.delete(sessionId);
    for (const [profile, canary] of canaries) {
        if (canary === sessionId) {
            canaries.delete(profile);
            // The queue was waiting on this canary; let the next session
            // take over as canary rather than waiting forever.
            releaseParked(profile);
        }
    }
    for (const [profile, queue] of parked) {
        const rest = queue.filter((item) => item.sessionId !== sessionId);
        if (rest.length === queue.length) continue;
        if (rest.length) parked.set(profile, rest);
        else parked.delete(profile);
    }
}

// The engine died: every in-flight canary died with it and nothing will
// ever release the parked queues. Fail them visibly - a pane stuck on
// "waiting for canary" with no canary is the unrecoverable state this
// prevents. The trip guard survives: it is a statement about the password,
// not about the engine.
function onEngineRestart() {
    canaries.clear();
    for (const sessionId of [...awaitingProfile.keys()]) {
        notify('rs:evt.session-status', {
            sessionId, state: 'error', detail: 'engine restarted while queued - reconnect to retry',
        });
    }
    awaitingProfile.clear();
    oneOff.clear();
    for (const profile of [...parked.keys()]) {
        failParked(profile, 'engine restarted while queued - reconnect to retry');
    }
}

// The credentials dialog came back. choice:
//   {cancelled: true}                     - give up, mark the pane failed
//   {profile: 'AD Account'}               - use that profile (the caller
//                                           persists it to the node if asked)
//   {username, password}                  - one-off credentials, not stored
function profileChoice(sessionId, choice) {
    const waiting = awaitingProfile.get(sessionId);
    if (!waiting) return;
    awaitingProfile.delete(sessionId);
    if (!choice || choice.cancelled) {
        notify('rs:evt.session-status', {
            sessionId, state: 'error', detail: 'no credentials chosen',
        });
        return;
    }
    if (choice.profile) {
        // Re-run the normal flow with the profile attached: prompt-mode,
        // canary and trip handling all apply exactly as if the session had
        // carried the profile from the start.
        waiting.descriptor.credentialProfile = choice.profile;
        requestConnect(sessionId, waiting.descriptor, waiting.launch);
        return;
    }
    // One-off: stash for the launch this requestConnect leads to. Jump-hop
    // profiles still resolve (and park, and canary) as normal - only the
    // target's credentials are being supplied directly.
    oneOff.set(sessionId, { username: choice.username, password: choice.password });
    requestConnect(sessionId, waiting.descriptor, waiting.launch);
}

// The prompt came back: cache and release everything waiting. A username
// supplied here is persisted to the profile - it is not a secret, and being
// asked for it once per machine is the point of the profile model.
function promptAnswered(profileName, password, username, remember) {
    if (username) secrets.setUsername(profileName, username);
    secrets.promptResult(profileName, password, remember);
    guard.delete(profileName);
    releaseParked(profileName);
}

function promptCancelled(profileName) {
    failParked(profileName, `password prompt for '${profileName}' cancelled`);
}

module.exports = {
    wire, requestConnect, onConnected, onConnectFailed,
    onSessionGone, onEngineRestart, profileChoice,
    promptAnswered, promptCancelled, reset, tripped,
};
