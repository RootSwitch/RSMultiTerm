'use strict';
// The OpenSSH-config and PuTTY importers. The parsers are where the bugs
// would live - ssh_config's first-match-wins rule is the one everyone gets
// backwards, and `reg query` output is a format nobody reads twice - so
// they are tested as pure functions over fixture text.

const assert = require('assert');
const os = require('os');
const imp = require('../main/ssh-import');

const HOME = os.homedir();

// --- ssh_config -------------------------------------------------------------

{
    // 1. The rule everyone gets backwards: the FIRST matching value wins,
    // including a Host * default that appears BEFORE the specific block.
    const report = imp.parseSshConfig(`
# lab boxes
Host *
    User defaultuser
    Port 2200

Host web1 web2
    HostName 10.0.0.10
    User webuser

Host db1
    HostName db.internal
`, HOME);
    const names = report.sessions.map((s) => s.name).sort();
    assert.deepStrictEqual(names, ['db1', 'web1', 'web2'],
        'wildcard stanzas contribute options but are not sessions');
    const web1 = report.sessions.find((s) => s.name === 'web1');
    assert.strictEqual(web1.host, '10.0.0.10');
    assert.strictEqual(web1.username, 'defaultuser',
        'Host * appears FIRST, so its User wins over the later specific one - ssh semantics');
    assert.strictEqual(web1.port, 2200);
    const db1 = report.sessions.find((s) => s.name === 'db1');
    assert.strictEqual(db1.host, 'db.internal');
    assert.strictEqual(db1.username, 'defaultuser');
    assert.strictEqual(report.usernames.defaultuser, 3);
}

{
    // 2. The common layout - specifics first, defaults last - gives the
    // specific values, same rule, other direction.
    const report = imp.parseSshConfig(`
Host jump
    HostName bastion.example
    User netops

Host core-sw
    HostName 10.50.0.1
    ProxyJump jump
    IdentityFile ~/.ssh/lab_ed25519

Host *
    User fallback
`, HOME);
    const core = report.sessions.find((s) => s.name === 'core-sw');
    assert.strictEqual(core.username, 'fallback',
        'no User in the specific block: the * default applies');
    assert.strictEqual(core.jumpAlias, 'jump');
    assert.ok(core.keyPath.endsWith('lab_ed25519'), 'IdentityFile is carried');
    assert.ok(!core.keyPath.startsWith('~'), '~ expands to the home directory');
    const jump = report.sessions.find((s) => s.name === 'jump');
    assert.strictEqual(jump.username, 'netops',
        'the specific block is FIRST for jump, so its User wins');
}

{
    // 3. Negation: !pattern excludes a host from a wildcard stanza.
    const report = imp.parseSshConfig(`
Host * !secret-box
    User everyone

Host secret-box
    HostName 10.9.9.9

Host normal-box
    HostName 10.1.1.1
`, HOME);
    assert.strictEqual(report.sessions.find((s) => s.name === 'secret-box').username, null,
        'a negated pattern must exclude the host from the stanza');
    assert.strictEqual(report.sessions.find((s) => s.name === 'normal-box').username, 'everyone');
}

{
    // 4. Match and Include are not silently mis-imported: skipped, and the
    // report says so.
    const report = imp.parseSshConfig(`
Match host *.prod
    User produser
Include ~/.ssh/config.d/*
Host plain
    HostName 10.2.2.2
`, HOME);
    assert.strictEqual(report.sessions.find((s) => s.name === 'plain').username, null,
        'options inside a Match block must not leak into imports');
    assert.ok(report.warnings.some((w) => /Match block/.test(w)), 'Match is reported');
    assert.ok(report.warnings.some((w) => /Include/.test(w)), 'Include is reported');
}

{
    // 5. Multi-hop ProxyJump flattens to the LAST hop, with a warning; the
    // hop reference strips user@ and :port.
    const report = imp.parseSshConfig(`
Host deep
    HostName 10.3.3.3
    ProxyJump ops@outer.example:2222, inner
Host inner
    HostName inner.example
`, HOME);
    const deep = report.sessions.find((s) => s.name === 'deep');
    assert.strictEqual(deep.jumpAlias, 'inner');
    assert.ok(report.warnings.some((w) => /multi-hop/.test(w)));
    // ...and single-hop with decoration strips too.
    const r2 = imp.parseSshConfig('Host a\n  ProxyJump ops@jump.example:2222\n', HOME);
    assert.strictEqual(r2.sessions[0].jumpAlias, 'jump.example');
}

