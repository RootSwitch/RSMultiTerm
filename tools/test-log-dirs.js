'use strict';
// Where session logs are allowed to go. The scenario that created this
// file: a portable exe on the Desktop. The desktop guard correctly skipped
// "beside the app", then fell through to "beside the exe" - which for a
// portable build is the EXTRACTION COPY under %TEMP%, a directory that
// changes between logon sessions. Logs looked like they vanished between
// runs; they were stranded across old temp folders. Found by the owner on
// a real machine, one day after release.

const assert = require('assert');
const path = require('path');
const { logDirCandidates } = require('../main/log-dirs');

const W = (...p) => path.join('C:\\', ...p);
const BASE = {
    envOverride: null,
    isPackaged: true,
    portableDir: null,
    exeDir: W('Users', 'someone', 'AppData', 'Local', 'Temp', '9', '3ICVKPw6', 'app'),
    devDir: W('repo'),
    desktop: W('Users', 'someone', 'Desktop'),
    tmpdir: W('Users', 'someone', 'AppData', 'Local', 'Temp'),
    documents: W('Users', 'someone', 'Documents'),
};
const DOCS = W('Users', 'someone', 'Documents', 'RSMultiTerm', 'logs');

const never = (list, env, label) => {
    const tmp = env.tmpdir.toLowerCase();
    for (const d of list) {
        assert.ok(!d.toLowerCase().startsWith(tmp),
            `${label}: candidate under the temp dir: ${d}`);
        assert.notStrictEqual(path.dirname(d).toLowerCase(), env.desktop.toLowerCase(),
            `${label}: candidate on the Desktop: ${d}`);
    }
};

// 1. THE bug: portable exe on the Desktop. Desktop skipped, and the
// extraction dir must not be the consolation prize - Documents is.
{
    const env = { ...BASE, portableDir: W('Users', 'someone', 'Desktop') };
    const got = logDirCandidates(env);
    assert.deepStrictEqual(got, [DOCS],
        'portable-on-desktop must go straight to Documents');
    never(got, env, 'portable on desktop');
}

// 2. Portable anywhere else: beside the exe the user placed, then Documents.
{
    const env = { ...BASE, portableDir: W('Apps', 'RSMultiTerm') };
    const got = logDirCandidates(env);
    assert.deepStrictEqual(got, [W('Apps', 'RSMultiTerm', 'logs'), DOCS]);
    never(got, env, 'portable elsewhere');
}

// 3. Portable run FROM a temp folder (downloaded and double-clicked in
// place): even the "user's" location is ephemeral - Documents only.
{
    const env = { ...BASE, portableDir: path.join(BASE.tmpdir, 'Downloads-cache') };
    assert.deepStrictEqual(logDirCandidates(env), [DOCS]);
}

// 4. Installed build (no portableDir): beside the exe is legitimate - the
// install dir is a real place - with Documents as the fallback the
// writability probe reaches when Program Files is read-only.
{
    const env = { ...BASE, exeDir: W('Program Files', 'RSMultiTerm') };
    assert.deepStrictEqual(logDirCandidates(env),
        [W('Program Files', 'RSMultiTerm', 'logs'), DOCS]);
}

// 5. An installed exe somehow ON the desktop still refuses the desktop.
{
    const env = { ...BASE, exeDir: BASE.desktop };
    assert.deepStrictEqual(logDirCandidates(env), [DOCS]);
}

// 6. Dev run: the repo's logs/, then Documents.
{
    const env = { ...BASE, isPackaged: false };
    assert.deepStrictEqual(logDirCandidates(env), [W('repo', 'logs'), DOCS]);
}

// 7. RSMT_LOGDIR is an explicit choice and wins verbatim - even pointed at
// the desktop or temp, because the user typed it on purpose.
{
    const env = { ...BASE, envOverride: path.join(BASE.tmpdir, 'trace-here') };
    const got = logDirCandidates(env);
    assert.strictEqual(got[0], path.join(BASE.tmpdir, 'trace-here'));
}

// 8. Missing path answers (a locked-down profile) degrade, never throw.
{
    const env = { ...BASE, desktop: null, documents: null, portableDir: W('Apps') };
    const got = logDirCandidates(env);
    assert.deepStrictEqual(got, [W('Apps', 'logs')]);
}

console.log('ok - log dir candidates (8 scenarios: the portable-on-desktop bug, ' +
    'temp never, desktop never, override wins)');
