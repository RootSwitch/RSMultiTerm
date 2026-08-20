'use strict';
// Highlight rule sets. Stored locally, shareable later via the team file
// (rule sets contain no secrets). The shipped "Network default" set is
// written on first run so the flagship feature works out of the box; it is
// a normal editable set after that, not a hardcoded layer.

const store = require('./store');

let data = null;
const listeners = [];

// The shipped set evolves after installs exist, so it carries a seed
// version. init() walks an install from its recorded version to the current
// one, applying two kinds of step: batches of new rules (appended, so they
// sit below anything the user has ordered) and fixups to already-seeded
// rules. Neither ever touches a rule the user edited, and a batch is applied
// only to installs older than it, so a rule someone deleted is not
// resurrected by a later unrelated update.
const SEED_VERSION = 4;

// Long interface names required only an optional number, so the bare column
// header "Vlan" colored as if it were an interface. Kept verbatim as the
// fixup key: it matches only installs still carrying the shipped text.
const LONG_IFACE_V2 = '\\b(?:GigabitEthernet|TenGigabitEthernet|TwentyGigabitEthernet|TwoGigabitEthernet|FastEthernet|FortyGigabitEthernet|HundredGigabitEthernet|FortyGigE|HundredGigE|Port-channel|Loopback|Vlan|Tunnel)\\d*(?:/\\d+)*(?:\\.\\d+)?\\b';
const LONG_IFACE_V3 = '\\b(?:GigabitEthernet|TenGigabitEthernet|TwentyGigabitEthernet|TwoGigabitEthernet|FastEthernet|FortyGigabitEthernet|HundredGigabitEthernet|FortyGigE|HundredGigE|Port-channel|Loopback|Vlan|Tunnel)\\d+(?:/\\d+)*(?:\\.\\d+)?\\b';

// Address patterns double as fixup keys for the v4 color correction.
const MAC_PATTERN = '\\b[0-9a-f]{4}\\.[0-9a-f]{4}\\.[0-9a-f]{4}\\b|\\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\\b';
const IPV4_PATTERN = '\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?:/\\d{1,2})?\\b';
const IPV6_PATTERN = '(?<![\\w:.])(?:(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:)*[0-9a-f]{1,4}::(?:[0-9a-f]{1,4}:)*[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:)+:|::(?:[0-9a-f]{1,4}:)*[0-9a-f]{1,4})(?:/\\d{1,3})?(?![\\w:.])';

// Address purple, one step darker as of v4 (#ce93d8 before). The floor is
// the display-time contrast correction: anything below ~4:1 against the
// default dark background gets brightened back at paint time, and #ba68c8
// sits at ~4.7:1 - the darkest purple that stays put.
const ADDR_PURPLE_V2 = '#ce93d8';
const ADDR_PURPLE_V4 = '#ba68c8';

