'use strict';
// Importers for the two places a Windows homelabber's sessions already
// live: OpenSSH's ~/.ssh/config and PuTTY's registry hive. Both produce
// the same report shape the MobaXTerm importer established, so all three
// share one wizard: sessions plus an aggregated username map, because
// usernames are converted to credential-profile references on the way in,
// never stored on nodes.
//
// The parsers are pure functions over text - the ssh_config grammar and
// the `reg query` output format both have enough corners that they need
// tests, and tests need to not read this machine's real config.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const sessionStore = require('./session-store');

// --- OpenSSH client config --------------------------------------------------

// ssh_config host patterns: * and ? wildcards, ! negation. A list matches
// when at least one positive pattern matches and no negated one does.
function hostMatches(alias, patterns) {
    let matched = false;
    for (const raw of patterns) {
        const neg = raw.startsWith('!');
        const pat = neg ? raw.slice(1) : raw;
        const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
        if (re.test(alias)) {
            if (neg) return false;
            matched = true;
        }
    }
    return matched;
}

// ~ and %d expand to the home directory; %u to the user. Enough for
// IdentityFile lines in the wild; anything fancier survives as-is and the
// profile editor will show it.
function expandPath(p, home) {
    return String(p).replace(/^~(?=$|[/\\])/, home).replace(/%d/g, home)
        .replace(/%u/g, process.env.USERNAME || process.env.USER || '');
}

function parseSshConfig(text, home) {
    const lines = String(text).split(/\r?\n/);
    // Stanzas in file order: {patterns, options: {key: firstValue}}.
    const stanzas = [];
    let current = null;
    const warnings = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        // `Port 2222` and `Port=2222` are both legal ssh_config: the man
        // page allows the separator to be whitespace OR an equals sign,
        // optionally surrounded by whitespace. Requiring whitespace meant
        // an equals-form line was silently skipped, so an imported session
        // quietly carried the wrong port.
        const m = /^([A-Za-z0-9_-]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1].toLowerCase();
        // Values may be quoted; a Host line may carry several patterns.
        const value = m[2].trim();
        if (key === 'host') {
            current = { patterns: value.split(/\s+/).map((v) => v.replace(/^"|"$/g, '')), options: {} };
            stanzas.push(current);
            continue;
        }
        if (key === 'match') {
            // Match blocks need a live connection context to evaluate;
            // swallowing their options silently would import the wrong
            // values, so the block is skipped and said out loud.
            current = null;
            warnings.push(`a Match block was skipped (${value.slice(0, 40)})`);
            continue;
        }
        if (key === 'include') {
            warnings.push(`an Include was not followed (${value.slice(0, 60)})`);
            continue;
        }
        if (!current) continue;
        // First value wins WITHIN a stanza too, per ssh semantics.
        if (!(key in current.options)) {
            current.options[key] = value.replace(/^"|"$/g, '');
        }
    }

    // Concrete aliases are the ones with no wildcard characters; pattern
    // stanzas contribute options but are not sessions themselves.
    const aliases = [];
    const seen = new Set();
    for (const st of stanzas) {
        for (const p of st.patterns) {
            if (/[*?!]/.test(p)) continue;
            if (seen.has(p.toLowerCase())) continue;
            seen.add(p.toLowerCase());
            aliases.push(p);
        }
    }

    // ssh option lookup: the FIRST value across matching stanzas in file
    // order. This is the part everyone gets backwards - later stanzas do
    // not override earlier ones.
    const optionFor = (alias, key) => {
        for (const st of stanzas) {
            if (!hostMatches(alias, st.patterns)) continue;
            if (key in st.options) return st.options[key];
        }
        return undefined;
    };

    const sessions = [];
    const usernames = {};
    const keyByUsername = {};
    for (const alias of aliases) {
        const hostname = optionFor(alias, 'hostname') || alias;
        const user = optionFor(alias, 'user') || null;
        const port = Number(optionFor(alias, 'port')) || null;
        const identity = optionFor(alias, 'identityfile');
        const proxyJump = optionFor(alias, 'proxyjump');
        let jumpAlias = null;
        if (proxyJump && proxyJump.toLowerCase() !== 'none') {
            const hops = proxyJump.split(',').map((h) => h.trim());
            // Our jump model chains through the hop's own node, so a
            // multi-hop ProxyJump flattens to its LAST hop (nearest the
            // target); if that hop is imported too and has its own
            // ProxyJump, the chain reassembles itself.
            jumpAlias = hops[hops.length - 1].replace(/^.*@/, '').replace(/:\d+$/, '');
            if (hops.length > 1) {
                warnings.push(`${alias}: multi-hop ProxyJump imported via its last hop '${jumpAlias}'`);
            }
        }
        if (user) {
            usernames[user] = (usernames[user] || 0) + 1;
            if (identity && !keyByUsername[user]) {
                keyByUsername[user] = expandPath(identity, home);
            }
        }
        sessions.push({
            name: alias, host: hostname, transport: 'ssh',
            port: port === 22 ? null : port,
            username: user, jumpAlias,
            keyPath: identity ? expandPath(identity, home) : null,
            serial: null, rawTcp: false,
        });
    }
    return { source: 'ssh_config', sessions, usernames, keyByUsername, warnings, skipped: [] };
}

