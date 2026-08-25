'use strict';
// Credential host scope: which hosts a stored profile may be sent to.
//
// This is the check that closes S1 from the 2026-08-25 review. getAuth()
// took a profile name and nothing else, so main decrypted a stored AD
// password without knowing where it was going - and a renderer that can
// name a host (rs:tree.upsert can) could have it delivered anywhere. The
// fingerprint dialog is no defense, because the renderer draws it AND
// answers its own rs:hostkey.answer; the decision has to be one main makes
// alone, from data the renderer cannot write.
//
// So the matcher is the security boundary, and it is attacked here rather
// than merely demonstrated. The rule throughout: anything unparseable is a
// NON-match. A scope that fails open is not a scope.

const assert = require('assert');
const scope = require('../main/cred-scope');

// --- exact and case ---------------------------------------------------------
assert.ok(scope.matches('10.50.1.7', '10.50.1.7'));
assert.ok(scope.matches('Sw-Core-01', 'sw-core-01'), 'host matching is case-insensitive');
assert.ok(scope.matches('sw-core-01', 'SW-CORE-01'));
assert.ok(!scope.matches('10.50.1.7', '10.50.1.70'),
    'an exact pattern must not match a longer address that starts the same');
assert.ok(!scope.matches('10.50.1.7', '110.50.1.7'));

// --- CIDR -------------------------------------------------------------------
assert.ok(scope.matches('10.50.0.0/16', '10.50.1.7'));
assert.ok(scope.matches('10.50.0.0/16', '10.50.255.255'));
assert.ok(!scope.matches('10.50.0.0/16', '10.51.0.1'), 'outside the range is outside');
assert.ok(scope.matches('192.168.1.0/24', '192.168.1.99'));
assert.ok(!scope.matches('192.168.1.0/24', '192.168.2.1'));
assert.ok(scope.matches('10.50.1.7/32', '10.50.1.7'), '/32 is a single host');
assert.ok(!scope.matches('10.50.1.7/32', '10.50.1.8'));
assert.ok(scope.matches('0.0.0.0/0', '203.0.113.9'), '/0 is everything, if someone means it');
// A hostname is never resolved to test a CIDR: DNS is answered by someone
// else, and a scope that widens on a lookup is not a scope.
assert.ok(!scope.matches('10.50.0.0/16', 'sw-core-01.corp.local'),
    'a CIDR must not match a NAME - that would put the boundary in DNS');
assert.ok(!scope.matches('10.50.0.0/33', '10.50.1.7'), 'an impossible prefix matches nothing');
assert.ok(!scope.matches('10.50.0.0/16', '10.50.1'), 'a malformed address is not inside anything');
assert.ok(!scope.matches('999.1.1.1/8', '999.1.1.1'), 'octets above 255 are not an address');

// --- wildcards --------------------------------------------------------------
assert.ok(scope.matches('*.corp.local', 'sw-core-01.corp.local'));
assert.ok(scope.matches('*.corp.local', 'a.b.corp.local'), 'a wildcard spans labels');
assert.ok(!scope.matches('*.corp.local', 'corp.local'),
    'the parent domain is not a host under it');
assert.ok(!scope.matches('*.corp.local', 'sw.corp.local.evil.com'),
    'a suffix wildcard must be anchored at the END');
assert.ok(scope.matches('10.50.1.*', '10.50.1.7'));
assert.ok(!scope.matches('10.50.1.*', '10.50.2.7'));
// The dots in a pattern are literal, not regex any-char - or '*.corpXlocal'
// would pass a scope written for corp.local.
assert.ok(!scope.matches('*.corp.local', 'swXcorpXlocal'),
    'dots in a pattern must be literal');
assert.ok(!scope.matches('sw-01.corp.local', 'swX01XcorpXlocal'));

// --- the whole check --------------------------------------------------------
// Empty means unrestricted: every profile that exists today has no scope,
// and refusing them all on upgrade would be worse than the risk.
assert.strictEqual(scope.allows([], 'anything.example'), true);
assert.strictEqual(scope.allows(undefined, 'anything.example'), true);
assert.strictEqual(scope.allows(null, 'anything.example'), true);

