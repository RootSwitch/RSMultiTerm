'use strict';
// Splitting a MultiTerm back into tabs, against the real tabs.js and
// multi-exec.js in a sandbox with a stub DOM. A split is the reverse of a
// merge and carries the same promises:
//
//   1. Split into Tabs: every pane gets a tab of its own, in grid order,
//      right after the original; the first pane stays put. The SAME
//      sessions - nothing is opened or closed - and the tab you were typing
//      in comes to the front with the keyboard in its pane. The tab color
//      carries; a name typed for the group goes back to automatic.
//   2. Move to New Tab: one pane out, into a tab right after its old one,
//      which comes to the front; the rest of the MultiTerm stays, name and
//      all.
//   3. A one-pane tab has nothing to split.
//   4. Broadcast: a moved pane leaves the line-up (its new tab is unarmed,
//      and the MultiTerm's keystrokes no longer reach it); the MultiTerm
//      stays armed for a single move and is disarmed by a full split, with
//      a banner either way. An unarmed tab splits silently.
//   5. Merge hands the keyboard back to the pane you were in.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = path.join(__dirname, '..', 'public');

function el() {
    return {
        style: {}, classList: { toggle() {}, add() {}, remove() {} }, dataset: {},
        children: [], hidden: false, textContent: '', title: '', className: '',
        append(...k) { this.children.push(...k); }, appendChild(k) { this.children.push(k); return k; },
        replaceChildren() { this.children = []; }, addEventListener() {},
        querySelector() { return null; }, querySelectorAll() { return []; },
    };
}

function load() {
    const banners = [];
    const focused = [];
    const panes = new Map();
    const byId = { tabstrip: el(), 'broadcast-btn': el() };
    const window = {
        TermPanes: {
            panes,
            isReady: (sid) => panes.has(sid),
            isDead: () => false,
        },
        Forms: { showBanner: (kind, text) => banners.push({ kind, text }) },
        Modals: {},
    };
    const ctx = vm.createContext({
        window,
        document: { getElementById: (id) => byId[id] || null, createElement: el },
        rsterm: { invoke: () => ({ then: () => {} }), on: () => {} },
        requestAnimationFrame: (f) => f(),
        console,
    });
    for (const f of ['tabs.js', 'multi-exec.js']) {
        vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), ctx, { filename: f });
    }
    const T = window.Tabs, M = window.MultiExec;
    const pane = (sid) => {
        panes.set(sid, { sessionId: sid, title: sid, state: 'connected', term: { focus: () => focused.push(sid) } });
        return sid;
    };
    // A MultiTerm of n panes, like Start MultiTerm builds.
    const multiterm = (names) => {
        const tab = T.newTab(names[0]);
        for (const n of names) T.addSession(tab.id, pane(n));
        return tab;
    };
    const layout = () => T.tabs.map((t) => t.sessionIds.join('+')).join(' | ');
    return { T, M, banners, focused, multiterm, layout, pane };
}

let failures = 0;
function check(name, cond, detail) {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
    if (!cond) failures++;
}

console.log('split into tabs');
{
    const t = load();
    t.multiterm(['sw1', 'sw2', 'sw3', 'sw4']);
    const other = t.T.newTab('r1');
    t.T.addSession(other.id, t.pane('r1'));
    const mt = t.T.tabs[0];
    mt.color = '#e05561';
    mt.customTitle = 'Core switches';
    t.T.setFocused('sw3');
    const n = t.T.splitTab(mt);
    check('reports three moved', n === 3, n);
    check('one tab each, in grid order, right after the original',
        t.layout() === 'sw1 | sw2 | sw3 | sw4 | r1', t.layout());
    check('the pane you were in comes to the front', t.T.active().sessionIds[0] === 'sw3',
        t.T.active().sessionIds.join());
    check('with the keyboard', t.focused[t.focused.length - 1] === 'sw3', t.focused.join());
    check('the color carries to every split tab',
        t.T.tabs.slice(0, 4).every((tab) => tab.color === '#e05561'));
    check('the group name goes back to automatic', !mt.customTitle && mt.title === 'sw1', mt.title);
    check('the same four sessions, each in exactly one tab',
        ['sw1', 'sw2', 'sw3', 'sw4'].every((s) => t.T.tabs.filter((tab) => tab.sessionIds.includes(s)).length === 1));
}

