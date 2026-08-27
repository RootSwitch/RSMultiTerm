'use strict';
// Shared modal plumbing so every dialog (editors, prompts, confirms) builds
// the same way and closes the same way (Escape, backdrop click, Cancel).

(function () {
    // Open-modal stack, top last. Escape must close ONLY the top dialog:
    // each open() registers its own document listener, and stopPropagation
    // does not stop other listeners on the same node - one Escape used to
    // rip through a password prompt AND the settings dialog under it,
    // firing both onCancels.
    const stack = [];

    function open(title, bodyEl, actions, opts = {}) {
        // Same story as the menus: a dialog steals the keyboard and has to
        // hand it back, or confirming a multi-line paste leaves the pane
        // unfocused and the command sitting there unsent.
        const cameFrom = document.activeElement;
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        const modal = document.createElement('div');
        modal.className = 'modal' + (opts.wide ? ' wide' : '');

        const h = document.createElement('h2');
        h.textContent = title;

        const body = document.createElement('div');
        body.className = 'modal-body';
        body.appendChild(bodyEl);

        const bar = document.createElement('div');
        bar.className = 'modal-actions';

        const closeModal = () => {
            backdrop.remove();
            const at = stack.indexOf(backdrop);
            if (at !== -1) stack.splice(at, 1);
            document.removeEventListener('keydown', onKey, true);
            returnFocusTo = cameFrom;
            restoreFocus();
        };
        const onKey = (e) => {
            if (stack[stack.length - 1] !== backdrop) return;   // not the top dialog
            // Focus trap: Tab must cycle inside the dialog. Without this it
            // walked out to the xterm textarea BEHIND the backdrop, and the
            // next keystrokes went to a live device - through the broadcast
            // router if one was armed - while the user believed they were
            // typing into a password prompt.
            if (e.key === 'Tab') {
                const focusable = [...modal.querySelectorAll(
                    'button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])',
                )].filter((el) => !el.disabled && el.offsetParent !== null);
                if (!focusable.length) { e.preventDefault(); return; }
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                const inDialog = modal.contains(document.activeElement);
                if (!inDialog) { e.preventDefault(); first.focus(); return; }
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault(); last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault(); first.focus();
                }
                return;
            }
            if (e.key !== 'Escape') return;
            e.stopImmediatePropagation();
            closeModal();
            if (opts.onCancel) opts.onCancel();
        };
        document.addEventListener('keydown', onKey, true);
        stack.push(backdrop);

        for (const a of actions) {
            const btn = document.createElement('button');
            btn.textContent = a.label;
            if (a.primary) btn.className = 'primary';
            btn.addEventListener('click', () => {
                // Handler returning false keeps the modal open (validation).
                const r = a.onClick ? a.onClick() : undefined;
                if (r !== false) closeModal();
            });
            bar.appendChild(btn);
        }

        // Enter in a text field presses the primary button - the muscle
        // memory of every login box. Dialogs that handle Enter themselves
        // (promptText, the password prompts) call preventDefault and are
        // left alone; selects and textareas keep their own Enter.
        modal.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || e.defaultPrevented) return;
            const t = e.target;
            if (!t || t.tagName !== 'INPUT' || t.type === 'checkbox' || t.type === 'radio') return;
            const primary = bar.querySelector('button.primary');
            if (!primary || primary.disabled) return;
            e.preventDefault();
            primary.click();
        });

        modal.append(h, body, bar);
        backdrop.appendChild(modal);
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop && !opts.modal) {
                closeModal();
                if (opts.onCancel) opts.onCancel();
            }
        });
        document.body.appendChild(backdrop);
        return { close: closeModal, el: modal };
    }

    // field helpers -------------------------------------------------------
    function row(labelText, inputEl) {
        const r = document.createElement('div');
        r.className = 'field-row';
        const l = document.createElement('label');
        l.textContent = labelText;
        r.append(l, inputEl);
        return r;
    }

    // A label ABOVE its field, for anything that wants the full width: a
    // multi-line command in a label-beside-field row gets whatever is left
    // after the label, which is not enough to see a command on one line.
    function stacked(labelText, el, hintText) {
        const wrap = document.createElement('div');
        wrap.className = 'field-stack';
        const l = document.createElement('label');
        l.textContent = labelText;
        wrap.append(l, el);
        if (hintText) {
            const h = document.createElement('p');
            h.className = 'field-hint';
            h.textContent = hintText;
            wrap.appendChild(h);
        }
        return wrap;
    }

    function input(value, placeholder, type = 'text') {
        const i = document.createElement('input');
        i.type = type;
        i.value = value === null || value === undefined ? '' : value;
        if (placeholder) i.placeholder = placeholder;
        return i;
    }

    function select(options, value) {
        const s = document.createElement('select');
        for (const o of options) {
            const opt = document.createElement('option');
            opt.value = o.value;
            opt.textContent = o.label;
            s.appendChild(opt);
        }
        if (value !== undefined && value !== null) s.value = value;
        return s;
    }

    // One text field, OK/Cancel, resolving to the trimmed value or null.
    // Electron has no window.prompt (it throws), so every "ask for a name"
    // dialog goes through this instead.
    function promptText(title, labelText, value) {
        return new Promise((resolve) => {
            const wrap = document.createElement('div');
            const field = input(value, '');
            wrap.appendChild(row(labelText, field));
            let done = false;
            const finish = (v) => { if (!done) { done = true; resolve(v || null); } };
            const m = open(title, wrap, [
                { label: 'Cancel', onClick: () => finish(null) },
                { label: 'OK', primary: true, onClick: () => finish(field.value.trim()) },
            ], { onCancel: () => finish(null) });
            field.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    m.close();
                    finish(field.value.trim());
                }
            });
            field.focus();
            field.select();
        });
    }

    // Floating context menu. items: [{label, onClick, disabled}] or null for
    // a separator. Closes on the next click anywhere, on Escape, and flips
    // itself back on screen when opened near an edge.
    function menu(x, y, items) {
        closeMenu();
        // Where the keyboard was before the menu took it. Clicking an item
        // moves focus to that button, and closing removes the button, which
        // drops focus to <body> - so a Paste worked but the Enter after it
        // went nowhere and the pane had to be clicked again.
        returnFocusTo = document.activeElement;
        const el = document.createElement('div');
        el.className = 'rs-menu';
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;

        for (const item of items) {
            if (!item) {
                const sep = document.createElement('div');
                sep.className = 'rs-menu-sep';
                el.appendChild(sep);
                continue;
            }
            // A checkbox item: {label, checked, onClick(nowChecked)}. It stays
            // open when toggled - the state IS the information, and a menu
            // that closes on the click hides what just changed.
            if (typeof item.checked === 'boolean') {
                const lbl = document.createElement('label');
                lbl.className = 'rs-menu-check';
                const box = document.createElement('input');
                box.type = 'checkbox';
                box.checked = item.checked;
                box.addEventListener('change', () => item.onClick(box.checked));
                const text = document.createElement('span');
                text.textContent = item.label;
                lbl.append(box, text);
                el.appendChild(lbl);
                continue;
            }
            const b = document.createElement('button');
            b.textContent = item.label;
            b.disabled = !!item.disabled;
            b.addEventListener('click', () => { closeMenu(); item.onClick(); });
            el.appendChild(b);
        }
        document.body.appendChild(el);

        // Flip back on screen near an edge: left of the pointer when it
        // would run off the right, above it when it would run off the
        // bottom. A menu with more items than the window is tall cannot be
        // flipped anywhere useful, so it pins to the top and scrolls.
        const r = el.getBoundingClientRect();
        if (r.right > window.innerWidth) el.style.left = `${Math.max(0, window.innerWidth - r.width - 4)}px`;
        if (r.bottom > window.innerHeight) el.style.top = `${Math.max(4, y - r.height)}px`;

        // A mousedown OUTSIDE the menu dismisses it - outside being the
        // whole point. Dismissing on any mousedown tore the menu out of the
        // DOM between mousedown and mouseup, so the click never reached the
        // item and landed on whatever the menu had been covering: every
        // menu item in the app did nothing, or worse, pressed the button
        // underneath. Registered async so the click that opened the menu
        // does not immediately close it. The key listener is NOT
        // once-per-any-key: that let one arrow press consume it, after
        // which Escape no longer closed the menu.
        const onOutside = (ev) => {
            if (!el.contains(ev.target)) closeMenu();
        };
        setTimeout(() => {
            document.addEventListener('mousedown', onOutside, { capture: true });
            document.addEventListener('keydown', onEsc, { capture: true });
        });
        openMenu = { el, onOutside };
        return el;
    }
    function onEsc(e) {
        if (e.key === 'Escape') closeMenu();
    }
    // The menu currently on screen, so closeMenu can take its listener back
    // off the document - an outside-click handler that outlives its menu
    // would close the NEXT one on its first click.
    let openMenu = null;
    let returnFocusTo = null;
    function closeMenu() {
        document.removeEventListener('keydown', onEsc, { capture: true });
        if (openMenu) {
            document.removeEventListener('mousedown', openMenu.onOutside, { capture: true });
            openMenu = null;
        }
        const el = document.querySelector('.rs-menu');
        if (el) el.remove();
        restoreFocus();
    }

    // Give the keyboard back - but only if nothing else has claimed it,
    // and never to a CHROME CONTROL. Focus returned to the toolbar button
    // that opened a dialog sits there invisibly armed: the numpad Enter
    // meant for the terminal presses the button instead and the dialog
    // reopens, with no hint of why until the focus ring lights up. The
    // element that opened the thing is the right home only when it is a
    // still-open dialog (stacked editors) or the terminal itself; for
    // everything else, the next keystroke in this app is headed for the
    // focused pane, so that is where the keyboard goes.
    function restoreFocus() {
        const prev = returnFocusTo;
        returnFocusTo = null;
        const now = document.activeElement;
        // Something took focus deliberately (a dialog the item opened, a
        // field it focused) - never interrupt that.
        if (now && now !== document.body) return;
        // A dialog is still open: the keyboard stays INSIDE it, in the old
        // element when that element lives there, else its first control.
        // Never the terminal - keystrokes reaching a live device behind a
        // backdrop is the exact hazard the Tab trap exists to stop.
        if (stack.length) {
            const top = stack[stack.length - 1];
            const home = (prev && prev.isConnected && top.contains(prev)) ? prev
                : top.querySelector('button, input, select, textarea');
            if (home) { try { home.focus(); } catch (_) { /* torn down */ } }
            return;
        }
        if (prev && prev.isConnected && prev !== document.body && prev.closest &&
            prev.closest('.rs-term-host')) {
            try { prev.focus(); } catch (_) { /* gone between then and now */ }
            return;
        }
        const tab = window.Tabs && window.Tabs.active && window.Tabs.active();
        const pane = tab && tab.focusedSessionId && window.TermPanes &&
            window.TermPanes.panes.get(tab.focusedSessionId);
        if (pane && pane.term) {
            try { pane.term.focus(); return; } catch (_) { /* torn down */ }
        }
        // No pane to give it to: focus resting on <body> is harmless;
        // focus resting on a button is a loaded spring.
    }

    window.Modals = { open, row, stacked, input, select, promptText, menu, closeMenu };
})();
