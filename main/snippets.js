'use strict';
// Command snippets: named, reusable command sequences with {{param}}
// placeholders, sent to the focused pane or the whole broadcast. The
// SecureCRT command-manager feature, surfaced through the Snippets dialog
// and the command palette rather than a button bar.
//
// Snippets ride the team file like highlight sets do: they carry no
// secrets by construction - parameters are asked for at send time and
// never stored, and the serializer's whitelist applies on the way out.

const store = require('./store');

let data = null;
const listeners = [];

// A tiny starter set, written once on first run and fully editable after.
const DEFAULT_SNIPPETS = [
    {
        id: 'snip-save-config',
        name: 'Save config',
        command: 'copy running-config startup-config\n',
        notes: 'The trailing blank line answers the destination-filename prompt.',
    },
    {
        id: 'snip-bounce-interface',
        name: 'Bounce interface {{interface}}',
        command: 'configure terminal\ninterface {{interface}}\nshutdown\nno shutdown\nend',
        notes: 'Shut/no-shut one interface. Asks which one at send time.',
    },
    {
        id: 'snip-interface-health',
        name: 'Interface health {{interface}}',
        command: 'show interface {{interface}} | include line protocol|duplex|errors|CRC|collisions',
        notes: 'The one-line answer to "is this port okay".',
    },
];

function init() {
    data = store.load('snippets', null);
    if (!data) {
        data = { schema: 1, snippets: DEFAULT_SNIPPETS.map((s) => ({ ...s })) };
        store.save('snippets', data);
    }
}

function onChange(fn) { listeners.push(fn); }

function get() { return data.snippets; }

function save(snippets) {
    if (!Array.isArray(snippets)) throw new Error('snippets must be an array');
    for (const s of snippets) {
        if (!s || typeof s !== 'object' ||
            typeof s.id !== 'string' || typeof s.name !== 'string' ||
            typeof s.command !== 'string') {
            throw new Error('each snippet needs id, name and command');
        }
    }
    data.snippets = snippets;
    store.save('snippets', data);
    for (const fn of listeners) fn();
}

module.exports = { init, onChange, get, save };
