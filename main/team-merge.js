'use strict';
// Three-way merge for the team sessions file. Pure functions, no I/O, no
// Electron - the whole matrix is unit-tested in tools/test-merge.js.
//
// Three trees, all flat id->node maps:
//   base   - the team tree as of the last accepted sync
//   remote - the shared file right now
//   local  - this user's working copy (base + their unpublished edits)
//
// Three-way is the simplest design that can tell "teammate changed it" from
// "it was always like that"; two-way re-asks about every historical
// difference until users click "yes to all", which is how drift wins.

// Fields that participate in diffing, per node type. Everything else is
// ignored (and the serializer whitelist keeps it out of the file anyway).
const DIFF_FIELDS = {
    folder: ['name', 'parentId', 'order', 'defaults', 'notes'],
    session: ['name', 'parentId', 'order', 'host', 'transport', 'port', 'rawTcp',
        'credentialProfile', 'jumpHost', 'serial', 'logging', 'highlightSet',
        'encoding', 'tags', 'notes'],
};

const eq = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

function changedFields(a, b) {
    if (!a || !b) return [];
    const fields = DIFF_FIELDS[b.type || a.type] || DIFF_FIELDS.session;
    return fields.filter((f) => !eq(a[f], b[f]));
}

// Returns the merge plan:
// {
//   adds:      [{node}]                         remote-added, not local
//   changes:   [{id, node, fields, keptLocal}]  remote-changed, auto-mergeable
//   removals:  [{id, node, hadOverride}]        remote-removed, local unchanged
//   conflicts: [{id, kind:'field'|'delete-modify', base, remote, local, fields}]
//   dupSuspects: [{localId, remoteId, host}]    added on both sides, same endpoint
// }
function diff(base, remote, local) {
    const plan = { adds: [], changes: [], removals: [], conflicts: [], dupSuspects: [] };
    const ids = new Set([...Object.keys(base), ...Object.keys(remote), ...Object.keys(local)]);

    for (const id of ids) {
        const b = base[id] || null;
        const r = remote[id] || null;
        const l = local[id] || null;

        if (!b) {
            if (r && !l) {
                plan.adds.push({ node: r });
            } else if (r && l) {
                // Same id on both sides without a base: same origin, compare.
                const fields = changedFields(l, r);
                if (fields.length) {
                    plan.conflicts.push({ id, kind: 'field', base: null, remote: r, local: l, fields });
                }
            }
            // !r && l: purely local addition - not the sync's business.
            continue;
        }

        if (!r) {
            // Removed remotely.
            if (!l || !changedFields(b, l).length) {
                if (l) plan.removals.push({ id, node: l });
            } else {
                plan.conflicts.push({ id, kind: 'delete-modify', base: b, remote: null, local: l, fields: changedFields(b, l) });
            }
            continue;
        }

        const remoteDelta = changedFields(b, r);
        if (!remoteDelta.length) continue;   // remote same as base: nothing incoming

        if (!l) {
            // Locally deleted but remotely changed: modify wins over delete,
            // presented as a conflict defaulting to restore.
            plan.conflicts.push({ id, kind: 'delete-modify-local', base: b, remote: r, local: null, fields: remoteDelta });
            continue;
        }

        const localDelta = changedFields(b, l);
        const overlap = remoteDelta.filter((f) => localDelta.includes(f) && !eq(r[f], l[f]));
        if (overlap.length) {
            plan.conflicts.push({ id, kind: 'field', base: b, remote: r, local: l, fields: overlap });
        } else {
            // Disjoint edits: field-level auto-merge, local edits kept.
            plan.changes.push({ id, node: r, fields: remoteDelta, keptLocal: localDelta });
        }
    }

    // Duplicate suspects: both sides added a node for the same endpoint.
    const localAdds = Object.values(local).filter((n) => !base[n.id] && !remote[n.id] && n.type === 'session');
    for (const add of plan.adds) {
        if (add.node.type !== 'session') continue;
        const twin = localAdds.find((n) => n.host === add.node.host &&
            (n.port || null) === (add.node.port || null) &&
            (n.transport || 'ssh') === (add.node.transport || 'ssh'));
        if (twin) plan.dupSuspects.push({ localId: twin.id, remoteId: add.node.id, host: add.node.host });
    }

    return plan;
}

// Apply an accepted plan to the local tree. decisions:
//   {acceptAdds:Set|null, acceptChanges:Set|null, acceptRemovals:Set|null,
//    conflictTakes: {id: 'theirs'|'mine'}, dupAdopt: {localId: remoteId}}
// null Sets mean accept everything in that group. Returns {local, base}
// (new objects; inputs are not mutated).
function apply(plan, baseIn, remoteIn, localIn, decisions = {}) {
    const local = JSON.parse(JSON.stringify(localIn));
    const takeAll = (set) => set === null || set === undefined;
    const acceptA = decisions.acceptAdds;
    const acceptC = decisions.acceptChanges;
    const acceptR = decisions.acceptRemovals;

    for (const { node } of plan.adds) {
        if (takeAll(acceptA) || acceptA.has(node.id)) local[node.id] = JSON.parse(JSON.stringify(node));
    }
    for (const ch of plan.changes) {
        if (!(takeAll(acceptC) || acceptC.has(ch.id))) continue;
        const target = local[ch.id];
        for (const f of ch.fields) target[f] = JSON.parse(JSON.stringify(ch.node[f] === undefined ? null : ch.node[f]));
    }
    for (const rm of plan.removals) {
        if (takeAll(acceptR) || acceptR.has(rm.id)) delete local[rm.id];
    }
    for (const c of plan.conflicts) {
        const take = (decisions.conflictTakes || {})[c.id] ||
            (c.kind === 'delete-modify' ? 'mine' : 'theirs');
        if (take === 'theirs') {
            if (c.remote) local[c.id] = JSON.parse(JSON.stringify(c.remote));
            else delete local[c.id];
        }
        // 'mine': keep local as-is; a kept node re-publishes later.
    }
    for (const [localId, remoteId] of Object.entries(decisions.dupAdopt || {})) {
        // Adopt the team id: the remote node wins the slot, the local
        // duplicate disappears (its overrides re-key with it).
        if (local[localId] && local[remoteId]) delete local[localId];
    }

    // Two disjoint auto-merges can compose into a parent cycle: you moved
    // folder A under B while a teammate moved B under A - edits to different
    // node ids, so neither is a conflict, but the merged tree loops. Repair
    // before anything downstream walks ancestors.
    repairCycles(local);

    // New base = the remote tree with kept-mine conflicts left as remote had
    // them (they will surface again on publish, which is correct).
    const base = JSON.parse(JSON.stringify(remoteIn));
    return { local, base };
}

// Break parentId cycles by reparenting the node where the loop closes to
// root. Deterministic (id order), returns the repaired ids so callers can
// surface it - a cycle is always the artifact of a bad merge or a bad file,
// and silently hanging on it is the one unacceptable outcome.
function repairCycles(nodes) {
    const repaired = [];
    for (const id of Object.keys(nodes).sort()) {
        const path = new Set();
        let cur = id;
        while (cur && nodes[cur]) {
            if (path.has(cur)) {
                nodes[cur].parentId = null;
                repaired.push(cur);
                break;
            }
            path.add(cur);
            cur = nodes[cur].parentId || null;
        }
    }
    return repaired;
}

module.exports = { diff, apply, changedFields, DIFF_FIELDS, repairCycles };
