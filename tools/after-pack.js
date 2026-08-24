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

// What Windows stamps into the exe. Exported so a test can assert on it
// without running a build.
//
// FileDescription is a NAME, not a description, whatever the field is
// called. Windows shows it as the app's label in the taskbar jump list,
// in Task Manager's process list, and in Explorer's Description column,
// so every shipped app puts its name there: Firefox ships "Firefox",
// Chrome ships "Google Chrome", explorer.exe ships "Windows Explorer".
// This once carried package.json's full description, and right-clicking
// the taskbar button showed a sentence where the app name belongs.
// The sentence goes in Comments, which is the field that is actually
// for one.
function versionStrings(pkg) {
    return {
        CompanyName: pkg.author || 'RootSwitch',
        FileDescription: 'RSMultiTerm',
        ProductName: 'RSMultiTerm',
        InternalName: 'RSMultiTerm',
        Comments: pkg.description,
        LegalCopyright: 'Public domain (Unlicense)',
    };
}

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
            ...versionStrings(pkg),
            OriginalFilename: path.basename(exe),
        },
        'file-version': pkg.version,
        'product-version': pkg.version,
    });

    console.log(`  • stamped icon and version into ${path.basename(exe)}`);
};

exports.versionStrings = versionStrings;
