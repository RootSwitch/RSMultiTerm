'use strict';
// SHA-256 for the built artifacts, written beside them as SHA256SUMS.txt.
//
// There is no code signing certificate for this app, so Windows will call
// both downloads unknown-publisher no matter what. A hash does not fix
// that - only a cert does - but it does answer the OTHER question, the one
// a hash can actually answer: "is the file I downloaded the file that was
// built?" Publish these next to the download and a careful person can tell
// a corrupted or swapped file from a good one.
//
// Format is sha256sum's, two spaces between hash and name, so `sha256sum -c
// SHA256SUMS.txt` verifies the set on Linux or Git Bash. The printed
// PowerShell line covers Windows, where most of these downloads land.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');

function sha256(file) {
    // Streamed: these are ~76 MB each and there is no reason to hold one
    // in memory to hash it.
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(file);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function main() {
    let names;
    try {
        names = fs.readdirSync(DIST).filter((f) => f.endsWith('.exe')).sort();
    } catch (err) {
        console.error('hashes: no dist directory - run the build first');
        process.exit(1);
    }
    if (!names.length) {
        console.error('hashes: dist has no .exe artifacts to hash');
        process.exit(1);
    }

    const lines = [];
    for (const name of names) {
        const digest = await sha256(path.join(DIST, name));
        lines.push(digest + '  ' + name);
    }
    const body = lines.join('\n') + '\n';
    fs.writeFileSync(path.join(DIST, 'SHA256SUMS.txt'), body, 'utf8');

    process.stdout.write('\nSHA-256 (dist/SHA256SUMS.txt):\n\n' + body + '\n');
    process.stdout.write('Verify on Windows:\n');
    process.stdout.write('  Get-FileHash .\\' + names[0] + ' -Algorithm SHA256\n\n');
}

main().catch((err) => {
    console.error('hashes:', err.message);
    process.exit(1);
});