// --- PuTTY ------------------------------------------------------------------

const REG_FIXTURE = [
    'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Default%20Settings',
    '    Protocol    REG_SZ    ssh',
    '',
    'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\core%20switch',
    '    HostName    REG_SZ    10.50.0.1',
    '    PortNumber    REG_DWORD    0x16',
    '    Protocol    REG_SZ    ssh',
    '    UserName    REG_SZ    netops',
    '    PublicKeyFile    REG_SZ    C:\\keys\\lab.ppk',
    '',
    'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\old%20router',
    '    HostName    REG_SZ    10.50.0.254',
    '    PortNumber    REG_DWORD    0x17',
    '    Protocol    REG_SZ    telnet',
    '',
    'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\console',
    '    Protocol    REG_SZ    serial',
    '    SerialLine    REG_SZ    COM3',
    '    SerialSpeed    REG_DWORD    0x2580',
    '',
    'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\pi%20raw',
    '    HostName    REG_SZ    10.50.0.7',
    '    PortNumber    REG_DWORD    0x1F90',
    '    Protocol    REG_SZ    raw',
    '',
    'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\mainframe',
    '    HostName    REG_SZ    10.50.0.99',
    '    Protocol    REG_SZ    rlogin',
].join('\r\n');

{
    const report = imp.parsePuttyReg(REG_FIXTURE);
    const byName = Object.fromEntries(report.sessions.map((s) => [s.name, s]));
    assert.ok(!byName['Default Settings'], "PuTTY's defaults entry is not a session");
    assert.deepStrictEqual(Object.keys(byName).sort(),
        ['console', 'core switch', 'old router', 'pi raw'],
        'names are URL-decoded; rlogin is skipped');
    assert.strictEqual(byName['core switch'].host, '10.50.0.1');
    assert.strictEqual(byName['core switch'].port, null, '0x16 = 22 = the SSH default, elided');
    assert.strictEqual(byName['core switch'].username, 'netops');
    assert.strictEqual(report.keyByUsername.netops, 'C:\\keys\\lab.ppk');
    assert.strictEqual(byName['old router'].transport, 'telnet');
    assert.strictEqual(byName['old router'].port, null, '0x17 = 23 = the telnet default');
    assert.deepStrictEqual(byName.console.serial, { device: 'COM3', baud: 9600 },
        '0x2580 = 9600 baud');
    assert.strictEqual(byName['pi raw'].transport, 'telnet');
    assert.strictEqual(byName['pi raw'].rawTcp, true, 'raw imports as raw TCP');
    assert.strictEqual(byName['pi raw'].port, 8080);
    assert.deepStrictEqual(report.skipped.map((s) => s.type), ['rlogin']);
}

// --- toNodes ----------------------------------------------------------------

{
    // Jump hosts wire by alias AFTER ids exist; a hop that was not imported
    // leaves the session dialing direct; usernames map to profiles.
    const report = imp.parseSshConfig(`
Host jump
    HostName bastion.example
    User netops
Host sw1
    HostName 10.50.0.1
    User netops
    ProxyJump jump
Host lonely
    HostName 10.60.0.1
    ProxyJump not-imported.example
`, HOME);
    const nodes = imp.toNodes(report, { netops: 'AD Account' }, 'Test Import');
    const list = Object.values(nodes);
    const root = list.find((n) => n.type === 'folder');
    assert.strictEqual(root.name, 'Test Import');
    const sw1 = list.find((n) => n.name === 'sw1');
    const jump = list.find((n) => n.name === 'jump');
    const lonely = list.find((n) => n.name === 'lonely');
    assert.strictEqual(sw1.jumpHost, jump.id, 'the jump reference resolves to the imported node');
    assert.strictEqual(lonely.jumpHost, null, 'an unimported hop cannot be referenced');
    assert.strictEqual(sw1.credentialProfile, 'AD Account');
    assert.strictEqual(lonely.credentialProfile, null);
    for (const n of list.filter((x) => x.type === 'session')) {
        assert.strictEqual(n.parentId, root.id);
        assert.ok(!('username' in n), 'usernames never land on nodes - profiles only');
    }
}

console.log('ok - ssh/putty import (first-match-wins, negation, Match/Include reported, ' +
    'ProxyJump wiring, reg parsing incl. raw/serial/dword, profile mapping)');
