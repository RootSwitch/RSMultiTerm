'use strict';
// Stamp the app icon and version strings into RSMultiTerm.exe after packing.
//
// electron-builder normally does this with rcedit, but that lives behind its
// signAndEditExecutable switch - and turning that on makes it fetch a
// code-signing bundle whose macOS symlinks will not extract without the
// symlink privilege Windows reserves for developer mode, which fails the
// whole build. So the switch stays off and this does the one part of it that
// actually matters here.
//
// Without this the installer and portable stubs carry the app icon (NSIS
// applies those itself) while the exe inside wears Electron's, which is what
// shows in the title bar, Alt-Tab, and any shortcut to the installed app.

const fs = require('fs');
const path = require('path');
// v5 exports a named function rather than the module itself.
const { rcedit } = require('rcedit');

exports.default = async function afterPack(context) {
    if (context.electronPlatformName !== 'win32') return;

    const root = path.join(__dirname, '..');
    const icon = path.join(root, 'build', 'icon.ico');
    if (!fs.existsSync(icon)) {
        throw new Error('build/icon.ico is missing - run `npm run icon` before building');
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
    if (!fs.existsSync(exe)) throw new Error(`packed executable not found: ${exe}`);

    await rcedit(exe, {
        icon,
        'version-string': {
            CompanyName: pkg.author || 'RootSwitch',
            FileDescription: pkg.description,
            ProductName: 'RSMultiTerm',
            LegalCopyright: 'Public domain (Unlicense)',
            OriginalFilename: path.basename(exe),
        },
        'file-version': pkg.version,
        'product-version': pkg.version,
    });

    console.log(`  • stamped icon and version into ${path.basename(exe)}`);
};