console.log('move to new tab');
{
    const t = load();
    const mt = t.multiterm(['sw1', 'sw2', 'sw3']);
    mt.customTitle = 'Core switches';
    t.T.setFocused('sw2');
    check('moves', t.T.moveToNewTab('sw2') === true);
    check('into a tab right after the MultiTerm', t.layout() === 'sw1+sw3 | sw2', t.layout());
    check('which comes to the front, keyboard in it',
        t.T.active().sessionIds[0] === 'sw2' && t.focused[t.focused.length - 1] === 'sw2');
    check('the MultiTerm keeps its name', mt.customTitle === 'Core switches');
    check('and focuses a pane it still has', mt.sessionIds.includes(mt.focusedSessionId), mt.focusedSessionId);
}

console.log('nothing to split');
{
    const t = load();
    const solo = t.multiterm(['sw1']);
    solo.customTitle = 'Router';
    check('a one-pane tab splits into nothing', t.T.splitTab(solo) === 0 && t.layout() === 'sw1');
    check('and keeps its name (the palette can still ask)', solo.customTitle === 'Router', solo.customTitle);
    check('and its pane cannot move out', t.T.moveToNewTab('sw1') === false && t.layout() === 'sw1');
    check('an unknown session does nothing', t.T.moveToNewTab('nope') === false);
}

console.log('broadcast');
{
    const t = load();
    const mt = t.multiterm(['sw1', 'sw2', 'sw3']);
    t.M.toggleBroadcast();
    check('armed: a keystroke reaches all three', t.M.routeInput('sw1').length === 3);
    t.T.moveToNewTab('sw2');
    check('after a move, the MultiTerm still reaches the two it has',
        JSON.stringify(t.M.routeInput('sw1')) === JSON.stringify(['sw1', 'sw3']),
        JSON.stringify(t.M.routeInput('sw1')));
    check('the moved pane talks only to itself', JSON.stringify(t.M.routeInput('sw2')) === '["sw2"]');
    check('and a banner says it left', t.banners.length === 1 && /left the broadcast/.test(t.banners[0].text),
        JSON.stringify(t.banners));
    t.T.splitTab(mt);
    check('and says so', t.banners.length === 2 && /Broadcast turned off: the MultiTerm was split into 2 tabs/
        .test(t.banners[1].text), JSON.stringify(t.banners[1]));
    // One pane broadcasts to itself either way; a pane added later shows
    // whether what was left is still armed.
    t.T.addSession(mt.id, t.pane('sw9'));
    check('a full split disarms what is left', t.M.routeInput('sw1').length === 1 &&
        !t.banners.some((b) => /armed here/.test(b.text)), JSON.stringify(t.M.routeInput('sw1')));
    // Merging them back is a merge into an UNARMED tab: no broadcast, no banner.
    t.T.mergeAll();
    check('merged back, nothing is armed', t.M.routeInput('sw1').length === 1);
}
{
    const t = load();
    const mt = t.multiterm(['sw1', 'sw2']);
    t.T.splitTab(mt);
    check('an unarmed MultiTerm splits without a banner', t.banners.length === 0, JSON.stringify(t.banners));
}

console.log('merge hands the keyboard back');
{
    const t = load();
    for (const n of ['sw1', 'sw2', 'sw3']) { const tab = t.T.newTab(n); t.T.addSession(tab.id, t.pane(n)); }
    t.T.activate(t.T.tabs[2].id);
    t.focused.length = 0;
    t.T.mergeAll();
    check('one tab of three', t.layout() === 'sw1+sw2+sw3', t.layout());
    check('the pane you were in stays focused', t.T.active().focusedSessionId === 'sw3', t.T.active().focusedSessionId);
    check('with the keyboard', t.focused[t.focused.length - 1] === 'sw3', t.focused.join());
}

if (failures) {
    console.error(`FAIL - tab split: ${failures} check(s) failed`);
    process.exit(1);
}
console.log('ok - tab split (split into tabs, move to new tab, same sessions, broadcast leaves with the pane, ' +
    'merge hands focus back)');
