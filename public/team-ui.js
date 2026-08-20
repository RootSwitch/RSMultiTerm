'use strict';
// Session sync UI: publishing to and checking a shared sessions file, plus
// the approve-merge dialog that every sync and every import flows through.
// One merge engine, several entry points - and one dialog.
//
// The shared file started as a team feature and is named that way
// internally (rs:team.* channels, team-merge.js). What it actually does is
// keep one session tree in step with another copy of it, which is as true
// of a desktop and a laptop over a NAS share as it is of six people on
// SMB - so the UI says sync, not team. The wire names are left alone:
// renaming them would churn a well-tested subsystem to no user benefit.

(function () {
    const { open, row, input, select } = window.Modals;

    // --- merge dialog -----------------------------------------------------
    // plan: output of team-merge.diff. applyChannel: rs:team.apply or
    // rs:team.applyImport.
    function mergeDialog(plan, applyChannel, title) {
        const body = document.createElement('div');
        body.style.minWidth = '560px';

        const decisions = {
            acceptAdds: null, acceptChanges: null, acceptRemovals: null,
            conflictTakes: {}, dupAdopt: {},
        };
        const unchecked = { adds: new Set(), changes: new Set(), removals: new Set() };

        // Conflicts pinned on top: they must be decided, not skimmed.
        if (plan.conflicts.length) {
            const h = groupHeader(`Conflicts (${plan.conflicts.length}) - decide each`);
            h.style.color = 'var(--se-warn)';
            body.appendChild(h);
            for (const c of plan.conflicts) {
                const line = document.createElement('div');
                line.className = 'merge-row';
                const name = (c.local || c.remote || c.base || {}).name || c.id;
                const what = c.kind === 'delete-modify'
                    ? 'deleted by the team, but you modified it'
                    : c.kind === 'delete-modify-local'
                        ? 'you deleted it, but the team modified it'
                        : `both changed: ${c.fields.join(', ')}`;
                const label = document.createElement('span');
                label.style.flex = '1';
                label.textContent = `${name} - ${what}`;
                const pick = select([
                    { value: 'theirs', label: 'Take theirs' },
                    { value: 'mine', label: 'Keep mine' },
                ], c.kind === 'delete-modify' ? 'mine' : 'theirs');
                decisions.conflictTakes[c.id] = pick.value;
                pick.addEventListener('change', () => { decisions.conflictTakes[c.id] = pick.value; });
                line.append(label, pick);
                if (c.remote && c.local && c.kind === 'field') {
                    const detail = document.createElement('div');
                    detail.className = 'merge-detail';
                    detail.textContent = c.fields.map((f) =>
                        `${f}: theirs "${fmt(c.remote[f])}" vs mine "${fmt(c.local[f])}"`).join('  |  ');
                    const wrap = document.createElement('div');
                    wrap.append(line, detail);
                    body.appendChild(wrap);
                    continue;
                }
                body.appendChild(line);
            }
        }

        addGroup(body, `Added (${plan.adds.length})`, plan.adds, (a) =>
            `${a.node.name}${a.node.host ? ' - ' + a.node.host : ''}`,
            (a) => a.node.id, unchecked.adds);
        addGroup(body, `Changed (${plan.changes.length})`, plan.changes, (ch) => {
            const diffs = ch.fields.map((f) => `${f} -> ${fmt(ch.node[f])}`).join(', ');
            return `${ch.node.name} - ${diffs}` +
                (ch.keptLocal.length ? ` (your ${ch.keptLocal.join(', ')} kept)` : '');
        }, (ch) => ch.id, unchecked.changes);
        addGroup(body, `Removed (${plan.removals.length})`, plan.removals,
            (rm) => rm.node.name, (rm) => rm.id, unchecked.removals);

        if (plan.dupSuspects.length) {
            body.appendChild(groupHeader(`Possible duplicates (${plan.dupSuspects.length})`));
            for (const d of plan.dupSuspects) {
                const line = document.createElement('div');
                line.className = 'merge-row';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = true;
                cb.addEventListener('change', () => {
                    if (cb.checked) decisions.dupAdopt[d.localId] = d.remoteId;
                    else delete decisions.dupAdopt[d.localId];
                });
                decisions.dupAdopt[d.localId] = d.remoteId;
                const label = document.createElement('span');
                label.textContent = `${d.host} added by you and the team - adopt the team's entry (keeps one copy)`;
                line.append(cb, label);
                body.appendChild(line);
            }
        }

        open(title, body, [
            { label: 'Not now' },
            {
                label: 'Apply', primary: true,
                onClick: () => {
                    const toArray = (group, all) => unchecked[group].size
                        ? all.filter((id) => !unchecked[group].has(id)) : null;
                    rsterm.invoke(applyChannel, {
                        decisions: {
                            acceptAdds: toArray('adds', plan.adds.map((a) => a.node.id)),
                            acceptChanges: toArray('changes', plan.changes.map((c) => c.id)),
                            acceptRemovals: toArray('removals', plan.removals.map((r) => r.id)),
                            conflictTakes: decisions.conflictTakes,
                            dupAdopt: decisions.dupAdopt,
                        },
                        // Fingerprint of the remote state this plan was
                        // computed from; main refuses the apply if the share
                        // moved on while the dialog was open.
                        token: plan.token,
                    }).then(async (res) => {
                        if (res && res.stale) {
                            window.Forms.showBanner('warn',
                                'The team file changed while you were reviewing - here are the current changes.');
                            const fresh = await rsterm.invoke('rs:team.plan');
                            if (fresh) mergeDialog(fresh, applyChannel, title);
                            return;
                        }
                        window.SessionTree.refresh();
                    });
                },
            },
        ], { modal: true });
    }

    function fmt(v) {
        if (v === null || v === undefined) return 'inherit';
        if (typeof v === 'object') return JSON.stringify(v);
        return String(v);
    }
    function groupHeader(text) {
        const h = document.createElement('div');
        h.className = 'merge-group';
        h.textContent = text;
        return h;
    }
    function addGroup(body, title, items, labelOf, idOf, uncheckedSet) {
        if (!items.length) return;
        body.appendChild(groupHeader(title));
        for (const it of items) {
            const line = document.createElement('div');
            line.className = 'merge-row';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = true;
            cb.addEventListener('change', () => {
                if (cb.checked) uncheckedSet.delete(idOf(it));
                else uncheckedSet.add(idOf(it));
            });
            const label = document.createElement('span');
            label.textContent = labelOf(it);
            line.append(cb, label);
            body.appendChild(line);
        }
    }

    // --- sync actions -----------------------------------------------------
    // Reached from the session tree's Import menu, which only offers them
    // once a sync file is configured in Settings: someone who never sets
    // one never sees a word about syncing.
    async function syncCheck() {
        const plan = await rsterm.invoke('rs:team.plan');
        if (plan) mergeDialog(plan, 'rs:team.apply', 'Incoming session changes');
        else window.Forms.showBanner('warn', 'Sync file: nothing new.');
    }

    async function syncPublish() {
        try {
            const r = await rsterm.invoke('rs:team.publish');
            if (r.needMerge) {
                const plan = await rsterm.invoke('rs:team.plan');
                if (plan) mergeDialog(plan, 'rs:team.apply', 'Merge before publishing');
            } else {
                window.Forms.showBanner('warn', `Published rev ${r.rev} to the sync file.`);
            }
        } catch (err) {
            window.Forms.showBanner('error', `Publish failed: ${err.message}`);
        }
    }

    // --- MobaXTerm wizard -------------------------------------------------
    async function mobaWizard() {
        const report = await rsterm.invoke('rs:moba.pick');
        if (!report) return;
        const profiles = await rsterm.invoke('rs:profiles.list');

        const body = document.createElement('div');
        const summary = document.createElement('p');
        summary.style.marginBottom = '10px';
        summary.textContent = `${report.sessions.length} terminal sessions in ` +
            `${report.folders.length} folders.` +
            (report.skipped.length
                ? ` Skipped ${report.skipped.length} non-terminal entries (${[...new Set(report.skipped.map((s) => s.type))].join(', ')}).`
                : '');
        body.appendChild(summary);

        const mapping = {};
        const users = Object.entries(report.usernames);
        if (users.length) {
            const h = document.createElement('p');
            h.style.cssText = 'margin-bottom:6px;color:var(--se-txt-dim);';
            h.textContent = 'Map each baked-in username to a credential profile - ' +
                'sessions import with the profile reference only:';
            body.appendChild(h);
            for (const [user, count] of users) {
                const opts = [{ value: '', label: '(no profile)' }]
                    .concat(profiles.map((p) => ({ value: p.name, label: p.name })))
                    .concat([{ value: '__new__', label: `create profile "${user}"...` }]);
                const sel = select(opts, '');
                sel.addEventListener('change', async () => {
                    if (sel.value === '__new__') {
                        const name = await window.Modals.promptText('New credential profile', 'Profile name', user);
                        if (name) {
                            await rsterm.invoke('rs:profiles.upsert', { name, username: user, storage: 'prompt' });
                            const o = document.createElement('option');
                            o.value = name;
                            o.textContent = name;
                            sel.insertBefore(o, sel.lastChild);
                            sel.value = name;
                        } else {
                            sel.value = '';
                        }
                    }
                    mapping[user] = sel.value && sel.value !== '__new__' ? sel.value : null;
                });
                body.appendChild(row(`${user} (${count})`, sel));
            }
        }
        const fRoot = input('Imported from MobaXTerm', 'target folder name');
        body.appendChild(row('Into folder', fRoot));

        open('MobaXTerm import', body, [
            { label: 'Cancel' },
            {
                label: 'Preview import', primary: true,
                onClick: () => {
                    rsterm.invoke('rs:moba.apply', {
                        report,
                        profileByUsername: Object.fromEntries(
                            Object.entries(mapping).filter(([, v]) => v)),
                        rootName: fRoot.value.trim() || 'Imported from MobaXTerm',
                    }).then((plan) => mergeDialog(plan, 'rs:team.applyImport', 'Import from MobaXTerm'));
                },
            },
        ]);
    }

    // --- passive notifications --------------------------------------------
    rsterm.on('rs:evt.team-changes', (m) => {
        window.Forms.showBanner('warn',
            `Sessions changed in the sync file (rev ${m.rev}): ` +
            `${m.adds} added, ${m.changes} changed, ${m.removals} removed` +
            (m.conflicts ? `, ${m.conflicts} conflicts` : '') + '.',
            [{
                label: 'Review and merge',
                onClick: syncCheck,
            }]);
    });
    rsterm.on('rs:evt.team-error', (m) => {
        window.Forms.showBanner('error', `Session sync: ${m.message}`);
    });

    window.TeamUI = { mergeDialog, mobaWizard, syncCheck, syncPublish };
})();
