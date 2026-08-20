'use strict';
// Quick-select hints (the Alacritty/WezTerm move, tuned for network work):
// Ctrl+Shift+Space overlays a key label on every IP, MAC, interface name and
// URL visible in the focused pane. Type a label to copy its text; hold Alt
// on the last key of an IP or hostname to open an SSH session to it instead.
// Escape (or any unmatched key) leaves the mode.

(function () {
    // First matching pattern claims the range, so order matters: interfaces
    // before bare numbers, IPv4 with prefix-length before plain IPv4.
    const PATTERNS = [
        {
            kind: 'iface',
            re: /\b(?:GigabitEthernet|TenGigabitEthernet|TwentyFiveGigE|FortyGigE|HundredGigE|FastEthernet|Port-channel|Ethernet|Loopback|Tunnel|Vlan|Gi|Te|Twe|Fo|Hu|Fa|Po|Lo)\d+(?:\/\d+)*(?:\.\d+)?\b/g,
        },
        {
            kind: 'ipv4', ssh: true,
            re: /\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g,
        },
        {
            // Needs :: or four-plus groups, same discipline as the shipped
            // highlight rule - a loose pattern paints every clock in syslog.
            kind: 'ipv6', ssh: true,
            re: /\b(?:[0-9a-fA-F]{1,4}:){4,7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:)*:(?::|[0-9a-fA-F]{1,4})(?::[0-9a-fA-F]{1,4})*\b/g,
        },
        {
            kind: 'mac',
            re: /\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b|\b(?:[0-9a-fA-F]{4}\.){2}[0-9a-fA-F]{4}\b/g,
        },
        {
            kind: 'url',
            re: /\bhttps?:\/\/[^\s"'<>]+/g,
        },
    ];

    const LABELS = 'asdfghjkl;qwertyuiopzxcvbnm';

    let active = null;   // {pane, hints: [{label, text, kind, deco, marker}], typed}

    function labelFor(i, total) {
        if (total <= LABELS.length) return LABELS[i];
        return LABELS[Math.floor(i / LABELS.length)] + LABELS[i % LABELS.length];
    }

    function open() {
        close();
        const tab = window.Tabs.active();
        const pane = tab && window.TermPanes.panes.get(tab.focusedSessionId);
        if (!pane) return;
        const term = pane.term;
        const buf = term.buffer.active;

        // Scan the viewport only - hints are about what the eye can see.
        const found = [];
        const top = buf.viewportY;
        const bottom = Math.min(top + term.rows, buf.length);
        for (let y = top; y < bottom; y++) {
            const line = buf.getLine(y);
            if (!line) continue;
            const text = line.translateToString(true);
            const claimed = [];
            for (const p of PATTERNS) {
                p.re.lastIndex = 0;
                let m;
                while ((m = p.re.exec(text)) !== null) {
                    if (!m[0].length) { p.re.lastIndex++; continue; }
                    const a = m.index;
                    const b = a + m[0].length;
                    if (claimed.some(([ca, cb]) => a < cb && b > ca)) continue;
                    claimed.push([a, b]);
                    found.push({ y, x: a, width: m[0].length, text: m[0], kind: p.kind, ssh: !!p.ssh });
                }
            }
        }
        if (!found.length) {
            setStatus('hints: nothing on screen to grab');
            return;
        }

        const hints = [];
        found.slice(0, LABELS.length * LABELS.length).forEach((f, i) => {
            const delta = f.y - (buf.baseY + buf.cursorY);
            let marker;
            try { marker = term.registerMarker(delta); } catch (_) { return; }
            if (!marker) return;
            const deco = term.registerDecoration({ marker, x: f.x, width: f.width, layer: 'top' });
            if (!deco) { marker.dispose(); return; }
            const label = labelFor(i, found.length);
            deco.onRender((el) => {
                el.classList.add('mt-hint');
                el.dataset.hintLabel = label;
            });
            hints.push({ ...f, label, deco, marker });
        });

        active = { pane, hints, typed: '' };
        window.addEventListener('keydown', onKey, true);
        setStatus(`hints: ${hints.length} targets - type a label to copy` +
            (hints.some((h) => h.ssh) ? ', Alt+label to SSH' : '') + ', Esc to leave');
    }

    function onKey(e) {
        if (!active) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === 'Escape') { close(); return; }
        if (e.key === 'Shift' || e.key === 'Alt' || e.key === 'Control' || e.key === 'Meta') return;
        const ch = (e.key || '').toLowerCase();
        if (ch.length !== 1) { close(); return; }

        const typed = active.typed + ch;
        const matches = active.hints.filter((h) => h.label.startsWith(typed));
        if (!matches.length) { close(); return; }
        if (matches.length === 1 && matches[0].label === typed) {
            const hit = matches[0];
            const wantSsh = e.altKey && hit.ssh;
            close();
            if (wantSsh) {
                // Strip a prefix-length before dialing: "10.1.1.1/24" is a
                // thing on screen, "/24" is not part of the host.
                window.App.quickSsh(hit.text.replace(/\/\d+$/, ''));
            } else {
                navigator.clipboard.writeText(hit.text)
                    .then(() => setStatus(`copied: ${hit.text}`), () => setStatus('clipboard write blocked'));
            }
            return;
        }
        active.typed = typed;
        // Narrowing: hide labels that can no longer match.
        for (const h of active.hints) {
            h.deco.element && h.deco.element.classList.toggle('mt-hint-dead', !h.label.startsWith(typed));
        }
    }

    function close() {
        if (!active) return;
        for (const h of active.hints) { h.deco.dispose(); h.marker.dispose(); }
        window.removeEventListener('keydown', onKey, true);
        const pane = active.pane;
        active = null;
        if (pane && window.TermPanes.panes.has(pane.sessionId)) pane.term.focus();
    }

    function setStatus(text) {
        const el = document.getElementById('status-text');
        if (el) el.textContent = text;
    }

    window.Hints = { open, close, isOpen: () => !!active };
})();