function scanSshConfig(filePath) {
    const home = os.homedir();
    const p = filePath || path.join(home, '.ssh', 'config');
    if (!fs.existsSync(p)) return null;
    return parseSshConfig(fs.readFileSync(p, 'utf8'), home);
}

// --- PuTTY saved sessions ---------------------------------------------------

// `reg query ... /s` output: a key-path line, then indented
// `    Name    REG_TYPE    value` triples separated by runs of spaces.
function parsePuttyReg(text) {
    const sessionsByName = new Map();
    let current = null;
    for (const raw of String(text).split(/\r?\n/)) {
        if (/^HKEY_/i.test(raw.trim())) {
            const leaf = raw.trim().split('\\').pop();
            let name = leaf;
            try { name = decodeURIComponent(leaf.replace(/\+/g, '%20')); } catch (_) { /* keep raw */ }
            current = { name, values: {} };
            sessionsByName.set(name, current);
            continue;
        }
        const m = /^\s+(\S+)\s{2,}(REG_\w+)\s{2,}(.*)$/.exec(raw);
        if (!m || !current) continue;
        const value = m[2] === 'REG_DWORD' ? parseInt(m[3], 16) : m[3].trim();
        current.values[m[1].toLowerCase()] = value;
    }

    const sessions = [];
    const usernames = {};
    const keyByUsername = {};
    const skipped = [];
    const warnings = [];
    for (const [name, entry] of sessionsByName) {
        if (name === 'Default Settings') continue;   // PuTTY's defaults, not a session
        const v = entry.values;
        const proto = String(v.protocol || 'ssh').toLowerCase();
        let transport = null;
        let rawTcp = false;
        if (proto === 'ssh') transport = 'ssh';
        else if (proto === 'telnet') transport = 'telnet';
        else if (proto === 'serial') transport = 'serial';
        else if (proto === 'raw') { transport = 'telnet'; rawTcp = true; }
        else {
            skipped.push({ name, type: proto });
            continue;
        }
        const user = v.username || null;
        if (user) {
            usernames[user] = (usernames[user] || 0) + 1;
            if (v.publickeyfile && !keyByUsername[user]) keyByUsername[user] = v.publickeyfile;
        }
        const port = Number(v.portnumber) || null;
        sessions.push({
            name,
            host: transport === 'serial' ? null : (v.hostname || null),
            transport,
            port: (transport === 'ssh' && port === 22) || (transport === 'telnet' && port === 23)
                ? null : port,
            username: user,
            jumpAlias: null,
            keyPath: v.publickeyfile || null,
            serial: transport === 'serial'
                ? { device: v.serialline || 'COM1', baud: Number(v.serialspeed) || 9600 }
                : null,
            rawTcp,
        });
    }
    return { source: 'putty', sessions, usernames, keyByUsername, warnings, skipped };
}

function scanPutty() {
    return new Promise((resolve) => {
        // Absolute path, not a bare name: Windows resolves a bare command
        // against the application directory and the working directory
        // BEFORE PATH, so a reg.exe dropped next to the app (or in whatever
        // folder the app happens to be running from) would be preferred
        // over the real one. %SystemRoot% is where the real one lives.
        const regExe = path.join(process.env.SystemRoot || 'C:\\Windows',
            'System32', 'reg.exe');
        execFile(regExe, ['query', 'HKCU\\Software\\SimonTatham\\PuTTY\\Sessions', '/s'],
            { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout) => {
                if (err) return resolve(null);   // no PuTTY, or an empty hive
                resolve(parsePuttyReg(stdout));
            });
    });
}

// --- report -> nodes --------------------------------------------------------

// Same contract as the MobaXTerm importer's toNodes: everything lands under
// one new root folder and flows through the merge preview before a byte is
// written. Jump references are wired AFTER all ids exist, by alias.
function toNodes(report, profileByUsername, rootFolderName) {
    const nodes = {};
    const root = {
        id: sessionStore.newId(), type: 'folder',
        name: rootFolderName ||
            (report.source === 'putty' ? 'Imported from PuTTY' : 'Imported from ssh config'),
        parentId: null, order: 999, defaults: {},
    };
    nodes[root.id] = root;

    const idByAlias = new Map();
    report.sessions.forEach((s, i) => {
        const node = {
            id: sessionStore.newId(), type: 'session',
            name: s.name, parentId: root.id, order: i,
            host: s.host, transport: s.transport,
            port: s.port || null,
            rawTcp: !!s.rawTcp,
            credentialProfile: (s.username && profileByUsername[s.username]) || null,
            jumpHost: null,
            serial: s.serial || null,
            logging: null, highlightSet: null, encoding: null,
            tags: [], notes: '',
        };
        nodes[node.id] = node;
        idByAlias.set(String(s.name).toLowerCase(), node.id);
    });
    report.sessions.forEach((s) => {
        if (!s.jumpAlias) return;
        const target = idByAlias.get(String(s.jumpAlias).toLowerCase());
        const self = idByAlias.get(String(s.name).toLowerCase());
        // A jump host that was not itself imported cannot be referenced;
        // the session still imports, it just dials direct.
        if (target && self && target !== self) nodes[self].jumpHost = target;
    });
    return nodes;
}

module.exports = { parseSshConfig, parsePuttyReg, scanSshConfig, scanPutty, toNodes, hostMatches };
