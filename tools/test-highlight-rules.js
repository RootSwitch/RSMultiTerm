'use strict';
// The shipped rule set is a product surface: it goes to every install and to
// teammates through the team file, so its patterns get real coverage. This
// replicates highlight.js compilation and first-match-wins claiming, then
// asserts what each sample line should and should not color.
//
// Sample text is fictional-estate only (RFC 5737 / RFC 3849 / example.com).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../main/store');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-hl-'));
store.init(dir);
const highlights = require('../main/highlights');

// Mirrors public/highlight.js: escape non-regex patterns, apply wholeWord,
// then claim ranges in rule order so the first match at a position wins.
function paint(rules, line) {
    const claimed = [];
    const hits = [];
    for (const r of rules) {
        if (!r.enabled) continue;
        let src = r.isRegex ? r.pattern : r.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (r.wholeWord) src = `\\b(?:${src})\\b`;
        const re = new RegExp(src, r.caseSensitive ? 'g' : 'gi');
        let m;
        while ((m = re.exec(line)) !== null) {
            if (!m[0].length) { re.lastIndex++; continue; }
            const a = m.index, b = a + m[0].length;
            if (claimed.some(([ca, cb]) => a < cb && b > ca)) continue;
            claimed.push([a, b]);
            hits.push({ text: m[0], fg: r.fg, bg: r.bg, blink: !!r.blink });
        }
    }
    return hits;
}

const C = {
    up: '#69f0ae', down: '#ff5252', warn: '#ffb74d', dim: '#9e9e9e',
    iface: '#64b5f6', fast: '#4dd0e1', sm: '#ffee58', mm: '#00e5ff', addr: '#ba68c8',
};
const OLD_ADDR = '#ce93d8';

