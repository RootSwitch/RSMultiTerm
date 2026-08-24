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
            if (e.key !== 'Escape') return;
            if (stack[stack.length - 1] !== backdrop) return;   // not the top dialog
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

    // Give the keyboard back - but only if nothing else has claimed it.
    // After the menu goes, focus has fallen to <body>; if it is anywhere
    // else, something took it deliberately (a dialog the item opened, a
    // field it focused) and must not be interrupted.
    function restoreFocus() {
        const prev = returnFocusTo;
        returnFocusTo = null;
        if (!prev || !prev.isConnected || prev === document.body) return;
        const now = document.activeElement;
        if (now && now !== document.body) return;
        try { prev.focus(); } catch (_) { /* gone between then and now */ }
    }

    window.Modals = { open, row, input, select, promptText, menu, closeMenu };
})();
