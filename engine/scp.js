'use strict';
// SCP over an exec channel, for gear that offers SCP but no SFTP subsystem -
// which is most IOS/IOS-XE with `ip scp server enable`, exactly the devices
// this app exists for.
//
// The protocol is the old rcp one and is barely documented, so, briefly:
//   download: run `scp -f <path>`. We drive it, sending a zero byte to ask
//     for the next thing. The device replies with a control line
//     "C<mode> <size> <name>\n", then <size> bytes, then a zero byte. We ack
//     each step with a zero byte.
//   upload: run `scp -t <path>`. The device acks with a zero byte, we send
//     "C0644 <size> <name>\n", wait for an ack, send the bytes, send a zero
//     byte, wait for a final ack.
// An ack is 0x00. 0x01 is a recoverable error and 0x02 fatal, both followed
// by a message line - surfacing that message is the difference between "SCP
// failed" and "flash: is full".
//
// No directory recursion: one file each way is what the file panel needs,
// and -r against a switch is a good way to fill a flash volume.

const fs = require('fs');
const path = require('path');

const OK = 0x00, WARN = 0x01, FATAL = 0x02;

// Quote a remote path for the device's shell. Devices vary wildly here, so
// keep it conservative: single quotes, with any embedded single quote
// escaped the POSIX way.
function quote(p) {
    return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

function download(client, remotePath, localPath, onProgress) {
    return new Promise((resolve, reject) => {
        client.exec(`scp -f ${quote(remotePath)}`, (err, stream) => {
            if (err) return reject(err);

            let stage = 'header';       // header -> data -> trailer
            let header = '';
            let remaining = 0;
            let total = 0;
            let written = 0;
            let out = null;
            let settled = false;
            let errText = '';
            let lastProgress = 0;

            // All writes land on a temp name; localPath is only ever
            // touched by the final rename. A refused transfer (wrong path,
            // permissions) must not delete a pre-existing local file it
            // never wrote.
            const tmpPath = `${localPath}.part`;
            const fail = (message) => {
                if (settled) return;
                settled = true;
                if (out) { out.destroy(); try { fs.unlinkSync(tmpPath); } catch (_) { /* nothing written */ } }
                stream.close();
                reject(new Error(message));
            };
            const ack = () => stream.write(Buffer.from([OK]));

            stream.on('data', (chunk) => {
                let i = 0;
                while (i < chunk.length && !settled) {
                    if (stage === 'header') {
                        const b = chunk[i];
                        if (header === '' && (b === WARN || b === FATAL)) {
                            // Error response: the rest of the line is why.
                            errText = '';
                            i++;
                            while (i < chunk.length && chunk[i] !== 0x0a) errText += String.fromCharCode(chunk[i++]);
                            if (i < chunk.length) return fail(errText.trim() || 'remote refused the transfer');
                            stage = 'errline';
                            continue;
                        }
                        i++;
                        if (b === 0x0a) {
                            const m = /^C(\d{4})\s+(\d+)\s+(.*)$/.exec(header);
                            if (!m) return fail(`unexpected SCP response: ${header.slice(0, 60)}`);
                            total = Number(m[2]);
                            remaining = total;
                            out = fs.createWriteStream(tmpPath);
                            out.on('error', (e) => fail(e.message));
                            stage = remaining === 0 ? 'trailer' : 'data';
                            header = '';
                            ack();
                        } else {
                            header += String.fromCharCode(b);
                        }
                        continue;
                    }
                    if (stage === 'errline') {
                        while (i < chunk.length && chunk[i] !== 0x0a) errText += String.fromCharCode(chunk[i++]);
                        if (i < chunk.length) return fail(errText.trim() || 'remote refused the transfer');
                        return;
                    }
                    if (stage === 'data') {
                        const take = Math.min(remaining, chunk.length - i);
                        // Honor the write verdict: a big image landing on a
                        // slow disk otherwise buffers without bound in this
                        // process - and an IOS image onto an SCP-only device
                        // is exactly this path's use case. The upload side
                        // has done this from the start.
                        if (!out.write(chunk.subarray(i, i + take))) {
                            stream.pause();
                            out.once('drain', () => stream.resume());
                        }
                        i += take;
                        remaining -= take;
                        written += take;
                        // At most 4/s, same as SFTP: every event is an
                        // engine-to-main-to-renderer IPC message.
                        if (onProgress && Date.now() - lastProgress >= 250) {
                            lastProgress = Date.now();
                            onProgress({ bytes: written, total });
                        }
                        if (remaining === 0) stage = 'trailer';
                        continue;
                    }
                    // trailer: the byte closing the file - 0x00 on success,
                    // WARN/FATAL followed by a message if the device hit
                    // trouble after the data (yes, that happens).
                    {
                        const code = chunk[i++];
                        if (code !== OK) {
                            stage = 'errline';
                            errText = '';
                            continue;   // collect the message, fail there or on close
                        }
                    }
                    stage = 'done';
                    // settled goes up HERE, before the file stream is
                    // flushed: the channel's close event beats the fs
                    // callback, and a late close on a finished transfer must
                    // not be reported as the device hanging up early.
                    settled = true;
                    ack();
                    if (out) {
                        // end() reports the final flush's verdict; a full
                        // disk fails HERE, and "ok" on a short write is how
                        // a half-saved config masquerades as a backup.
                        out.end((endErr) => {
                            stream.close();
                            if (endErr) {
                                try { fs.unlinkSync(tmpPath); } catch (_) { /* best effort */ }
                                return reject(new Error(`local write failed: ${endErr.message}`));
                            }
                            try {
                                fs.renameSync(tmpPath, localPath);
                            } catch (e) {
                                try { fs.unlinkSync(tmpPath); } catch (_) { /* best effort */ }
                                return reject(new Error(`downloaded, but could not replace ${localPath}: ${e.message}`));
                            }
                            resolve({ ok: true, bytes: written });
                        });
                    } else {
                        stream.close();
                        resolve({ ok: true, bytes: written });
                    }
                    return;
                }
            });

            stream.on('close', () => {
                if (!settled) fail(errText.trim() || 'the device closed the SCP channel early');
            });
            stream.stderr.on('data', (d) => { errText += d.toString(); });

            // Kick the device off: it waits for our first ack.
            ack();
        });
    });
}

function upload(client, localPath, remotePath, onProgress) {
    return new Promise((resolve, reject) => {
        let stat;
        try { stat = fs.statSync(localPath); } catch (e) { return reject(e); }
        const name = path.basename(remotePath) || path.basename(localPath);
        const dir = path.posix.dirname(remotePath.replace(/\\/g, '/'));

        client.exec(`scp -t ${quote(dir === '.' ? remotePath : dir)}`, (err, stream) => {
            if (err) return reject(err);

            let phase = 'await-ready';
            let settled = false;
            let errText = '';
            let sent = 0;
            let lastUp = 0;

            const fail = (message) => {
                if (settled) return;
                settled = true;
                stream.close();
                reject(new Error(message));
            };

            const readAck = (chunk) => {
                const code = chunk[0];
                if (code === OK) return true;
                let msg = '';
                for (let i = 1; i < chunk.length && chunk[i] !== 0x0a; i++) msg += String.fromCharCode(chunk[i]);
                fail(msg.trim() || `remote rejected the transfer (code ${code})`);
                return false;
            };

            const sendBody = () => {
                const rs = fs.createReadStream(localPath);
                rs.on('data', (d) => {
                    sent += d.length;
                    if (onProgress && Date.now() - lastUp >= 250) {
                        lastUp = Date.now();
                        onProgress({ bytes: sent, total: stat.size });
                    }
                    if (!stream.write(d)) { rs.pause(); stream.once('drain', () => rs.resume()); }
                });
                rs.on('error', (e) => fail(e.message));
                rs.on('end', () => {
                    stream.write(Buffer.from([OK]));   // end-of-file marker
                    phase = 'await-final';
                });
            };

            stream.on('data', (chunk) => {
                if (settled || !chunk.length) return;
                if (phase === 'await-ready') {
                    if (!readAck(chunk)) return;
                    phase = 'await-header-ack';
                    stream.write(`C0644 ${stat.size} ${name}\n`);
                    return;
                }
                if (phase === 'await-header-ack') {
                    if (!readAck(chunk)) return;
                    phase = 'sending';
                    sendBody();
                    return;
                }
                if (phase === 'await-final') {
                    if (!readAck(chunk)) return;
                    settled = true;
                    stream.close();
                    resolve({ ok: true, bytes: sent });
                }
            });

            stream.stderr.on('data', (d) => { errText += d.toString(); });
            stream.on('close', () => {
                if (!settled) fail(errText.trim() || 'the device closed the SCP channel early');
            });
        });
    });
}

// Probe: can this device do SCP at all? Cheap and read-only - ask for a path
// that will not exist and see whether we get SCP protocol back (an error
// response) or a shell complaining that scp is not a command.
function probe(client) {
    return new Promise((resolve) => {
        client.exec('scp -f /nonexistent-rsmultiterm-probe', (err, stream) => {
            if (err) return resolve(false);
            let sawProtocol = false;
            const done = (v) => { try { stream.close(); } catch (_) { /* closing */ } resolve(v); };
            const timer = setTimeout(() => done(sawProtocol), 4000);
            if (timer.unref) timer.unref();
            stream.on('data', (d) => {
                if (d.length && (d[0] === WARN || d[0] === FATAL || d[0] === OK)) sawProtocol = true;
                clearTimeout(timer);
                done(sawProtocol);
            });
            stream.on('close', () => { clearTimeout(timer); done(sawProtocol); });
            stream.write(Buffer.from([OK]));
        });
    });
}

module.exports = { download, upload, probe };