try {
    highlights.init();
    const rules = highlights.getSets().find((s) => s.id === 'network-default').rules;

    const colored = (line, text) => paint(rules, line).find((h) => h.text === text);
    const expect = (line, text, fg, label) => {
        const hit = colored(line, text);
        assert.ok(hit, `${label}: "${text}" was not highlighted in: ${line}`);
        assert.strictEqual(hit.fg, fg, `${label}: "${text}" wrong color`);
    };
    const expectNone = (line, text, label) => {
        assert.ok(!colored(line, text), `${label}: "${text}" should not be highlighted`);
    };

    // --- interface status line -------------------------------------------
    const st = 'Gi1/0/6   legacy-scanner     connected    110          half   100M 100BaseTX';
    expect(st, 'Gi1/0/6', C.iface, 'short interface name');
    expect(st, 'connected', C.up, 'status');
    expect(st, 'half', C.down, 'half duplex is a finding');
    expect(st, '100M', C.warn, '100M on a gig port is a finding');

    const st2 = 'Te1/1/1   uplink-dc          connected    trunk        full    10G 10GBase-LR SM';
    expect(st2, 'Te1/1/1', C.iface, 'ten-gig short name');
    expect(st2, 'full', C.up, 'full duplex');
    expect(st2, '10G', C.fast, 'high speed');
    expect(st2, 'SM', C.sm, 'single-mode token');
    expect(st2, 'LR', C.sm, 'long-reach optic implies single-mode');

    const st3 = 'Twe1/1/3  core-mesh          connected    trunk        full    25G 25GBase-SR MM';
    expect(st3, 'Twe1/1/3', C.iface, 'twenty-five-gig short name');
    expect(st3, '25G', C.fast, '25G speed');
    expect(st3, 'MM', C.mm, 'multi-mode token');
    expect(st3, 'SR', C.mm, 'short-reach optic implies multi-mode');

    // Auto-negotiated forms as IOS prints them.
    const st4 = 'Gi1/0/9   ap-roof            connected    140        a-full  a-1000M 1000BaseT';
    expect(st4, 'a-full', C.up, 'negotiated duplex');
    expect(st4, 'a-1000M', C.fast, 'negotiated gigabit');

    // Severity still wins over the new rules: err-disabled keeps its blink.
    const st5 = 'Gi1/0/4   cam-lobby          err-disabled 130          auto   auto 1000BaseT';
    const errHit = colored(st5, 'err-disabled');
    assert.ok(errHit && errHit.blink, 'err-disabled must still flash');

    // --- long interface names --------------------------------------------
    const arp = 'Internet  198.51.100.7            12  0000.5e00.5307  ARPA   TenGigabitEthernet1/1/1';
    expect(arp, 'TenGigabitEthernet1/1/1', C.iface, 'long interface name');
    expect(arp, '198.51.100.7', C.addr, 'IPv4');
    expect(arp, '0000.5e00.5307', C.addr, 'Cisco dotted MAC');

    for (const [line, name] of [
        ['  Loopback0                  192.0.2.1       YES manual up', 'Loopback0'],
        ['  Port-channel10             unassigned      YES unset  up', 'Port-channel10'],
        ['  Vlan120                    192.0.2.10      YES NVRAM  up', 'Vlan120'],
        ['interface TwentyGigabitEthernet1/1/3', 'TwentyGigabitEthernet1/1/3'],
        ['interface GigabitEthernet1/0/1', 'GigabitEthernet1/0/1'],
    ]) {
        expect(line, name, C.iface, 'interface form');
    }

    // An interface name needs its number: bare words are column headers and
    // prose, not interfaces.
    expectNone('Port      Name               Status       Vlan       Duplex  Speed Type',
        'Vlan', 'status header');
    expectNone('Interface              IP-Address      OK? Method Status',
        'Interface', 'brief header');
    expectNone('Loopback interfaces are not shut', 'Loopback', 'bare word in prose');

    // --- addresses --------------------------------------------------------
    expect('ip address 192.0.2.10 255.255.255.0', '192.0.2.10', C.addr, 'IPv4');
    expect('ip route 203.0.113.0/24 next-hop 192.0.2.1', '203.0.113.0/24', C.addr, 'IPv4 with prefix');
    expect('mac address-table 0000.5e00.5301 dynamic Gi1/0/1', '0000.5e00.5301', C.addr, 'dotted MAC');
    expect('arp 00:00:5e:00:53:07 on eth0', '00:00:5e:00:53:07', C.addr, 'colon MAC');
    expect('link/ether 00-00-5e-00-53-07 brd ff-ff-ff-ff-ff-ff', '00-00-5e-00-53-07', C.addr, 'dash MAC');

    // IPv6, including :: compression - the form that matters in practice.
    expect('neighbor 2001:db8:0:1::7 lladdr', '2001:db8:0:1::7', C.addr, 'compressed IPv6');
    expect('nd fe80::1 router', 'fe80::1', C.addr, 'link-local IPv6');
    expect('ipv6 route 2001:db8::/32 null0', '2001:db8::/32', C.addr, 'IPv6 prefix');
    expect('addr 2001:0db8:85a3:0000:0000:8a2e:0370:7334 global',
        '2001:0db8:85a3:0000:0000:8a2e:0370:7334', C.addr, 'full IPv6');

    // A log timestamp must NOT read as an address - syslog is colon-heavy
    // and painting every clock purple would make log output unreadable.
    expectNone('Aug  1 23:17:12 core-sw-01 %LINK-3-UPDOWN', '23:17:12', 'timestamp');
    expectNone('*Aug  1 23:17:12.443: %SYS-5-CONFIG_I', '23:17:12.443', 'timestamp with millis');

    // --- v4: ACL verdicts, OSPF adjacency, non-zero counters ---------------
    expect('   10 permit ip any any (2041 matches)', 'permit', C.up, 'ACL permit');
    expect('   20 deny   ip any any log', 'deny', C.down, 'ACL deny');
    expect('% Access denied', 'denied', C.down, 'denied verdict');
    expect('192.0.2.9     1   FULL/DR         00:00:33    192.0.2.9    Vlan120', 'FULL', C.up, 'OSPF full adjacency (green via the duplex rule)');
    expect('192.0.2.5     1   EXSTART/DROTHER 00:00:19    192.0.2.5    Vlan120', 'EXSTART', C.warn, 'OSPF stuck adjacency');
    expect('  5 input errors, 3194 CRC, 0 frame, 0 overrun', '3194 CRC', C.warn, 'non-zero CRC counter');
    expect('  5 input errors, 3194 CRC, 0 frame, 0 overrun', '5 input errors', C.warn, 'non-zero input errors');
    expectNone('  0 input errors, 0 CRC, 0 frame, 0 overrun', '0 CRC', 'zero counters stay quiet');
    // "full" duplex (lowercase) must still be duplex-green, not OSPF's rule.
    expect('Gi1/0/6  x  connected 110 full 1G 1000BaseT', 'full', C.up, 'duplex full unaffected by OSPF rule');

    // --- migration: new rules land on an install that predates them --------
    const old = {
        schema: 1,
        sets: [{
            id: 'network-default', name: 'Network default',
            rules: [
                { pattern: 'err-disabled', isRegex: false, wholeWord: true, caseSensitive: false, fg: '#ffffff', bg: '#c62828', bold: true, blink: true, enabled: true },
                { pattern: 'MY OWN RULE', isRegex: false, wholeWord: false, caseSensitive: false, fg: '#123456', bg: null, bold: false, blink: false, enabled: true },
            ],
        }],
    };
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-hl2-'));
    fs.writeFileSync(path.join(dir2, 'highlights.json'), JSON.stringify(old));
    store.init(dir2);
    delete require.cache[require.resolve('../main/highlights')];
    const highlights2 = require('../main/highlights');
    highlights2.init();
    const migrated = highlights2.getSets().find((s) => s.id === 'network-default');

    assert.ok(migrated.rules.some((r) => r.pattern === 'MY OWN RULE'), 'user rules survive migration');
    assert.strictEqual(migrated.rules[0].pattern, 'err-disabled', 'user rule order preserved');
    assert.ok(migrated.rules.some((r) => r.pattern.includes('Base-?')), 'new rules appended');
    assert.ok(!migrated.rules.some((r) => r.pattern === '\\bdown\\b'),
        'rules the user removed from an older seed are not resurrected');
    assert.strictEqual(migrated.seedVersion, 4, 'seed version recorded');
    // Arriving from seed 1 must land on the corrected pattern, not the one
    // that was later fixed up.
    assert.ok(migrated.rules.some((r) => r.pattern.includes('Tunnel)\\d+')),
        'a fresh migration seeds the corrected interface pattern');
    // ...and on the corrected color: the v2 batch seeds with the darker
    // purple directly, not the old one plus a fixup pass.
    assert.ok(migrated.rules.some((r) => r.fg === C.addr),
        'a fresh migration seeds the darker address purple');
    assert.ok(!migrated.rules.some((r) => r.fg === OLD_ADDR),
        'the superseded purple never appears in a fresh migration');
    assert.ok(migrated.rules.some((r) => r.pattern.includes('permit')),
        'v4 batch (permit/deny) appended');

    // Second init is a no-op: migrations must not duplicate rules.
    const before = migrated.rules.length;
    highlights2.init();
    assert.strictEqual(highlights2.getSets().find((s) => s.id === 'network-default').rules.length,
        before, 'migration is idempotent');
    fs.rmSync(dir2, { recursive: true, force: true });

    // --- fixup: an install already on seed 2 gets the pattern corrected ----
    const V2_LONG = '\\b(?:GigabitEthernet|TenGigabitEthernet|TwentyGigabitEthernet|TwoGigabitEthernet|FastEthernet|FortyGigabitEthernet|HundredGigabitEthernet|FortyGigE|HundredGigE|Port-channel|Loopback|Vlan|Tunnel)\\d*(?:/\\d+)*(?:\\.\\d+)?\\b';
    const seeded2 = (rules) => ({
        schema: 1,
        sets: [{ id: 'network-default', name: 'Network default', seedVersion: 2, rules }],
    });

    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-hl3-'));
    fs.writeFileSync(path.join(dir3, 'highlights.json'), JSON.stringify(seeded2([
        { pattern: V2_LONG, isRegex: true, wholeWord: false, caseSensitive: true, fg: '#64b5f6', bg: null, bold: false, blink: false, enabled: true },
    ])));
    store.init(dir3);
    delete require.cache[require.resolve('../main/highlights')];
    const highlights3 = require('../main/highlights');
    highlights3.init();
    const fixed = highlights3.getSets().find((s) => s.id === 'network-default');
    assert.ok(fixed.rules[0].pattern.includes('Tunnel)\\d+'), 'shipped rule corrected in place');
    assert.strictEqual(fixed.seedVersion, 4, 'seed version advanced');
    // The v4 batch appends behind the user's rules; the fixup itself adds
    // nothing (the corrected rule is still rules[0]).
    const v4Count = fixed.rules.length - 1;
    assert.ok(v4Count > 0 && fixed.rules.slice(1).some((r) => r.pattern.includes('permit')),
        'v4 batch appended below the existing rules');
    fs.rmSync(dir3, { recursive: true, force: true });

    // --- color fixup: unedited address rules get the darker purple, a
    // user-picked color on the same pattern is left alone -----------------
    const IPV4 = '\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?:/\\d{1,2})?\\b';
    const seeded3 = (rules) => ({
        schema: 1,
        sets: [{ id: 'network-default', name: 'Network default', seedVersion: 3, rules }],
    });
    const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-hl5-'));
    fs.writeFileSync(path.join(dir5, 'highlights.json'), JSON.stringify(seeded3([
        { pattern: IPV4, isRegex: true, wholeWord: false, caseSensitive: false, fg: OLD_ADDR, bg: null, bold: false, blink: false, enabled: true },
    ])));
    store.init(dir5);
    delete require.cache[require.resolve('../main/highlights')];
    const highlights5 = require('../main/highlights');
    highlights5.init();
    assert.strictEqual(
        highlights5.getSets().find((s) => s.id === 'network-default').rules[0].fg, C.addr,
        'unedited shipped color is corrected to the darker purple');
    fs.rmSync(dir5, { recursive: true, force: true });

    const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-hl6-'));
    fs.writeFileSync(path.join(dir6, 'highlights.json'), JSON.stringify(seeded3([
        { pattern: IPV4, isRegex: true, wholeWord: false, caseSensitive: false, fg: '#00ff00', bg: null, bold: false, blink: false, enabled: true },
    ])));
    store.init(dir6);
    delete require.cache[require.resolve('../main/highlights')];
    const highlights6 = require('../main/highlights');
    highlights6.init();
    assert.strictEqual(
        highlights6.getSets().find((s) => s.id === 'network-default').rules[0].fg, '#00ff00',
        'a user-picked color on an unedited pattern survives the color fixup');
    fs.rmSync(dir6, { recursive: true, force: true });

    // ...but an edited rule is the user's, and a fixup must not touch it.
    const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmt-hl4-'));
    const EDITED = V2_LONG.replace('#', '') + '|MyCustomIface\\d+';
    fs.writeFileSync(path.join(dir4, 'highlights.json'), JSON.stringify(seeded2([
        { pattern: EDITED, isRegex: true, wholeWord: false, caseSensitive: true, fg: '#ff00ff', bg: null, bold: false, blink: false, enabled: true },
    ])));
    store.init(dir4);
    delete require.cache[require.resolve('../main/highlights')];
    const highlights4 = require('../main/highlights');
    highlights4.init();
    const untouched = highlights4.getSets().find((s) => s.id === 'network-default');
    assert.strictEqual(untouched.rules[0].pattern, EDITED, 'edited rule survives a fixup untouched');
    assert.strictEqual(untouched.rules[0].fg, '#ff00ff', 'edited color survives too');
    fs.rmSync(dir4, { recursive: true, force: true });
    console.log(`ok - highlight rules (${rules.length} shipped rules, colors, and seed migration)`);
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