const V2_RULES = [
    // Duplex: full is healthy, half is a finding.
    { pattern: '\\b(?:a-)?full\\b', isRegex: true, wholeWord: false, caseSensitive: false, fg: '#69f0ae', bg: null, bold: false, blink: false, enabled: true },
    { pattern: '\\b(?:a-)?half\\b', isRegex: true, wholeWord: false, caseSensitive: false, fg: '#ff5252', bg: null, bold: true, blink: false, enabled: true },
    // Interface speeds: 10M/100M amber (a gig port at 100M is usually a
    // problem), gigabit and up cyan.
    { pattern: '\\b(?:a-)?(?:10|100)M\\b', isRegex: true, wholeWord: false, caseSensitive: false, fg: '#ffb74d', bg: null, bold: true, blink: false, enabled: true },
    { pattern: '\\b(?:a-)?(?:1000M|(?:1|2\\.5|5|10|25|40|100)G)\\b', isRegex: true, wholeWord: false, caseSensitive: false, fg: '#4dd0e1', bg: null, bold: false, blink: false, enabled: true },
    // Transceiver reach: single-mode yellow, multi-mode aqua - both the
    // literal SM/MM tokens and the optic codes that imply them.
    { pattern: '\\b(?:SM|SMF)\\b|(?<=Base-?)(?:LX|LR|LH|EX|ER|ZR)\\b', isRegex: true, wholeWord: false, caseSensitive: true, fg: '#ffee58', bg: null, bold: false, blink: false, enabled: true },
    { pattern: '\\b(?:MM|MMF)\\b|(?<=Base-?)(?:SX|SR)\\b', isRegex: true, wholeWord: false, caseSensitive: true, fg: '#00e5ff', bg: null, bold: false, blink: false, enabled: true },
    // Interface names, short and long forms (Gi1/0/1, Twe1/1/3, Loopback0,
    // Port-channel10, Vlan120...). Both require the number, so the bare
    // words "Vlan" and "Loopback" - column headers, prose in a banner - are
    // left alone.
    { pattern: '\\b(?:Gi|Te|Twe|Two|Fa|Fo|Hu|Po|Lo|Vl|Tu)\\d+(?:/\\d+)*(?:\\.\\d+)?\\b', isRegex: true, wholeWord: false, caseSensitive: true, fg: '#64b5f6', bg: null, bold: false, blink: false, enabled: true },
    { pattern: LONG_IFACE_V3, isRegex: true, wholeWord: false, caseSensitive: true, fg: '#64b5f6', bg: null, bold: false, blink: false, enabled: true },
    // MAC addresses (Cisco dotted, colon, dash forms) then IPs, all purple.
    // MAC precedes IPv6 so colon-form MACs are claimed before the looser
    // IPv6 pattern can bite them. Purple is a DELIBERATE divergence from
    // the community's weak cyan-for-IPs plurality: interfaces here are
    // already blue/cyan, and purple keeps address-vs-interface separable
    // at a glance - the cyan-everything packs lose that.
    { pattern: MAC_PATTERN, isRegex: true, wholeWord: false, caseSensitive: false, fg: ADDR_PURPLE_V4, bg: null, bold: false, blink: false, enabled: true },
    { pattern: IPV4_PATTERN, isRegex: true, wholeWord: false, caseSensitive: false, fg: ADDR_PURPLE_V4, bg: null, bold: false, blink: false, enabled: true },
    // IPv6, both full and :: compressed. Deliberately needs either a "::" or
    // four-plus groups, so a log timestamp (23:17:12) is not painted as an
    // address - syslog is colon-heavy and that false positive would make
    // real log output unreadable.
    { pattern: IPV6_PATTERN, isRegex: true, wholeWord: false, caseSensitive: false, fg: ADDR_PURPLE_V4, bg: null, bold: false, blink: false, enabled: true },
];

// v4: the two things the community packs actually agree on that were
// missing. ACL verdicts (permit green / deny red - unanimous among packs
// that have them) and feralpacket's non-zero-counter refinement: "0 CRC" is
// healthy noise, "3194 CRC" is the line being hunted for. Plus OSPF
// adjacency states to match the BGP treatment already shipped.
const V4_RULES = [
    { pattern: '\\bpermit(?:ted)?\\b', isRegex: true, wholeWord: false, caseSensitive: false, fg: '#69f0ae', bg: null, bold: false, blink: false, enabled: true },
    { pattern: '\\bden(?:y|ied)\\b', isRegex: true, wholeWord: false, caseSensitive: false, fg: '#ff5252', bg: null, bold: false, blink: false, enabled: true },
    // OSPF stuck states only: healthy FULL is already claimed green by the
    // earlier (first-match-wins) duplex rule's case-insensitive "full".
    { pattern: '\\b(?:EXSTART|EXCHANGE|LOADING|INIT)\\b', isRegex: true, wholeWord: false, caseSensitive: true, fg: '#ffb74d', bg: null, bold: false, blink: false, enabled: true },
    { pattern: '\\b[1-9]\\d*\\s+(?:input errors|output errors|CRC|collisions|late collision|overruns?|underruns?|runts|giants|throttles)\\b', isRegex: true, wholeWord: false, caseSensitive: false, fg: '#ffb74d', bg: null, bold: true, blink: false, enabled: true },
];

