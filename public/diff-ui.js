'use strict';
// The diff view. Two entry points into the same window:
//   - Compare panes: pre-fills both sides with each pane's last command
//     output, captured by the prompt heuristic.
//   - Blank: two empty panes to paste into, which is the daily "compare two
//     show runs from anywhere" case.
//
// Both land in the same editable panes. The heuristic pre-fills; the human
// trims. Treating a guess as ground truth is how a diff tool loses trust.

(function () {
    const { open } = window.Modals;

    function paneScrollback(pane) {
        const buf = pane.term.buffer.active;
        const lines = [];
        for (let i = 0; i < buf.length; i++) {
            const line = buf.getLine(i);
            if (line) lines.push(line.translateToString(true));
        }
        // Trailing blank rows are terminal padding, not content.
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        return lines;
    }

    function openDiff(leftText, rightText, leftLabel, rightLabel, note) {
        const body = document.createElement('div');
        body.style.cssText = 'min-width:min(900px, 90vw);';

        const bar = document.createElement('div');
        bar.style.cssText = 'display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap;';

        const mkCheck = (label, checked, title) => {
            const w = document.createElement('label');
            w.style.cssText = 'display:flex;align-items:center;gap:4px;color:var(--se-txt);font-size:12px;';
            const c = document.createElement('input');
            c.type = 'checkbox';
            c.checked = checked;
            if (title) w.title = title;
            w.append(c, document.createTextNode(label));
            return { wrap: w, input: c };
        };
        const ws = mkCheck('Ignore trailing spaces', true,
            'Devices pad columns inconsistently between captures');
        const allWs = mkCheck('Ignore all whitespace', false,
            'For output that reflows between captures');
        const caseIns = mkCheck('Ignore case', false);
        const inline = mkCheck('Inline', false,
            'Side by side keeps columns aligned, which is usually what you want for network output');

        const strip = document.createElement('input');
        strip.placeholder = 'strip regex (e.g. uptime is .*$)';
        strip.style.cssText = 'flex:1;min-width:160px;font-family:var(--mt-mono);font-size:11px;';
        strip.title = 'Lines are compared with anything matching this removed - use it to ignore counters and timestamps';

        const stats = document.createElement('span');
        stats.style.cssText = 'color:var(--se-txt-dim);font-size:12px;margin-left:auto;';

        bar.append(ws.wrap, allWs.wrap, caseIns.wrap, inline.wrap, strip, stats);
        body.appendChild(bar);

        if (note) {
            const n = document.createElement('div');
            n.style.cssText = 'color:var(--se-warn);font-size:11px;margin-bottom:6px;';
            n.textContent = note;
            body.appendChild(n);
        }

        // Editable sources. Kept visible above the result so trimming a bad
        // capture is obvious rather than hidden behind a mode switch.
        const sources = document.createElement('div');
        sources.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;';
        const mkPane = (label, value) => {
            const wrap = document.createElement('div');
            const h = document.createElement('div');
            h.style.cssText = 'font-size:11px;color:var(--se-txt-dim);margin-bottom:2px;';
            h.textContent = label;
            const ta = document.createElement('textarea');
            ta.value = value || '';
            ta.spellcheck = false;
            ta.style.cssText = 'width:100%;height:110px;font-family:var(--mt-mono);font-size:11px;' +
                'white-space:pre;overflow:auto;';
            wrap.append(h, ta);
            return { wrap, ta };
        };
        const leftPane = mkPane(leftLabel || 'Left (paste here)', leftText);
        const rightPane = mkPane(rightLabel || 'Right (paste here)', rightText);
        sources.append(leftPane.wrap, rightPane.wrap);
        body.appendChild(sources);

        const result = document.createElement('div');
        result.className = 'diff-result';
        body.appendChild(result);

        const render = () => {
            const opts = {
                ignoreTrailingWhitespace: ws.input.checked,
                ignoreAllWhitespace: allWs.input.checked,
                ignoreCase: caseIns.input.checked,
                stripPatterns: strip.value.trim() ? [strip.value.trim()] : [],
            };
            const d = window.DiffEngine.diff(leftPane.ta.value, rightPane.ta.value, opts);
            stats.textContent =
                `${d.stats.change} changed, ${d.stats.add} added, ${d.stats.del} removed, ${d.stats.same} same`;
            result.replaceChildren();
            result.classList.toggle('inline', inline.input.checked);

            if (inline.input.checked) {
                for (const row of d.rows) {
                    if (row.type === 'same') result.appendChild(mkLine(' ', row.left, 'same'));
                    else {
                        if (row.left !== null) result.appendChild(mkLine('-', row.left, 'del'));
                        if (row.right !== null) result.appendChild(mkLine('+', row.right, 'add'));
                    }
                }
            } else {
                for (const row of d.rows) {
                    const line = document.createElement('div');
                    line.className = `diff-row ${row.type}`;
                    const l = document.createElement('span');
                    l.className = 'diff-cell';
                    l.textContent = row.left === null ? '' : row.left;
                    const r = document.createElement('span');
                    r.className = 'diff-cell';
                    r.textContent = row.right === null ? '' : row.right;
                    line.append(l, r);
                    result.appendChild(line);
                }
            }
        };
        function mkLine(marker, text, cls) {
            const line = document.createElement('div');
            line.className = `diff-row ${cls}`;
            const c = document.createElement('span');
            c.className = 'diff-cell';
            c.textContent = `${marker} ${text === null ? '' : text}`;
            line.appendChild(c);
            return line;
        }

        for (const el of [ws.input, allWs.input, caseIns.input, inline.input]) {
            el.addEventListener('change', render);
        }
        // Typing re-runs the full LCS (up to the 4M-cell cap); per-keystroke
        // that means ~16MB of allocation per character. Debounced: the diff
        // updates when the typing pauses, which is when anyone reads it.
        let renderTimer = null;
        const renderSoon = () => {
            if (renderTimer) clearTimeout(renderTimer);
            renderTimer = setTimeout(render, 150);
        };
        strip.addEventListener('input', renderSoon);
        leftPane.ta.addEventListener('input', renderSoon);
        rightPane.ta.addEventListener('input', renderSoon);
        render();

        open('Diff', body, [{ label: 'Close', primary: true }], { wide: true });
    }

    // Compare the last command output of two panes in the active tab.
    function comparePanes() {
        const tab = window.Tabs.active();
        const ids = tab ? tab.sessionIds : [];
        if (ids.length < 2) {
            openDiff('', '', 'Left (paste here)', 'Right (paste here)');
            return;
        }
        // Focused pane first, then the next one along - the usual intent
        // when someone hits diff with a grid open.
        const first = tab.focusedSessionId || ids[0];
        const second = ids.find((id) => id !== first);
        const a = window.TermPanes.panes.get(first);
        const b = window.TermPanes.panes.get(second);
        const capA = window.DiffEngine.lastCommandOutput(paneScrollback(a));
        const capB = window.DiffEngine.lastCommandOutput(paneScrollback(b));
        const note = (!capA.confident || !capB.confident)
            ? 'Could not find a prompt in one of the panes, so the whole buffer is shown - trim it above.'
            : null;
        openDiff(capA.text, capB.text, `${a.title} (last command)`, `${b.title} (last command)`, note);
    }

    function blankDiff() {
        openDiff('', '', 'Left (paste here)', 'Right (paste here)');
    }

    window.DiffUI = { comparePanes, blankDiff, openDiff };
})();
