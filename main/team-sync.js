'use strict';
// Team sync orchestration: polling the shared file, running the three-way
// merge, publishing with a lock. The merge math lives in team-merge.js; the
// field whitelist in team-serializer.js; this file owns I/O and state.
//
// Change detection is poll + on-focus + before-publish, never fs.watch alone:
// watch on SMB silently degrades, and silent staleness is how drift returns.

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const sessionStore = require('./session-store');
const secrets = require('./secrets');
const highlights = require('./highlights');
const snippets = require('./snippets');
const settings = require('./settings');
const merge = require('./team-merge');
const serializer = require('./team-serializer');

const MAX_TEAM_FILE = 32 * 1024 * 1024;

let base = null;          // {rev, nodes} - last accepted team state
let pollTimer = null;
let notify = () => {};
let lastCheck = null;
let lastError = null;

function init(notifyFn) {
    notify = notifyFn;
    base = store.load('team-cache', { rev: 0, nodes: {} });
    schedulePoll();
}

function filePath() {
    return (settings.get().teamSync || {}).filePath || null;
}

function schedulePoll() {
    if (pollTimer) clearInterval(pollTimer);
    // Defensive floor on top of the settings-layer clamp: an old settings
    // file with a bad value must not become a 1ms hammer on the share.
    const secs = Math.max(10, Number((settings.get().teamSync || {}).pollSeconds) || 60);
    pollTimer = setInterval(() => check('poll'), secs * 1000);
    if (pollTimer.unref) pollTimer.unref();
}

function status() {
    return {
        configured: !!filePath(),
        filePath: filePath(),
        baseRev: base.rev,
        teamIds: Object.keys(base.nodes),
        lastCheck,
        lastError,
    };
}

