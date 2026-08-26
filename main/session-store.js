'use strict';
// The session tree: one flat map of nodes (folders and sessions) keyed by
// stable id. Flat because merge/diff and moves are per-node operations; the
// tree shape is just parentId + order. Ids are generated once at creation and
// never regenerated - they are the team-sync identity key.
//
// Inheritance is the anti-drift mechanism: session fields that are null mean
// "inherit from the nearest ancestor folder's defaults, then app settings".
// A new switch dropped into "Core - HQ" is correct with only name + host set.
// Sessions never hold usernames - credentialProfile is a role-name string
// ("AD Account") each user maps to their own credentials locally.

const crypto = require('crypto');
const store = require('./store');

const INHERITABLE = ['credentialProfile', 'port', 'transport', 'jumpHost',
    'logging', 'highlightSet', 'encoding', 'onConnect', 'proxy'];

let tree = null;   // {schema, nodes: {id: node}}
const listeners = [];

function newId() {
    return Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

function init() {
    // Critical: an empty tree where a full one belongs is data loss, and
    // {"schema":1} with no nodes used to pass loadCritical and then throw
    // on the first Object.values(tree.nodes).
    tree = store.shapedCritical('sessions',
        (d) => d && typeof d === 'object' && d.nodes && typeof d.nodes === 'object',
        { schema: 1, nodes: {} });
}

function onChange(fn) { listeners.push(fn); }
function persist() {
    store.save('sessions', tree);
    for (const fn of listeners) fn();
}

function nodes() { return tree.nodes; }
function get(id) { return tree.nodes[id] || null; }

// Ids become object keys in the nodes map and team files; the prototype
// names would silently corrupt the map instead of storing a node.
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function upsert(node) {
    if (node.id !== undefined && (typeof node.id !== 'string' || UNSAFE_IDS.has(node.id))) {
        throw new Error('invalid node id');
    }
    if (!node.id) {
        node.id = newId();
        if (node.order === undefined) {
            const siblings = Object.values(tree.nodes)
                .filter((n) => n.parentId === (node.parentId || null));
            node.order = siblings.length;
        }
    }
    node.parentId = node.parentId || null;
    // Same ancestor check move() has: an upsert that sets parentId is a move
    // too, and a parent cycle hangs every ancestor walk in the app.
    let p = node.parentId;
    const seen = new Set();
    while (p) {
        if (p === node.id || seen.has(p)) throw new Error('node cannot be its own ancestor');
        seen.add(p);
        p = (get(p) || {}).parentId;
    }
    if (node.type === 'session') node.modifiedAt = new Date().toISOString();
    tree.nodes[node.id] = { ...get(node.id), ...node };
    persist();
    return tree.nodes[node.id];
}

// Deleting a folder deletes its subtree; callers confirm first.
function remove(ids) {
    const doomed = new Set(ids);
    let grew = true;
    while (grew) {
        grew = false;
        for (const n of Object.values(tree.nodes)) {
            if (n.parentId && doomed.has(n.parentId) && !doomed.has(n.id)) {
                doomed.add(n.id);
                grew = true;
            }
        }
    }
    for (const id of doomed) delete tree.nodes[id];
    persist();
    return [...doomed];
}

function move(id, parentId, order) {
    const n = get(id);
    if (!n) return;
    // A folder cannot move under its own descendant. The seen set makes the
    // walk terminate even if the tree already carries a cycle from a bad
    // merge - refusing the move is better than hanging.
    let p = parentId;
    const seen = new Set();
    while (p) {
        if (p === id || seen.has(p)) return;
        seen.add(p);
        p = (get(p) || {}).parentId;
    }
    n.parentId = parentId || null;
    if (order !== undefined) n.order = order;
    persist();
}

// Bulk edit with tri-state semantics: for each field, undefined = keep,
// null = clear to inherit, value = set explicitly.
function bulkEdit(ids, patch) {
    for (const id of ids) {
        const n = get(id);
        if (!n || n.type !== 'session') continue;
        for (const [k, v] of Object.entries(patch)) {
            if (v === undefined) continue;
            n[k] = v;
        }
        n.modifiedAt = new Date().toISOString();
    }
    persist();
}

// Resolve a session's effective settings by walking ancestors. Returns the
// value plus where it came from, so editors can grey inherited fields with
// their source ("port 22 - from 'Core - HQ'").
function effective(id, appDefaults = {}) {
    const n = get(id);
    if (!n) return null;
    const out = {};
    for (const field of INHERITABLE) {
        if (n[field] !== null && n[field] !== undefined) {
            out[field] = { value: n[field], from: null };
            continue;
        }
        let p = n.parentId;
        let found = false;
        const seen = new Set();   // cycle guard: never hang a connect on bad data
        while (p && !seen.has(p)) {
            seen.add(p);
            const folder = get(p);
            if (!folder) break;
            const d = folder.defaults || {};
            if (d[field] !== null && d[field] !== undefined) {
                out[field] = { value: d[field], from: folder.name };
                found = true;
                break;
            }
            p = folder.parentId;
        }
        if (!found) {
            out[field] = {
                value: appDefaults[field] !== undefined ? appDefaults[field] : null,
                from: appDefaults[field] !== undefined ? 'app defaults' : null,
            };
        }
    }
    return out;
}

// Build the engine's ConnectionDescriptor: effective settings plus the
// resolved jump chain (outermost hop first). Depth-capped with cycle
// detection - a jump host is itself a session and may have its own jump host.
function resolveDescriptor(id, appDefaults) {
    const n = get(id);
    if (!n || n.type !== 'session') throw new Error(`unknown session: ${id}`);
    const eff = effective(id, appDefaults);
    const transport = eff.transport.value || 'ssh';

    const jumpChain = [];
    const seen = new Set([id]);
    let hopId = eff.jumpHost.value;
    while (hopId) {
        if (seen.has(hopId)) throw new Error('jump host cycle detected');
        if (jumpChain.length >= 4) throw new Error('jump chain deeper than 4 hops');
        seen.add(hopId);
        const hop = get(hopId);
        if (!hop || hop.type !== 'session') throw new Error('jump host session missing');
        const hopEff = effective(hopId, appDefaults);
        jumpChain.unshift({
            nodeId: hop.id,
            host: hop.host,
            port: hopEff.port.value || 22,
            credentialProfile: hopEff.credentialProfile.value || null,
        });
        hopId = hopEff.jumpHost.value;
    }

    return {
        nodeId: n.id,
        name: n.name,
        transport,
        host: n.host,
        port: eff.port.value || (transport === 'telnet' ? 23 : 22),
        rawTcp: !!n.rawTcp,
        serial: n.serial || null,
        jumpChain,
        credentialProfile: eff.credentialProfile.value || null,
        // NOT || null: logging can be explicitly FALSE (this session logs
        // nothing), and false||null collapses to null, which the resolver
        // reads as "no opinion" - i.e. logging back ON.
        logging: eff.logging.value === undefined ? null : eff.logging.value,
        highlightSet: eff.highlightSet.value || null,
        encoding: eff.encoding.value || null,
        onConnect: eff.onConnect.value || null,
        // 'socks5://host:port' or 'http://host:port'; the engine parses and
        // refuses anything else at connect time.
        proxy: eff.proxy.value || null,
    };
}

// Wholesale replacement, used by team sync after a merge. One persist, one
// change event.
function replaceAll(newNodes) {
    tree.nodes = newNodes;
    persist();
}

module.exports = {
    init, onChange, nodes, get, upsert, remove, move, bulkEdit,
    effective, resolveDescriptor, newId, INHERITABLE, replaceAll,
};