const mgmt = ['10.50.0.0/16', '*.corp.local'];
assert.strictEqual(scope.allows(mgmt, '10.50.1.7'), true);
assert.strictEqual(scope.allows(mgmt, 'sw-core-01.corp.local'), true);
// THE assertion: the attack from the review. A renderer that names its own
// host gets nothing, with no dialog anywhere in the path.
assert.strictEqual(scope.allows(mgmt, 'attacker.example'), false);
assert.strictEqual(scope.allows(mgmt, '203.0.113.9'), false);
// No host at all is not a free pass either - a caller with nothing to
// declare is a caller that should not be releasing a secret.
assert.strictEqual(scope.allows(mgmt, ''), false);
assert.strictEqual(scope.allows(mgmt, undefined), false);
assert.strictEqual(scope.allows(mgmt, null), false);

// --- parsing ----------------------------------------------------------------
assert.deepStrictEqual(scope.parse('10.50.0.0/16 *.corp.local'), ['10.50.0.0/16', '*.corp.local']);
assert.deepStrictEqual(scope.parse('  10.50.1.7 ,, 10.50.1.7  '), ['10.50.1.7'],
    'duplicates and separators collapse');
assert.deepStrictEqual(scope.parse('SW-CORE-01'), ['sw-core-01'], 'stored lowercase');
assert.deepStrictEqual(scope.parse(''), []);
assert.deepStrictEqual(scope.parse(null), []);
// A pattern that cannot match anything must be refused at the point of
// typing - stored, it would look like a rule while protecting nothing.
assert.throws(() => scope.parse('10.50.0.0/99'), /not a valid CIDR/);
assert.throws(() => scope.parse('10.50.0.0/16 300.1.1.1/8'), /not a valid CIDR/);
assert.throws(() => scope.parse('sw core"01'), /not a valid host pattern/);
assert.throws(() => scope.parse('ssh://sw-01'), /not a valid host pattern/);

// --- the enforcement point --------------------------------------------------
// getAuth must REFUSE rather than return a secret, and must do it without
// consulting anything the renderer sent.
{
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-scope-'));
    require('../main/store').init(dir);
    const secrets = require('../main/secrets');
    secrets.init();
    secrets.upsert({
        name: 'AD Account', username: 'netadmin', authMethod: 'password',
        storage: 'prompt', hostScope: '10.50.0.0/16 *.corp.local',
    });
    // Prompt-mode with nothing cached returns null (needs a prompt) - so
    // cache one, which is what a connected session does.
    secrets.promptResult('AD Account', 'hunter2');

    const inScope = secrets.getAuth('AD Account', '10.50.1.7');
    assert.ok(inScope && inScope.password === 'hunter2', 'an in-scope host gets the credential');

    const refused = secrets.getAuth('AD Account', 'attacker.example');
    assert.ok(refused && refused.outOfScope, 'an out-of-scope host is refused');
    assert.strictEqual(refused.password, undefined,
        'and the refusal carries NO credential material');
    assert.strictEqual(refused.host, 'attacker.example', 'the refusal names the host');

    const noHost = secrets.getAuth('AD Account');
    assert.ok(noHost && noHost.outOfScope,
        'a caller that names no host must be refused, not defaulted through');

    // A profile with no scope still works exactly as before.
    secrets.upsert({ name: 'Lab', username: 'lab', authMethod: 'password', storage: 'prompt' });
    secrets.promptResult('Lab', 'lab');
    assert.ok(secrets.getAuth('Lab', 'anything.example').password === 'lab',
        'an unscoped profile is unrestricted, so upgrades do not break');

    // The scope survives a round trip through the renderer-facing view,
    // which is how the editor shows it back.
    const shown = secrets.list().find((p) => p.name === 'AD Account');
    assert.deepStrictEqual(shown.hostScope, ['10.50.0.0/16', '*.corp.local']);
    assert.strictEqual(shown.secretDpapi, undefined, 'and still leaks no secret material');

    fs.rmSync(dir, { recursive: true, force: true });
}

console.log('ok - credential host scope (exact/CIDR/wildcard matching, fail-closed parsing, ' +
    'getAuth refuses out-of-scope hosts without decrypting)');
