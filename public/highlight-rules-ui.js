'use strict';
// Highlight rule editor: one modal, a table of rules for the selected set,
// live-editable. Rules are ordered (first match wins) so rows can move up
// and down. A pattern that fails to compile shows a warning marker instead
// of silently vanishing.

(function () {
    const { open } = window.Modals;

    async function openEditor() {
        await window.Highlight.loadSets();
        const sets = JSON.parse(JSON.stringify(window.Highlight.getSets()));
        let current = sets[0];

        const body = document.createElement('div');
        body.style.minWidth = '640px';

        const setBar = document.createElement('div');
        setBar.className = 'field-row';
        const setPick = document.createElement('select');
        const rebuildSetPick = () => {
            setPick.replaceChildren();
            for (const s of sets) {
                const o = document.createElement('option');
                o.value = s.id;
                o.textContent = s.name;
                setPick.appendChild(o);
            }
            if (current) setPick.value = current.id;
        };
        setPick.addEventListener('change', () => {
            current = sets.find((s) => s.id === setPick.value);
            renderRules();
        });
        const addSet = document.createElement('button');
        addSet.textContent = 'New Set';
        addSet.addEventListener('click', () => {
            const s = {
                id: 'set-' + Date.now().toString(36),
                name: `Rule set ${sets.length + 1}`, rules: [],
            };
            sets.push(s);
            current = s;
            rebuildSetPick();
            renderRules();
        });
        const renameSet = document.createElement('button');
        renameSet.textContent = 'Rename';
        renameSet.addEventListener('click', async () => {
            const name = await window.Modals.promptText('Rename rule set', 'Set name', current.name);
            if (name) { current.name = name; rebuildSetPick(); }
        });
        setBar.append(setPick, addSet, renameSet);

        const table = document.createElement('div');
        table.style.cssText = 'max-height:50vh;overflow:auto;margin-top:8px;';

        const renderRules = () => {
            table.replaceChildren();
            const head = document.createElement('div');
            head.className = 'hl-row hl-head';
            for (const h of ['on', 'pattern', 're', 'word', 'text', 'back', 'B', 'blink', 'watch', '', '', '']) {
                const c = document.createElement('span');
                c.textContent = h;
                head.appendChild(c);
            }
            table.appendChild(head);

            current.rules.forEach((rule, i) => {
                const row = document.createElement('div');
                row.className = 'hl-row';

                const on = check(rule.enabled, (v) => { rule.enabled = v; });
                const pattern = document.createElement('input');
                pattern.value = rule.pattern;
                pattern.style.fontFamily = 'var(--mt-mono)';
                if (rule.compileError) pattern.style.borderColor = 'var(--se-down)';
                pattern.title = rule.compileError ? 'This pattern failed to compile and is inactive' : '';
                pattern.addEventListener('input', () => { rule.pattern = pattern.value; delete rule.compileError; });
                const re = check(rule.isRegex, (v) => { rule.isRegex = v; });
                const word = check(rule.wholeWord, (v) => { rule.wholeWord = v; });
                const fg = colorCell(rule.fg, (v) => { rule.fg = v; });
                const bg = colorCell(rule.bg, (v) => { rule.bg = v; });
                const bold = check(rule.bold, (v) => { rule.bold = v; });
                const blink = check(rule.blink, (v) => { rule.blink = v; });
                const watch = check(rule.watch, (v) => { rule.watch = v; });
                watch.title = 'Alert when this matches: badge the tab, note it in the ' +
                    'status line, and raise a system notification if the window is not focused';

                const up = smallBtn('↑', () => {
                    if (i > 0) {
                        [current.rules[i - 1], current.rules[i]] = [current.rules[i], current.rules[i - 1]];
                        renderRules();
                    }
                });
                const down = smallBtn('↓', () => {
                    if (i < current.rules.length - 1) {
                        [current.rules[i + 1], current.rules[i]] = [current.rules[i], current.rules[i + 1]];
                        renderRules();
                    }
                });
                const del = smallBtn('×', () => { current.rules.splice(i, 1); renderRules(); });

                row.append(on, pattern, re, word, fg, bg, bold, blink, watch, up, down, del);
                table.appendChild(row);
            });

            const add = document.createElement('button');
            add.textContent = '+ Rule';
            add.style.marginTop = '6px';
            add.addEventListener('click', () => {
                current.rules.push({
                    pattern: '', isRegex: false, wholeWord: true, caseSensitive: false,
                    fg: '#ff5252', bg: null, bold: false, blink: false, watch: false,
                    enabled: true,
                });
                renderRules();
            });
            table.appendChild(add);
        };

        function check(value, onSet) {
            const c = document.createElement('input');
            c.type = 'checkbox';
            c.checked = !!value;
            c.addEventListener('change', () => onSet(c.checked));
            return c;
        }
        function colorCell(value, onSet) {
            const wrap = document.createElement('span');
            wrap.style.cssText = 'display:flex;align-items:center;gap:2px;';
            const c = document.createElement('input');
            c.type = 'color';
            c.value = value || '#000000';
            c.style.cssText = 'width:24px;height:20px;padding:0;border:none;background:none;';
            const none = document.createElement('input');
            none.type = 'checkbox';
            none.checked = value !== null && value !== undefined;
            none.title = 'Use this color (unchecked = default)';
            const sync = () => onSet(none.checked ? c.value : null);
            c.addEventListener('input', () => { none.checked = true; sync(); });
            none.addEventListener('change', sync);
            wrap.append(none, c);
            return wrap;
        }
        function smallBtn(label, onClick) {
            const b = document.createElement('button');
            b.textContent = label;
            b.style.cssText = 'padding:0 5px;';
            b.addEventListener('click', onClick);
            return b;
        }

        rebuildSetPick();
        renderRules();
        body.append(setBar, table);

        open('Highlight rules (first match wins - order with ↑↓)', body, [
            { label: 'Cancel' },
            {
                label: 'Save', primary: true,
                onClick: () => {
                    rsterm.invoke('rs:highlights.save', { sets })
                        .then(() => window.Highlight.loadSets());
                },
            },
        ]);
    }

    window.HighlightRulesUI = { openEditor };
})();
