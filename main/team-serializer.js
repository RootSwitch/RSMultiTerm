'use strict';
// The whitelist serializer for everything that leaves this machine: team
// publishes and manual exports. Privacy is structural - a field that is not
// on the list cannot leak, so future schema growth cannot accidentally ship
// a secret. Sessions carry credential profile NAMES only; profiles.json and
// overrides.json are never touched by this module at all.

const FOLDER_FIELDS = ['id', 'type', 'name', 'parentId', 'order', 'defaults', 'notes'];
const SESSION_FIELDS = ['id', 'type', 'name', 'parentId', 'order', 'host', 'transport',
    'port', 'rawTcp', 'credentialProfile', 'jumpHost', 'serial', 'logging',
    'highlightSet', 'encoding', 'tags', 'notes', 'modifiedAt'];

// `personal: true` nodes (and everything under a personal folder) stay home.
// Iterative with a path set: a parent cycle must fail closed (not shared,
// nothing leaves the machine), never blow the stack mid-publish.
function isShared(nodes, id, cache = new Map()) {
    const path = [];
    let cur = id;
    let shared;
    for (;;) {
        if (cache.has(cur)) { shared = cache.get(cur); break; }
        const n = nodes[cur];
        if (!n || n.personal || path.includes(cur)) { shared = false; break; }
        if (!n.parentId) { shared = true; break; }
        path.push(cur);
        cur = n.parentId;
    }
    for (const p of path) cache.set(p, shared);
    cache.set(id, shared);
    return shared;
}

function serializeNodes(nodes, usernames = []) {
    const out = {};
    const cache = new Map();
    for (const [id, n] of Object.entries(nodes)) {
        if (!isShared(nodes, id, cache)) continue;
        const fields = n.type === 'folder' ? FOLDER_FIELDS : SESSION_FIELDS;
        const clean = {};
        for (const f of fields) {
            if (n[f] !== undefined) clean[f] = n[f];
        }
        // logging.folder is a local filesystem path: publishing it leaks
        // machine layout outward, and adopting it would let the share point
        // teammates' logs at arbitrary directories. It never travels.
        if (clean.logging && typeof clean.logging === 'object' && 'folder' in clean.logging) {
            const { folder, ...rest } = clean.logging;
            clean.logging = rest;
        }
        // Belt and braces on top of the whitelist: refuse to publish a node
        // whose free-text notes contain one of the local profile usernames.
        if (clean.notes && usernames.some((u) => u && clean.notes.includes(u))) {
            throw new Error(`refusing to publish: notes on '${clean.name}' contain a profile username`);
        }
        out[id] = clean;
    }
    return out;
}

function makeTeamFile(nodes, rev, highlightSets, usernames, snippets) {
    return {
        schema: 1,
        rev,
        savedAt: new Date().toISOString(),
        nodes: serializeNodes(nodes, usernames),
        highlightSets: highlightSets || [],
        // The same whitelist discipline as nodes: only the fields snippets
        // are made of, so nothing else can ride along.
        snippets: sanitizeSnippets(snippets),
    };
}

// Strict reader: structure-validate a file that came off a share or an
// email. Data, never code; unknown majors are refused, not guessed at.
function validateTeamFile(data) {
    if (!data || typeof data !== 'object') throw new Error('not a team sessions file');
    if (data.schema !== 1) throw new Error(`unsupported team file schema ${data.schema}`);
    if (typeof data.rev !== 'number') throw new Error('team file has no rev');
    if (!data.nodes || typeof data.nodes !== 'object') throw new Error('team file has no nodes');
    for (const [id, n] of Object.entries(data.nodes)) {
        if (id === '__proto__' || id === 'constructor' || id === 'prototype') {
            throw new Error('team file contains an unsafe node id - refusing');
        }
        if (!n || (n.type !== 'folder' && n.type !== 'session')) {
            throw new Error(`invalid node ${id}`);
        }
        if ('password' in n || 'username' in n || 'secretDpapi' in n) {
            throw new Error(`node ${id} carries credential material - refusing`);
        }
        // The write path never publishes logging.folder, so its presence
        // means a hand-edited or hostile file steering logs to an arbitrary
        // local path ("log terminal output into Startup"). Strip, not trust.
        if (n.logging && typeof n.logging === 'object' && 'folder' in n.logging) {
            delete n.logging.folder;
        }
    }
    data.highlightSets = sanitizeHighlightSets(data.highlightSets);
    data.snippets = sanitizeSnippets(data.snippets);
    return data;
}

// Snippets are commands someone will SEND to live gear, so a file off the
// share gets the same structural treatment as highlight sets: whitelisted
// fields only, size caps, anything malformed dropped.
const MAX_SNIPPETS = 200;
const MAX_COMMAND = 10000;

function sanitizeSnippets(snippets) {
    if (!Array.isArray(snippets)) return [];
    return snippets.slice(0, MAX_SNIPPETS)
        .filter((s) => s && typeof s === 'object' &&
            typeof s.id === 'string' && s.id.length <= 100 &&
            typeof s.name === 'string' && s.name.length <= 200 &&
            typeof s.command === 'string' && s.command.length <= MAX_COMMAND)
        .map((s) => ({
            id: s.id,
            name: s.name,
            command: s.command,
            notes: typeof s.notes === 'string' ? s.notes.slice(0, 2000) : '',
        }));
}

// Highlight sets ride the team file and their patterns are compiled against
// every byte of terminal output on every teammate's machine. Structure is
// enforced here; anything malformed is dropped, and pattern length is capped
// as a cheap ceiling on regex blowups from a hostile or corrupt file.
const MAX_SETS = 100;
const MAX_RULES = 500;
const MAX_PATTERN = 512;

function sanitizeHighlightSets(sets) {
    if (!Array.isArray(sets)) return [];
    return sets.slice(0, MAX_SETS).filter((s) =>
        s && typeof s === 'object' &&
        typeof s.id === 'string' && s.id.length <= 100 &&
        typeof s.name === 'string' && Array.isArray(s.rules)
    ).map((s) => ({
        ...s,
        rules: s.rules.slice(0, MAX_RULES).filter((r) =>
            r && typeof r === 'object' &&
            typeof r.pattern === 'string' && r.pattern.length <= MAX_PATTERN),
    }));
}

module.exports = { serializeNodes, makeTeamFile, validateTeamFile, isShared, sanitizeSnippets };