function readRemote() {
    const p = filePath();
    if (!p) return null;
    let raw;
    try {
        // Read whole, synchronously, on a poll timer: a runaway or hostile
        // file on the share would otherwise stall the main process and can
        // exhaust memory. A real estate of thousands of sessions is well
        // under a megabyte.
        const size = fs.statSync(p).size;
        if (size > MAX_TEAM_FILE) {
            throw new Error(`team file is ${Math.round(size / 1048576)} MB - refusing to read ` +
                `more than ${MAX_TEAM_FILE / 1048576} MB`);
        }
        raw = fs.readFileSync(p, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return { missing: true };
        throw err;
    }
    if (!raw.trim()) throw new Error('team file is empty - a writer may be mid-save; retrying later');
    return serializer.validateTeamFile(JSON.parse(raw));
}

// Compute the current merge plan against the live tree. Returns null when
// there is nothing incoming. The token fingerprints the exact remote state
// the plan was computed from, so an apply can refuse to act on a plan the
// user reviewed against a file that has since moved on.
function computePlan() {
    const remote = readRemote();
    if (!remote || remote.missing) return null;
    if (remote.rev === base.rev) return null;
    const local = sessionStore.nodes();
    const plan = merge.diff(base.nodes, remote.nodes, local);
    const empty = !plan.adds.length && !plan.changes.length &&
        !plan.removals.length && !plan.conflicts.length;
    if (empty) {
        // Rev moved but nothing differs (usually our own publish echoing
        // back): just advance the base quietly.
        base = { rev: remote.rev, nodes: remote.nodes };
        store.save('team-cache', base);
        return null;
    }
    const token = require('crypto').createHash('sha256')
        .update(JSON.stringify([remote.rev, remote.nodes]))
        .digest('hex').slice(0, 16);
    return { remote, plan, token };
}

function check(reason) {
    lastCheck = new Date().toISOString();
    if (!filePath()) return null;
    try {
        lastError = null;
        const found = computePlan();
        if (found) {
            notify('rs:evt.team-changes', {
                reason,
                rev: found.remote.rev,
                adds: found.plan.adds.length,
                changes: found.plan.changes.length,
                removals: found.plan.removals.length,
                conflicts: found.plan.conflicts.length,
            });
            return found.plan;
        }
    } catch (err) {
        lastError = err.message;
        notify('rs:evt.team-error', { message: err.message });
    }
    return null;
}

// Full plan for the merge dialog, carrying the token the apply must echo.
function planForUi() {
    const found = computePlan();
    return found ? { ...found.plan, token: found.token } : null;
}

function applyDecisions(decisions, token) {
    const found = computePlan();
    if (!found) return { applied: false };
    // A teammate published between plan and apply: the fresh plan now holds
    // items the user never reviewed - new conflicts would silently default
    // to 'theirs' and unseen changes would fold into the base. Refuse and
    // let the dialog re-open on current state instead.
    if (token && token !== found.token) return { applied: false, stale: true };
    const local = sessionStore.nodes();
    const { local: mergedLocal, base: newBase } = merge.apply(
        found.plan, base.nodes, found.remote.nodes, local, decisions);
    sessionStore.replaceAll(mergedLocal);
    base = { rev: found.remote.rev, nodes: newBase };
    store.save('team-cache', base);
    // Team highlight sets ride along: any set id we do not have locally is
    // adopted (never overwrites a local set silently).
    if (found.remote.highlightSets && found.remote.highlightSets.length) {
        const mine = highlights.getSets();
        const missing = found.remote.highlightSets.filter((s) => !mine.some((m) => m.id === s.id));
        if (missing.length) highlights.saveSets(mine.concat(missing));
    }
    // Snippets: same adopt-missing-only rule - a teammate's new snippet
    // arrives, an id you already have (edited or not) is never overwritten.
    if (found.remote.snippets && found.remote.snippets.length) {
        const mine = snippets.get();
        const missing = found.remote.snippets.filter((s) => !mine.some((m) => m.id === s.id));
        if (missing.length) snippets.save(mine.concat(missing));
    }
    return { applied: true };
}

// --- publish ----------------------------------------------------------------

function lockPath() { return filePath() + '.lock'; }

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// A publish takes well under a second, so a lock this old belongs to a
// writer that died mid-publish. Generous on purpose: wrongly breaking a
// LIVE lock loses someone's publish; waiting out a dead one only costs time.
const LOCK_STALE_MS = 120 * 1000;

// "What time does the FILE SERVER think it is": touch a probe next to the
// lock and read its mtime. Comparing that to the lock's mtime keeps both
// timestamps on the same clock - staleness judged with this machine's clock
// against a lock written by another machine breaks live locks (or honors
// dead ones) as soon as two team PCs drift by more than the threshold.
function serverNowMs(lp) {
    const probe = `${lp}.probe.${process.pid}`;
    try {
        fs.writeFileSync(probe, 'x');
        return fs.statSync(probe).mtimeMs;
    } finally {
        try { fs.unlinkSync(probe); } catch (_) { /* best effort */ }
    }
}

// Create-exclusive is the mutual exclusion; the JSON payload is only for a
// human wondering whose lock this is. The lock file's CONTENT is never
// trusted for anything - a torn read on SMB must not delete a live lock,
// so nothing here reads it at all.
async function acquireLock(waitMs) {
    const lp = lockPath();
    const payload = JSON.stringify({ host: os.hostname(), at: new Date().toISOString() });
    const deadline = Date.now() + waitMs;
    for (;;) {
        try {
            fs.writeFileSync(lp, payload, { flag: 'wx' });
            return true;
        } catch (_) { /* held - consider staleness below */ }

        try {
            const now = serverNowMs(lp);
            if (now - fs.statSync(lp).mtimeMs > LOCK_STALE_MS) {
                // Break the dead writer's lock by CLAIMING it with a rename:
                // exactly one of several would-be breakers wins, and the
                // check-then-delete race (a fresh lock replacing the stale
                // one between our stat and our delete) can grab at worst the
                // claim file, which we re-verify below while we alone own it.
                const claim = `${lp}.stale.${process.pid}.${Date.now().toString(36)}`;
                fs.renameSync(lp, claim);
                if (now - fs.statSync(claim).mtimeMs > LOCK_STALE_MS) {
                    fs.unlinkSync(claim);   // confirmed dead; slot is free
                } else {
                    // We raced a live writer and grabbed their fresh lock -
                    // put it straight back and wait like everyone else.
                    try { fs.renameSync(claim, lp); } catch (_) { try { fs.unlinkSync(claim); } catch (_) { /* gone */ } }
                }
                continue;
            }
        } catch (_) { /* lock vanished or share hiccup: just retry */ }

        if (Date.now() >= deadline) return false;
        await sleep(500);
    }
}

function releaseLock() {
    try { fs.unlinkSync(lockPath()); } catch (_) { /* already gone */ }
}

async function publish(opts = {}) {
    if (!filePath()) throw new Error('no team file configured');
    const waitMs = opts.lockWaitMs === undefined ? 10000 : opts.lockWaitMs;
    if (!(await acquireLock(waitMs))) {
        throw new Error('team file is locked by another writer - try again shortly');
    }
    try {
        const remote = readRemote();
        if (remote && !remote.missing && remote.rev !== base.rev) {
            return { needMerge: true };
        }
        const usernames = secrets.list().map((p) => p.username).filter(Boolean);
        const file = serializer.makeTeamFile(
            sessionStore.nodes(), (remote && remote.rev) ? remote.rev + 1 : base.rev + 1,
            highlights.getSets(), usernames, snippets.get());
        store.atomicWrite(filePath(), file);
        base = { rev: file.rev, nodes: file.nodes };
        store.save('team-cache', base);
        return { published: true, rev: file.rev };
    } finally {
        releaseLock();
    }
}

// --- manual export / import -------------------------------------------------

function exportTo(targetPath) {
    const usernames = secrets.list().map((p) => p.username).filter(Boolean);
    const file = serializer.makeTeamFile(sessionStore.nodes(), 1, highlights.getSets(), usernames, snippets.get());
    store.atomicWrite(targetPath, file);
    return { count: Object.keys(file.nodes).length };
}

// Import runs the same merge engine with an empty base: everything in the
// file shows as incoming, the user approves in the same dialog.
let pendingImport = null;   // {nodes} until decisions arrive

function importFrom(sourcePath, targetFolderId) {
    const size = fs.statSync(sourcePath).size;
    if (size > MAX_TEAM_FILE) {
        throw new Error(`that file is ${Math.round(size / 1048576)} MB - too large to be a sessions file`);
    }
    const data = serializer.validateTeamFile(JSON.parse(fs.readFileSync(sourcePath, 'utf8')));
    const nodes = data.nodes;
    if (targetFolderId) {
        for (const n of Object.values(nodes)) {
            if (!n.parentId || !nodes[n.parentId]) n.parentId = targetFolderId;
        }
    }
    const plan = merge.diff({}, nodes, sessionStore.nodes());
    pendingImport = { nodes };
    return plan;
}

// Same import flow but for nodes built in-process (MobaXTerm wizard).
function importNodes(nodes) {
    const plan = merge.diff({}, nodes, sessionStore.nodes());
    pendingImport = { nodes };
    return plan;
}

function applyImport(decisions) {
    if (!pendingImport) throw new Error('no import in progress');
    const plan = merge.diff({}, pendingImport.nodes, sessionStore.nodes());
    const { local: mergedLocal } = merge.apply(plan, {}, pendingImport.nodes, sessionStore.nodes(), decisions);
    sessionStore.replaceAll(mergedLocal);
    pendingImport = null;
    return { applied: true };
}

module.exports = {
    init, status, check, planForUi, applyDecisions,
    publish, exportTo, importFrom, importNodes, applyImport, schedulePoll,
};
