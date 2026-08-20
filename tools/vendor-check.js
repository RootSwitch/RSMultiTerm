'use strict';
// Fails npm test when public/vendor/ no longer byte-matches the installed
// @xterm packages - which happens when someone bumps a devDependency and
// forgets `npm run vendor`, the silent-drift failure mode of vendoring.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const destDir = path.join(root, 'public', 'vendor', 'xterm');

let manifest;
try {
    manifest = JSON.parse(fs.readFileSync(path.join(destDir, 'vendored.json'), 'utf8'));
} catch (e) {
    console.error('vendor-check: missing or unreadable vendored.json - run `npm run vendor`');
    process.exit(1);
}

const SOURCE = {
    'xterm.js': ['@xterm/xterm', 'lib/xterm.js'],
    'xterm.css': ['@xterm/xterm', 'css/xterm.css'],
    'addon-clipboard.js': ['@xterm/addon-clipboard', 'lib/addon-clipboard.js'],
    'addon-fit.js': ['@xterm/addon-fit', 'lib/addon-fit.js'],
    'addon-search.js': ['@xterm/addon-search', 'lib/addon-search.js'],
    'addon-serialize.js': ['@xterm/addon-serialize', 'lib/addon-serialize.js'],
    'addon-webgl.js': ['@xterm/addon-webgl', 'lib/addon-webgl.js'],
};

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

let failed = false;
for (const [dest, [pkg, rel]] of Object.entries(SOURCE)) {
    const vendored = path.join(destDir, dest);
    const installed = path.join(root, 'node_modules', pkg, rel);
    if (!fs.existsSync(vendored)) {
        console.error(`vendor-check: ${dest} not vendored - run \`npm run vendor\``);
        failed = true;
        continue;
    }
    if (!fs.existsSync(installed)) {
        console.error(`vendor-check: ${pkg} not installed - run \`npm install\``);
        failed = true;
        continue;
    }
    if (sha(vendored) !== sha(installed)) {
        const entry = manifest.find((m) => m.file === dest);
        console.error(`vendor-check: ${dest} differs from installed ${pkg}` +
            (entry ? ` (vendored at ${entry.version})` : '') + ' - run `npm run vendor`');
        failed = true;
    }
}

// Vendoring the file is only half of it: index.html has to LOAD it. A
// renderer that says `new SerializeAddon.SerializeAddon()` with no script
// tag for it throws inside pane creation, which takes down every session
// in the app rather than the one feature - a real bug this check exists to
// have caught. So: every addon global the renderer references must have a
// matching vendor script tag.
const GLOBALS = {
    Terminal: 'xterm.js',
    ClipboardAddon: 'addon-clipboard.js',
    FitAddon: 'addon-fit.js',
    SearchAddon: 'addon-search.js',
    SerializeAddon: 'addon-serialize.js',
    WebglAddon: 'addon-webgl.js',
};

const publicDir = path.join(root, 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const rendererJs = fs.readdirSync(publicDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(publicDir, f), 'utf8'))
    .join('\n');

for (const [global, file] of Object.entries(GLOBALS)) {
    const used = new RegExp(`\\bnew\\s+${global}\\.|\\b${global}\\s*\\.`).test(rendererJs);
    const loaded = html.includes(`vendor/xterm/${file}`);
    if (used && !loaded) {
        console.error(`vendor-check: renderer code uses ${global} but index.html does not ` +
            `load vendor/xterm/${file} - pane creation will throw`);
        failed = true;
    }
}

if (failed) process.exit(1);
console.log('vendor-check: ok (files match npm; every addon the renderer uses is loaded)');