const DEFAULT_SET = {
    id: 'network-default',
    name: 'Network default',
    seedVersion: SEED_VERSION,
    rules: [
        // Order matters: first match at a position wins, so the specific
        // (err-disabled, administratively down) precede the generic (down).
        { pattern: 'err-disabled', isRegex: false, wholeWord: true, caseSensitive: false, fg: '#ffffff', bg: '#c62828', bold: true, blink: true, enabled: true },
        { pattern: 'administratively down', isRegex: false, wholeWord: false, caseSensitive: false, fg: '#ff8a80', bg: null, bold: true, blink: false, enabled: true },
        { pattern: 'notconnect', isRegex: false, wholeWord: true, caseSensitive: false, fg: '#ffb74d', bg: null, bold: false, blink: false, enabled: true },
        { pattern: '\\bdown\\b', isRegex: true, wholeWord: false, caseSensitive: false, fg: '#ff5252', bg: null, bold: true, blink: false, enabled: true },
        { pattern: '\\b(up|connected)\\b', isRegex: true, wholeWord: false, caseSensitive: false, fg: '#69f0ae', bg: null, bold: false, blink: false, enabled: true },
        { pattern: '\\bdisabled\\b', isRegex: true, wholeWord: false, caseSensitive: false, fg: '#9e9e9e', bg: null, bold: false, blink: false, enabled: true },
        { pattern: '%LINK-\\d-\\w+|%LINEPROTO-\\d-\\w+', isRegex: true, wholeWord: false, caseSensitive: false, fg: '#ffb74d', bg: null, bold: true, blink: false, enabled: true },
        { pattern: '%\\w+-[0-3]-\\w+', isRegex: true, wholeWord: false, caseSensitive: false, fg: '#ffffff', bg: '#b71c1c', bold: true, blink: false, enabled: true },
        { pattern: '\\b(Idle|Active|Connect)\\b(?=.*\\bBGP\\b)|\\bBGP\\b.*\\b(Idle|Active|Connect)\\b', isRegex: true, wholeWord: false, caseSensitive: true, fg: '#ff5252', bg: null, bold: true, blink: false, enabled: true },
        { pattern: '\\bEstablished\\b', isRegex: true, wholeWord: false, caseSensitive: true, fg: '#69f0ae', bg: null, bold: false, blink: false, enabled: true },
        { pattern: 'duplex mismatch', isRegex: false, wholeWord: false, caseSensitive: false, fg: '#ffb74d', bg: null, bold: true, blink: false, enabled: true },
        { pattern: '% ?Invalid input|% ?Incomplete command|% ?Ambiguous command', isRegex: true, wholeWord: false, caseSensitive: false, fg: '#ff8a80', bg: null, bold: false, blink: false, enabled: true },
        { pattern: '\\bBLK\\b|BPDU [Gg]uard', isRegex: true, wholeWord: false, caseSensitive: true, fg: '#ffb74d', bg: null, bold: false, blink: false, enabled: true },
        ...V2_RULES,
        ...V4_RULES,
    ],
};

// New rules by the seed version that introduced them.
const SEED_BATCHES = {
    2: V2_RULES,
    4: V4_RULES,
};

// Corrections to rules seeded earlier, by the version that fixes them. A
// fixup lands only when the rule still carries exactly the shipped pattern -
// once someone edits a rule it is theirs, and an update must not overwrite
// it. Color corrections (fromFg/toFg) are gated the same way on the
// shipped COLOR too: a rule whose pattern is untouched but whose color
// the user picked stays the user's.
const SEED_FIXUPS = {
    3: [{ from: LONG_IFACE_V2, to: LONG_IFACE_V3 }],
    4: [
        { from: MAC_PATTERN, fromFg: ADDR_PURPLE_V2, toFg: ADDR_PURPLE_V4 },
        { from: IPV4_PATTERN, fromFg: ADDR_PURPLE_V2, toFg: ADDR_PURPLE_V4 },
        { from: IPV6_PATTERN, fromFg: ADDR_PURPLE_V2, toFg: ADDR_PURPLE_V4 },
    ],
};

function init() {
    data = store.load('highlights', null);
    if (!data) {
        data = { schema: 1, sets: [DEFAULT_SET] };
        store.save('highlights', data);
        return;
    }
    const def = data.sets.find((s) => s.id === DEFAULT_SET.id);
    const from = def ? (def.seedVersion || 1) : SEED_VERSION;
    if (!def || from >= SEED_VERSION) return;

    for (let v = from + 1; v <= SEED_VERSION; v++) {
        const have = new Set(def.rules.map((r) => r.pattern));
        for (const rule of SEED_BATCHES[v] || []) {
            if (!have.has(rule.pattern)) def.rules.push({ ...rule });
        }
        for (const fix of SEED_FIXUPS[v] || []) {
            const target = def.rules.find((r) => r.pattern === fix.from);
            if (!target) continue;
            if (fix.to) target.pattern = fix.to;
            if (fix.toFg && target.fg === fix.fromFg) target.fg = fix.toFg;
        }
    }
    def.seedVersion = SEED_VERSION;
    store.save('highlights', data);
}

function onChange(fn) { listeners.push(fn); }

function getSets() { return data.sets; }

function saveSets(sets) {
    // Structural validation only - a bad regex is caught renderer-side at
    // compile and simply disables that rule with a visible marker.
    if (!Array.isArray(sets)) throw new Error('sets must be an array');
    data.sets = sets;
    store.save('highlights', data);
    for (const fn of listeners) fn();
}

module.exports = { init, onChange, getSets, saveSets };
