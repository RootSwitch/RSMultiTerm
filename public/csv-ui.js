'use strict';
// CSV import preview. The import button always lands here first: one row per
// CSV line, what will happen to it, and the exact field changes. Nothing is
// written until Apply, and unchecking a row drops just that row.

(function () {
    const { open } = window.Modals;

    const ACTION_COLOR = {
        add: 'var(--se-up)',
        update: 'var(--se-accent)',
        'rename?': 'var(--se-warn)',
        'no change': 'var(--se-txt-dim)',
        error: 'var(--se-down)',
    };

    async function importCsv(targetFolderId, targetName) {
        let plan;
        try {
            plan = await rsterm.invoke('rs:csv.pick', { targetFolderId });
        } catch (err) {
            window.Forms.showBanner('error', `CSV: ${err.message}`);
            return;
        }
        if (!plan) return;
        showPreview(plan, targetName);
    }

    function showPreview(plan, targetName) {
        const body = document.createElement('div');
        body.style.minWidth = '640px';

        const summary = document.createElement('p');
        summary.style.cssText = 'margin-bottom:8px;color:var(--se-txt-dim);font-size:12px;';
        const c = plan.counts || {};
        summary.textContent =
            `${c.add || 0} to add, ${c.update || 0} to update, ` +
            `${c['rename?'] || 0} possible renames, ${c['no change'] || 0} unchanged, ` +
            `${c.error || 0} errors.` +
            (targetName ? ` Target folder: ${targetName}.` : '') +
            ' Nothing is deleted by an import.';
        body.appendChild(summary);

        if (plan.unknownColumns && plan.unknownColumns.length) {
            const warn = document.createElement('p');
            warn.style.cssText = 'margin-bottom:8px;color:var(--se-warn);font-size:12px;';
            warn.textContent = `Ignored unknown columns: ${plan.unknownColumns.join(', ')}`;
            body.appendChild(warn);
        }

        // Rows that do nothing are unchecked by default, and so are possible
        // renames - a rename is a guess, and guesses should be opt-in.
        const accepted = new Set(plan.rows
            .filter((r) => r.action === 'add' || r.action === 'update')
            .map((r) => r.line));

        const table = document.createElement('div');
        table.style.cssText = 'max-height:50vh;overflow:auto;';

        for (const row of plan.rows) {
            const line = document.createElement('div');
            line.className = 'csv-row';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = accepted.has(row.line);
            cb.disabled = row.action === 'error' || row.action === 'no change';
            cb.addEventListener('change', () => {
                if (cb.checked) accepted.add(row.line);
                else accepted.delete(row.line);
                updateApplyLabel();
            });

            const action = document.createElement('span');
            action.className = 'csv-action';
            action.textContent = row.action;
            action.style.color = ACTION_COLOR[row.action] || 'var(--se-txt)';

            const name = document.createElement('span');
            name.className = 'csv-name';
            name.textContent = row.name || `(line ${row.line})`;

            const detail = document.createElement('span');
            detail.className = 'csv-detail';
            detail.textContent = row.error
                ? row.error
                : (row.changes || []).map((ch) =>
                    `${ch.field}: ${fmt(ch.from)} -> ${fmt(ch.to)}`).join('  |  ');

            line.append(cb, action, name, detail);
            table.appendChild(line);
        }
        body.appendChild(table);

        let applyBtn = null;
        const updateApplyLabel = () => {
            if (applyBtn) applyBtn.textContent = `Apply ${accepted.size} change${accepted.size === 1 ? '' : 's'}`;
        };

        const modal = open('CSV Import Preview', body, [
            { label: 'Cancel' },
            {
                label: `Apply ${accepted.size} changes`, primary: true,
                onClick: () => {
                    rsterm.invoke('rs:csv.apply', { accept: [...accepted] })
                        .then((r) => {
                            window.SessionTree.refresh();
                            window.Forms.showBanner('warn',
                                `CSV import: ${r.added} added, ${r.updated} updated, ${r.renamed} renamed.`);
                        })
                        .catch((err) => window.Forms.showBanner('error', `CSV: ${err.message}`));
                },
            },
        ], { modal: true });
        applyBtn = modal.el.querySelector('.modal-actions .primary');
        updateApplyLabel();
    }

    function fmt(v) {
        if (v === null || v === undefined || v === '') return '(empty)';
        if (Array.isArray(v)) return v.join(',') || '(none)';
        return String(v);
    }

    async function exportCsv(folderId) {
        try {
            const r = await rsterm.invoke('rs:csv.export', { folderId });
            if (r) window.Forms.showBanner('warn', `Exported ${r.lines} sessions to ${r.path}`);
        } catch (err) {
            window.Forms.showBanner('error', `CSV export: ${err.message}`);
        }
    }

    window.CsvUI = { importCsv, exportCsv };
})();
