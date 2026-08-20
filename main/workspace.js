'use strict';
// Workspace resurrection: the saved shape of the last session - tabs, pane
// order, what each pane was connected to, and (at quit) a scrollback
// snapshot - so an app restart mid-incident does not cost a carefully
// arranged twelve-pane layout.
//
// Two invariants, both load-bearing:
//
//   1. NOTHING here auto-connects. A restored workspace is a picture of
//      dead panes; every reconnect is a human pressing R (or the one
//      explicit reconnect-all button). Restoring by dialing thirty
//      switches unprompted would be a canary-stampede and a lockout risk
//      dressed up as a convenience.
//   2. Quick-connect passwords live in MEMORY only, ever. The recipe of a
//      quick connect is persisted without its password, whatever the
//      caller passes in - the strip happens here, at the choke point, not
//      in the goodwill of each call site.

const store = require('./store');

let data = null;   // {schema, savedAt, activeTab, tabs:[...]} or null

const MAX_PANES = 100;
const MAX_SCROLLBACK_CHARS = 2 * 1024 * 1024;   // per pane, ~2MB of serialized buffer

function init() {
    data = store.load('workspace', null);
}

function get() { return data; }

// Recipes arrive as the ipc layer's {nodeId} | {args, title}. Only known
// shapes pass, and args lose their password unconditionally.
function sanitizeRecipe(recipe) {
    if (!recipe || typeof recipe !== 'object') return null;
    if (typeof recipe.nodeId === 'string') return { nodeId: recipe.nodeId };
    if (recipe.args && typeof recipe.args === 'object') {
        const { password, ...rest } = recipe.args;
        return { args: rest };
    }
    return null;
}

// Identity of a pane across saves: what it dials plus what it is called.
// Stable enough to carry scrollback forward, and cheap to compute.
function paneKey(p) {
    return JSON.stringify([p.recipe, p.title || '']);
}

// layout: [{title, focusedIndex, panes:[{recipe, title, transport,
// highlightSet, scrollback?}]}]. Panes whose recipe cannot be sanitized are
// dropped - a pane that cannot be redialed is dead weight in a snapshot.
//
// Scrollback is expensive to serialize, so the renderer only sends it on
// the way out; every other save omits it. Omitted is NOT the same as gone:
// a pane keeps whatever scrollback the last full snapshot gave it, so
// restoring a layout and then crashing does not silently empty the
// scrollback that is still on screen. (It can go stale between full
// snapshots - a clean quit always refreshes it, and stale scrollback beats
// none.)
function save(layout, activeTab) {
    const carried = new Map();
    for (const t of (data && data.tabs) || []) {
        for (const p of t.panes || []) {
            if (p.scrollback) carried.set(paneKey(p), p.scrollback);
        }
    }
    const tabs = [];
    let panes = 0;
    for (const t of layout || []) {
        if (!t || !Array.isArray(t.panes)) continue;
        const keep = [];
        for (const p of t.panes) {
            if (panes >= MAX_PANES) break;
            const recipe = sanitizeRecipe(p && p.recipe);
            if (!recipe) continue;
            panes++;
            const entry = {
                recipe,
                title: String(p.title || '').slice(0, 200),
                transport: String(p.transport || 'ssh'),
                highlightSet: typeof p.highlightSet === 'string' ? p.highlightSet : null,
                scrollback: typeof p.scrollback === 'string'
                    ? p.scrollback.slice(0, MAX_SCROLLBACK_CHARS) : null,
            };
            if (!entry.scrollback) {
                entry.scrollback = carried.get(paneKey(entry)) || null;
            }
            keep.push(entry);
        }
        if (keep.length) {
            tabs.push({
                title: String(t.title || '').slice(0, 200),
                customTitle: t.customTitle ? String(t.customTitle).slice(0, 200) : null,
                // Only a plain hex color survives; this string is later fed
                // into an inline style.
                color: (typeof t.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(t.color))
                    ? t.color : null,
                focusedIndex: Number.isInteger(t.focusedIndex) ? t.focusedIndex : 0,
                panes: keep,
            });
        }
    }
    data = tabs.length
        ? { schema: 1, savedAt: new Date().toISOString(), activeTab: activeTab || 0, tabs }
        : null;
    if (data) store.save('workspace', data);
    else clear();
    return { tabs: tabs.length, panes };
}

function clear() {
    data = null;
    // An empty workspace is stored as an empty snapshot rather than a
    // deleted file: atomic replace, no unlink race with a concurrent save.
    store.save('workspace', null);
}

module.exports = { init, get, save, clear, sanitizeRecipe };
