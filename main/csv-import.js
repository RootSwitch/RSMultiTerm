'use strict';
// CSV import/export for the session tree: the bulk path for "here are the
// 40 switches we deployed this quarter" and for fixing an estate in Excel.
//
// Match key is the session NAME, case-insensitively, within the target
// folder's subtree. Host would be the obvious alternative and is wrong here:
// the most common amendment is a changed IP, and matching on host would
// insert a duplicate instead of updating the device that moved - exactly the
// drift this feature exists to remove. Host is used the other way round, as
// a rename detector.
//
// Nothing is ever deleted by an import. Pruning is the healthcheck's job.

const sessionStore = require('./session-store');

const COLUMNS = ['name', 'host', 'port', 'transport', 'profile', 'folder', 'tags', 'notes'];

// Minimal RFC 4180 reader: quoted fields, doubled quotes inside them,
// embedded commas and newlines. Small enough to own, and a dependency whose
// failure mode is a silently mangled estate is not one worth taking.
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    const s = text.replace(/^﻿/, '');   // Excel writes a BOM

    while (i < s.length) {
        const c = s[i];
        if (inQuotes) {
            if (c === '"') {
                if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i++; continue;
            }
            field += c; i++; continue;
        }
        if (c === '"') { inQuotes = true; i++; continue; }
        if (c === ',') { row.push(field); field = ''; i++; continue; }
        if (c === '\r') { i++; continue; }
        if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
        field += c; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function toCsvField(v) {
    let s = v === null || v === undefined ? '' : String(v);
    // Excel executes cells starting with = + - @ (WEBSERVICE, DDE) - and
    // names/notes can arrive from the team share, so an export-then-open is
    // a code path from a teammate's keyboard into Excel. The apostrophe is
    // Excel's own "this is text" marker.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// --- reading ----------------------------------------------------------------

function childrenOf(nodes, parentId) {
    return Object.values(nodes).filter((n) => (n.parentId || null) === (parentId || null));
}

function subtreeSessions(nodes, rootId) {
    const out = [];
    const seen = new Set();   // cycle guard: A>B>A folders must not recurse forever
    const walk = (id) => {
        if (seen.has(id)) return;
        seen.add(id);
        for (const n of childrenOf(nodes, id)) {
            if (n.type === 'session') out.push(n);
            else walk(n.id);
        }
    };
    walk(rootId || null);
    return out;
}

// Resolve (or plan) a folder path like "Site A/Core" under the target root.
function resolveFolderPath(nodes, rootId, folderPath, plannedFolders) {
    if (!folderPath) return { id: rootId || null, created: [] };
    const parts = folderPath.split('/').map((p) => p.trim()).filter(Boolean);
    let parentId = rootId || null;
    const created = [];
    for (const part of parts) {
        const existing = childrenOf(nodes, parentId)
            .find((n) => n.type === 'folder' && n.name.toLowerCase() === part.toLowerCase());
        if (existing) { parentId = existing.id; continue; }
        const plannedKey = `${parentId || 'root'}/${part.toLowerCase()}`;
        if (plannedFolders.has(plannedKey)) { parentId = plannedFolders.get(plannedKey); continue; }
        const id = sessionStore.newId();
        plannedFolders.set(plannedKey, id);
        created.push({ id, name: part, parentId });
        parentId = id;
    }
    return { id: parentId, created };
}

// Build the dry-run plan. Returns
// {rows:[{line, action, name, changes:[{field, from, to}], error, nodeId}],
//  newFolders:[{id,name,parentId}], counts:{...}}
function plan(text, targetFolderId) {
    const nodes = sessionStore.nodes();
    const rows = parseCsv(text);
    if (!rows.length) throw new Error('the file is empty');

    const header = rows[0].map((h) => h.trim().toLowerCase());
    if (!header.includes('name') || !header.includes('host')) {
        throw new Error('a header row with at least "name" and "host" is required');
    }
    const unknown = header.filter((h) => h && !COLUMNS.includes(h));
    const index = Object.fromEntries(COLUMNS.map((c) => [c, header.indexOf(c)]));

    const existing = subtreeSessions(nodes, targetFolderId);
    const byName = new Map();
    for (const n of existing) byName.set((n.name || '').toLowerCase(), n);

    const plannedFolders = new Map();
    const newFolders = [];
    const out = [];
    const seenNames = new Set();

    rows.slice(1).forEach((cells, i) => {
        const line = i + 2;   // 1-based, plus the header
        const cell = (col) => {
            const at = index[col];
            return at === -1 || at === undefined ? '' : (cells[at] === undefined ? '' : cells[at].trim());
        };
        const name = cell('name');
        const host = cell('host');
        if (!name) { out.push({ line, action: 'error', name: '', error: 'no name' }); return; }
        if (seenNames.has(name.toLowerCase())) {
            out.push({ line, action: 'error', name, error: 'duplicate name in this file' });
            return;
        }
        seenNames.add(name.toLowerCase());

        const port = cell('port');
        if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
            out.push({ line, action: 'error', name, error: `invalid port "${port}"` });
            return;
        }
        const transport = cell('transport').toLowerCase();
        if (transport && !['ssh', 'telnet', 'serial'].includes(transport)) {
            out.push({ line, action: 'error', name, error: `unknown transport "${transport}"` });
            return;
        }

        const folderPath = cell('folder');
        let folderId = targetFolderId || null;
        if (folderPath) {
            const r = resolveFolderPath(nodes, targetFolderId, folderPath, plannedFolders);
            folderId = r.id;
            newFolders.push(...r.created);
        }

        // Only non-empty cells are applied: a blank means "leave alone", so a
        // partial CSV (just names and new IPs) is safe to import.
        const desired = {};
        if (host) desired.host = host;
        if (port) desired.port = Number(port);
        if (transport) desired.transport = transport;
        const profile = cell('profile');
        if (profile) desired.credentialProfile = profile;
        const tags = cell('tags');
        if (tags) desired.tags = tags.split(',').map((t) => t.trim()).filter(Boolean);
        const notes = cell('notes');
        if (notes) desired.notes = notes;

        const match = byName.get(name.toLowerCase());
        if (match) {
            const changes = [];
            for (const [field, value] of Object.entries(desired)) {
                const before = match[field];
                const same = Array.isArray(value)
                    ? JSON.stringify(before || []) === JSON.stringify(value)
                    : (before === undefined ? null : before) === value;
                if (!same) changes.push({ field, from: before === undefined ? null : before, to: value });
            }
            if (folderId && (match.parentId || null) !== folderId) {
                changes.push({ field: 'folder', from: match.parentId || null, to: folderId });
            }
            out.push({
                line, action: changes.length ? 'update' : 'no change',
                name, nodeId: match.id, changes, desired, folderId,
            });
            return;
        }

        // No name match. A single host match in the subtree is very likely a
        // renamed device, so offer that rather than silently duplicating.
        const hostTwins = host ? existing.filter((n) => n.host === host) : [];
        if (hostTwins.length === 1) {
            const twin = hostTwins[0];
            out.push({
                line, action: 'rename?', name, nodeId: twin.id,
                changes: [{ field: 'name', from: twin.name, to: name }]
                    .concat(Object.entries(desired)
                        .filter(([f, v]) => f !== 'host' && twin[f] !== v)
                        .map(([f, v]) => ({ field: f, from: twin[f] === undefined ? null : twin[f], to: v }))),
                desired, folderId,
            });
            return;
        }

        out.push({
            line, action: 'add', name, desired, folderId,
            changes: Object.entries(desired).map(([f, v]) => ({ field: f, from: null, to: v })),
        });
    });

    const counts = out.reduce((acc, r) => {
        acc[r.action] = (acc[r.action] || 0) + 1;
        return acc;
    }, {});
    return { rows: out, newFolders, unknownColumns: unknown, counts };
}

// Apply the rows the user kept. `accept` is a list of line numbers; a
// 'rename?' row only renames when its line is accepted, so the default of
// leaving it unchecked is safe.
function apply(planResult, accept, targetFolderId) {
    const keep = new Set(accept);
    const wanted = planResult.rows.filter((r) => keep.has(r.line) &&
        (r.action === 'add' || r.action === 'update' || r.action === 'rename?'));

    // Only materialize folders that an accepted row actually needs.
    const neededFolders = new Set(wanted.map((r) => r.folderId).filter(Boolean));
    const folderById = new Map(planResult.newFolders.map((f) => [f.id, f]));
    const materialize = (id) => {
        const f = folderById.get(id);
        if (!f || sessionStore.get(id)) return;
        if (f.parentId && folderById.has(f.parentId)) materialize(f.parentId);
        sessionStore.upsert({
            id: f.id, type: 'folder', name: f.name,
            parentId: f.parentId || null, defaults: {},
        });
    };
    for (const id of neededFolders) materialize(id);

    let added = 0, updated = 0, renamed = 0;
    for (const row of wanted) {
        if (row.action === 'add') {
            sessionStore.upsert({
                type: 'session', name: row.name,
                parentId: row.folderId || targetFolderId || null,
                host: row.desired.host || '',
                transport: row.desired.transport || null,
                port: row.desired.port === undefined ? null : row.desired.port,
                credentialProfile: row.desired.credentialProfile || null,
                jumpHost: null, serial: null, logging: null,
                highlightSet: null, encoding: null,
                tags: row.desired.tags || [],
                notes: row.desired.notes || '',
            });
            added++;
            continue;
        }
        const node = sessionStore.get(row.nodeId);
        if (!node) continue;
        const patch = { ...node, ...row.desired };
        if (row.action === 'rename?') { patch.name = row.name; renamed++; } else { updated++; }
        if (row.folderId) patch.parentId = row.folderId;
        sessionStore.upsert(patch);
    }
    return { added, updated, renamed };
}

// --- writing ----------------------------------------------------------------

// Export a folder's sessions (recursively) with folder paths relative to it,
// so the file round-trips back through import unchanged.
function exportFolder(folderId) {
    const nodes = sessionStore.nodes();
    const pathOf = (parentId) => {
        const parts = [];
        let id = parentId;
        while (id && id !== folderId) {
            const f = nodes[id];
            if (!f) break;
            parts.unshift(f.name);
            id = f.parentId;
        }
        return parts.join('/');
    };
    const lines = [COLUMNS.join(',')];
    for (const s of subtreeSessions(nodes, folderId)) {
        lines.push([
            s.name, s.host || '', s.port === null || s.port === undefined ? '' : s.port,
            s.transport || '', s.credentialProfile || '', pathOf(s.parentId),
            (s.tags || []).join(','), s.notes || '',
        ].map(toCsvField).join(','));
    }
    return lines.join('\r\n') + '\r\n';
}

module.exports = { plan, apply, exportFolder, parseCsv, COLUMNS };
