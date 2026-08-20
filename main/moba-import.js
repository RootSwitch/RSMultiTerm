'use strict';
// One-time MobaXTerm .mxtsessions migration - the adoption blocker for a
// team with years of saved sessions. Parses only the version-stable prefix
// of each entry (type, host, port, username) and skips the exotic per-type
// tail that churns between Moba versions. Non-terminal session types (RDP,
// VNC, browser, ...) are skipped and reported.
//
// The username is the whole point: it is NOT imported into sessions.
// Distinct usernames are aggregated so the wizard can ask "37 sessions use
// 'jdoe' - which credential profile?" - converting baked-in usernames to the
// profile model in one screen.

const fs = require('fs');
const sessionStore = require('./session-store');

// Moba type codes for the transports this app speaks.
const TYPE_MAP = { 0: 'ssh', 1: 'telnet', 22: 'serial' };
const TYPE_NAMES = {
    0: 'SSH', 1: 'Telnet', 2: 'RSH', 3: 'Xdmcp', 4: 'RDP', 5: 'VNC', 6: 'FTP',
    7: 'SFTP', 8: 'Shell', 9: 'Browser', 10: 'Mosh', 11: 'Aws S3', 12: 'WSL',
    22: 'Serial',
};

function decode(buf) {
    if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le', 2);
    if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.toString('utf8', 3);
    // Moba writes ANSI for plain-ASCII content; latin1 is the safe superset.
    return buf.includes(0) ? buf.toString('utf16le') : buf.toString('latin1');
}

// Parse into an intermediate report the wizard shows before anything is
// written: {folders:[path], sessions:[{name, folder, transport, host, port,
// username}], skipped:[{name, type}], usernames:{name: count}}
function parse(filePath) {
    const text = decode(fs.readFileSync(filePath));
    const out = { folders: [], sessions: [], skipped: [], usernames: {} };
    let currentFolder = '';

    for (const rawLine of text.split(/\r\n|\r|\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('[Bookmarks')) {
            currentFolder = '';
            continue;
        }
        const eqAt = line.indexOf('=');
        if (eqAt < 1) continue;
        const key = line.slice(0, eqAt);
        const value = line.slice(eqAt + 1);

        if (key === 'SubRep') {
            currentFolder = value.replace(/\\/g, '/');
            if (currentFolder && !out.folders.includes(currentFolder)) {
                out.folders.push(currentFolder);
            }
            continue;
        }
        if (key === 'ImgNum') continue;

        // A session line: Name=#icon#type%field1%field2%...
        const m = value.match(/^#\d+#(\d+)%(.*)$/);
        if (!m) continue;
        const type = Number(m[1]);
        const fields = m[2].split('%');
        const transport = TYPE_MAP[type];
        if (!transport) {
            out.skipped.push({ name: key, type: TYPE_NAMES[type] || `type ${type}` });
            continue;
        }

        const session = {
            name: key,
            folder: currentFolder,
            transport,
            host: fields[0] || '',
            port: Number(fields[1]) || null,
            username: (transport === 'ssh' ? fields[2] : '') || '',
        };
        if (transport === 'serial') {
            session.serial = { device: fields[0], baud: Number(fields[1]) || 9600 };
            session.host = '';
        }
        out.sessions.push(session);
        if (session.username) {
            out.usernames[session.username] = (out.usernames[session.username] || 0) + 1;
        }
    }
    return out;
}

// Build tree nodes from a parse report plus the wizard's username-to-profile
// mapping. Returns the node map ready for the standard import merge dialog.
function toNodes(report, profileByUsername, rootFolderName) {
    const nodes = {};
    const folderIds = new Map();

    const root = {
        id: sessionStore.newId(), type: 'folder',
        name: rootFolderName || 'Imported from MobaXTerm',
        parentId: null, order: 999, defaults: {},
    };
    nodes[root.id] = root;

    const folderFor = (folderPath) => {
        if (!folderPath) return root.id;
        if (folderIds.has(folderPath)) return folderIds.get(folderPath);
        const parts = folderPath.split('/');
        const parentPath = parts.slice(0, -1).join('/');
        const parentId = folderFor(parentPath);
        const f = {
            id: sessionStore.newId(), type: 'folder', name: parts[parts.length - 1],
            parentId, order: folderIds.size, defaults: {},
        };
        nodes[f.id] = f;
        folderIds.set(folderPath, f.id);
        return f.id;
    };

    report.sessions.forEach((s, i) => {
        const node = {
            id: sessionStore.newId(), type: 'session',
            name: s.name, parentId: folderFor(s.folder), order: i,
            host: s.host, transport: s.transport,
            port: s.port === 22 && s.transport === 'ssh' ? null
                : (s.port === 23 && s.transport === 'telnet' ? null : s.port),
            credentialProfile: (s.username && profileByUsername[s.username]) || null,
            jumpHost: null,
            serial: s.serial || null,
            logging: null, highlightSet: null, encoding: null,
            tags: [], notes: '',
        };
        nodes[node.id] = node;
    });
    return nodes;
}

module.exports = { parse, toNodes };
