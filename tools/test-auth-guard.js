'use strict';
// Auth-guard tests: the two AD-lockout protections. A stale password must
// cost exactly one wire attempt (canary), and a tripped profile must halt
// everything without touching the network until explicitly reset.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../main/store');
const secrets = require('../main/secrets');
const flow = require('../main/connect-flow');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-guard-'));
store.init(dir);
secrets.init();

const events = [];
const launches = [];
flow.wire(
    () => {},
    (channel, payload) => events.push({ channel, payload }));

const launch = (descriptor) => launches.push(descriptor.nodeId);
const desc = (nodeId, profile) => ({
    nodeId, transport: 'ssh', host: '192.0.2.10', port: 22,
    credentialProfile: profile, jumpChain: [],
});
const statusOf = (sessionId) => events
    .filter((e) => e.channel === 'rs:evt.session-status' && e.payload.sessionId === sessionId)
    .map((e) => e.payload.state);

try {
    secrets.upsert({ name: 'AD', username: 'someone', storage: 'prompt' });

    // 1. Three connects on an uncached prompt profile: zero launches, one
    // prompt event, all three queued.
    flow.requestConnect('s1', desc('n1', 'AD'), launch);
    flow.requestConnect('s2', desc('n2', 'AD'), launch);
    flow.requestConnect('s3', desc('n3', 'AD'), launch);
    assert.strictEqual(launches.length, 0, 'nothing may hit the wire before the password');
    assert.strictEqual(events.filter((e) => e.channel === 'rs:evt.needs-password').length, 1,
        'exactly one prompt for the whole batch');

    // 2. Password arrives: exactly ONE canary launches; the rest stay parked.
    flow.promptAnswered('AD', 'hunter2');
    assert.strictEqual(launches.length, 1, `canary only, got ${launches.length}`);

    // 3. Canary succeeds: the remaining two fan out.
    flow.onConnected('s1');
    assert.strictEqual(launches.length, 3, 'batch releases after canary success');

    // 4. Auth failure trips the guard and clears the cached password.
    launches.length = 0;
    events.length = 0;
    flow.requestConnect('s4', desc('n4', 'AD'), launch);   // canary again
    flow.requestConnect('s5', desc('n5', 'AD'), launch);   // parks behind it
    assert.strictEqual(launches.length, 1);
    flow.onConnectFailed('s4', desc('n4', 'AD'), true);
    assert.ok(statusOf('s5').includes('auth-blocked'), 's5 must be halted by the trip');
    assert.strictEqual(events.filter((e) => e.channel === 'rs:evt.auth-blocked').length, 1);

    // 5. Tripped profile: new connects fail instantly, no wire, no prompt.
    launches.length = 0;
    events.length = 0;
    flow.requestConnect('s6', desc('n6', 'AD'), launch);
    assert.strictEqual(launches.length, 0, 'tripped profile must not launch');
    assert.ok(statusOf('s6').includes('auth-blocked'));
    assert.strictEqual(events.filter((e) => e.channel === 'rs:evt.needs-password').length, 0,
        'tripped profile must not even prompt');

    // 6. Reset re-arms: next connect prompts again (cache was cleared).
    events.length = 0;
    flow.reset('AD');
    flow.requestConnect('s7', desc('n7', 'AD'), launch);
    assert.strictEqual(events.filter((e) => e.channel === 'rs:evt.needs-password').length, 1,
        'after reset the stale password must be gone');

    // 7. Non-auth failure (timeout) must NOT trip the guard: the failed
    // canary hands off, and the next connect still goes out.
    flow.promptAnswered('AD', 'hunter3');   // releases s7 as canary
    flow.onConnected('s7');
    launches.length = 0;
    flow.requestConnect('s8', desc('n8', 'AD'), launch);   // canary of a new batch
    flow.onConnectFailed('s8', desc('n8', 'AD'), false);   // dead box, not bad password
    flow.requestConnect('s9', desc('n9', 'AD'), launch);
    assert.strictEqual(launches.length, 2, 'network failures must not halt the profile');

    // 7b. A parked session behind a dead-box canary takes over as canary.
    flow.onConnected('s9');
    launches.length = 0;
    flow.requestConnect('s9a', desc('n9a', 'AD'), launch);   // canary (s9 still unresolved... new batch)
    flow.requestConnect('s9b', desc('n9b', 'AD'), launch);   // parks behind it
    assert.strictEqual(launches.length, 1);
    flow.onConnectFailed('s9a', desc('n9a', 'AD'), false);   // canary times out
    assert.strictEqual(launches.length, 2, 'queue must release when the canary dies of a network error');

    // 8. An SSH session with no profile used to bypass the guard and dial
    // with blank credentials; now it parks and asks (scenario 13 covers the
    // dialog itself). Answering completes the connect.
    launches.length = 0;
    flow.requestConnect('s10', desc('n10', null), launch);
    assert.strictEqual(launches.length, 0, 'no-profile ssh must ask, not dial blank');
    flow.profileChoice('s10', { username: 'u', password: 'p' });
    assert.strictEqual(launches.length, 1, 'answering the dialog completes the connect');

    // 9. A canary that ends with NO verdict (pane closed mid-connect) must
    // not park its profile forever. s9b from 7b is exactly that stale
    // canary: prove it blocks, then prove onSessionGone recovers it.
    launches.length = 0;
    flow.requestConnect('s11', desc('n11', 'AD'), launch);
    assert.strictEqual(launches.length, 0, 's11 parks behind the stale canary');
    flow.onSessionGone('s9b');
    assert.deepStrictEqual(launches, ['n11'], 'clearing the dead canary must release the queue');

    // 10. Closing a PARKED pane removes it from the queue: the release that
    // follows must not dial a session whose pane is gone.
    launches.length = 0;
    flow.requestConnect('s12', desc('n12', 'AD'), launch);   // parks behind canary s11
    assert.strictEqual(launches.length, 0);
    flow.onSessionGone('s12');                               // user closed the pane
    flow.onConnected('s11');                                 // canary succeeds, queue releases
    assert.strictEqual(launches.length, 0, 'a closed parked pane must not be dialed');

    // 11. Engine restart: in-flight canaries died with it. Parked sessions
    // fail visibly, and the profile is immediately usable again.
    launches.length = 0;
    events.length = 0;
    flow.requestConnect('s13', desc('n13', 'AD'), launch);   // canary
    flow.requestConnect('s14', desc('n14', 'AD'), launch);   // parks
    assert.strictEqual(launches.length, 1);
    flow.onEngineRestart();
    assert.ok(statusOf('s14').includes('auth-blocked'),
        's14 must be failed visibly, not left queued forever');
    flow.requestConnect('s15', desc('n15', 'AD'), launch);
    assert.strictEqual(launches.length, 2, 'the profile must not stay parked after a restart');

    // 12. reset() recovers a stuck canary too - it is the documented escape
    // hatch, so it must clear ALL of the profile's flow state, not just the
    // trip guard.
    launches.length = 0;
    flow.requestConnect('s16', desc('n16', 'AD'), launch);   // parks behind stale canary s15
    assert.strictEqual(launches.length, 0);
    flow.reset('AD');
    assert.deepStrictEqual(launches, ['n16'], 'reset must clear the stale canary and release');
    flow.onConnected('s16');   // settle the canary so later scenarios start clean

    // 13. An SSH session with NO profile parks and asks instead of dialing
    // with blank credentials. A one-off answer launches with that auth.
    launches.length = 0;
    events.length = 0;
    const launchesWithAuth = [];
    const launchAuth = (descriptor, authByProfile, auth) =>
        launchesWithAuth.push({ nodeId: descriptor.nodeId, auth });
    flow.requestConnect('s20', { nodeId: 'n20', transport: 'ssh', host: '192.0.2.30', port: 22,
        credentialProfile: null, jumpChain: [] }, launchAuth);
    assert.strictEqual(launchesWithAuth.length, 0, 'no profile must not dial blank');
    const asked = events.filter((e) => e.channel === 'rs:evt.needs-profile');
    assert.strictEqual(asked.length, 1, 'exactly one credentials dialog');
    assert.strictEqual(asked[0].payload.sessionId, 's20');
    assert.strictEqual(asked[0].payload.missing, null, 'nothing named, nothing missing');
    flow.profileChoice('s20', { username: 'oneoff', password: 'pw' });
    assert.strictEqual(launchesWithAuth.length, 1, 'a one-off answer launches');
    assert.deepStrictEqual(launchesWithAuth[0].auth, { username: 'oneoff', password: 'pw' },
        'the one-off credentials ride the launch');

    // 14. Choosing a PROFILE re-enters the normal flow: prompt-mode profile
    // with a cached password launches as a canary like any other connect.
    launches.length = 0;
    events.length = 0;
    flow.requestConnect('s21', { nodeId: 'n21', transport: 'ssh', host: '192.0.2.31', port: 22,
        credentialProfile: null, jumpChain: [] }, launch);
    flow.profileChoice('s21', { profile: 'AD' });
    assert.strictEqual(launches.length, 1, 'profile choice launches through the guard');
    flow.onConnected('s21');

    // 15. A session naming a profile that does not exist asks the SAME
    // dialog, with the missing name called out.
    events.length = 0;
    flow.requestConnect('s22', { nodeId: 'n22', transport: 'ssh', host: '192.0.2.32', port: 22,
        credentialProfile: 'GhostProfile', jumpChain: [] }, launch);
    const missing = events.filter((e) => e.channel === 'rs:evt.needs-profile');
    assert.strictEqual(missing.length, 1);
    assert.strictEqual(missing[0].payload.missing, 'GhostProfile');

    // 16. Cancelling fails the pane visibly rather than leaving it queued.
    flow.profileChoice('s22', { cancelled: true });
    assert.ok(statusOf('s22').includes('error'), 'cancel must mark the pane failed');

    // 17. A pane closed while the dialog was open: the late answer is a
    // no-op, not a launch of a ghost session.
    launches.length = 0;
    flow.requestConnect('s23', { nodeId: 'n23', transport: 'ssh', host: '192.0.2.33', port: 22,
        credentialProfile: null, jumpChain: [] }, launch);
    flow.onSessionGone('s23');
    flow.profileChoice('s23', { profile: 'AD' });
    assert.strictEqual(launches.length, 0, 'an answer for a closed pane must not dial');

    // 18. Telnet and serial never ask - login is in-band there.
    events.length = 0;
    launches.length = 0;
    flow.requestConnect('s24', { nodeId: 'n24', transport: 'telnet', host: '192.0.2.34', port: 23,
        credentialProfile: null, jumpChain: [] }, launch);
    assert.strictEqual(launches.length, 1, 'telnet with no profile just connects');
    assert.strictEqual(events.filter((e) => e.channel === 'rs:evt.needs-profile').length, 0);

    console.log('ok - auth guard (18 scenarios: canary, trip, reset, timeout-no-trip, ' +
        'stale-canary cleanup, needs-profile dialog)');
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
