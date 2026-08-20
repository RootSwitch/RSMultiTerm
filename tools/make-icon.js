'use strict';
// Icon generator: public/brand/mark.svg + mark-small.svg -> build/icon.ico
// (and a PNG for docs). Run with `npm run icon`.
//
// The artwork lives under public/brand because the app itself renders the
// same files in its title bar. There used to be a separate hand-drawn mark
// inlined in index.html, which is how the header ended up showing a
// different logo from the taskbar: one source of truth avoids that.
//
// Rendering goes through Electron because it is already a dependency and
// Chromium is a better SVG renderer than anything we would add; packing goes
// through the code below because an .ico is a directory of images with a
// 16-byte header each, which is not worth a dependency.
//
// Sizes at or below 32px use the small variant: fine detail turns to mush
// there, and an .ico exists precisely so each size can be drawn properly
// rather than downscaled and hoped for.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, nativeImage } = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT_ICO = path.join(ROOT, 'build', 'icon.ico');
const OUT_PNG = path.join(ROOT, 'docs', 'icon.png');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SMALL_AT_OR_BELOW = 32;

// One window for the whole run, at the largest size we need. Each render
// draws the SVG at its target size in the top-left corner and captures just
// that rectangle, so nothing is ever downscaled and no window is created per
// size. (Creating and destroying a transparent offscreen window per size
// worked for the first one and then failed to load; a single long-lived
// window sidesteps that entirely. Page content comes from a temp file rather
// than a data: URL for the same reason - fewer moving parts.)
const MAX = Math.max(...SIZES);
let win = null;
let tmpDir = null;

function ensureWindow() {
    if (win) return win;
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rsmt-icon-'));
    win = new BrowserWindow({
        width: MAX, height: MAX, useContentSize: true,
        show: false, frame: false, transparent: true,
        webPreferences: { offscreen: true },
    });
    return win;
}

async function render(svgPath, px) {
    const w = ensureWindow();
    const svg = fs.readFileSync(svgPath, 'utf8');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;padding:0;background:transparent;overflow:hidden}
        svg{display:block;width:${px}px;height:${px}px}
        </style></head><body>${svg}</body></html>`;
    const file = path.join(tmpDir, `icon-${px}-${path.basename(svgPath)}.html`);
    fs.writeFileSync(file, html, 'utf8');

    await w.loadFile(file);
    // One beat to settle: capturePage on a just-loaded offscreen window can
    // land before the first paint and come back empty.
    await new Promise((r) => setTimeout(r, 150));

    let image = await w.webContents.capturePage({ x: 0, y: 0, width: px, height: px });
    // On a HiDPI display the capture comes back at the device scale, so
    // normalize to the size actually asked for.
    const size = image.getSize();
    if (size.width !== px || size.height !== px) {
        image = image.resize({ width: px, height: px, quality: 'best' });
    }
    return image;
}

// --- ICO packing ------------------------------------------------------------

// A 32-bit BGRA DIB, as ICO entries below 256px traditionally carry. The
// height field is doubled because the format expects an AND mask after the
// color data; with a real alpha channel the mask is all zeros, but it still
// has to be there and still has to be 4-byte aligned per row.
function dibEntry(image, px) {
    const bgraTopDown = image.toBitmap();   // BGRA, top row first
    const rowBytes = px * 4;
    const xor = Buffer.alloc(rowBytes * px);
    for (let y = 0; y < px; y++) {
        const src = (px - 1 - y) * rowBytes;   // DIBs are bottom-up
        bgraTopDown.copy(xor, y * rowBytes, src, src + rowBytes);
    }

    const maskRow = Math.ceil(px / 32) * 4;
    const andMask = Buffer.alloc(maskRow * px);   // zeros: fully opaque

    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);          // biSize
    header.writeInt32LE(px, 4);           // biWidth
    header.writeInt32LE(px * 2, 8);       // biHeight (color + mask)
    header.writeUInt16LE(1, 12);          // biPlanes
    header.writeUInt16LE(32, 14);         // biBitCount
    header.writeUInt32LE(0, 16);          // biCompression = BI_RGB
    header.writeUInt32LE(xor.length + andMask.length, 20);   // biSizeImage

    return Buffer.concat([header, xor, andMask]);
}

function packIco(entries) {
    const dir = Buffer.alloc(6 + entries.length * 16);
    dir.writeUInt16LE(0, 0);                 // reserved
    dir.writeUInt16LE(1, 2);                 // type: icon
    dir.writeUInt16LE(entries.length, 4);

    let offset = dir.length;
    const blobs = [];
    entries.forEach((e, i) => {
        const at = 6 + i * 16;
        dir.writeUInt8(e.px >= 256 ? 0 : e.px, at);       // 0 means 256
        dir.writeUInt8(e.px >= 256 ? 0 : e.px, at + 1);
        dir.writeUInt8(0, at + 2);                        // palette size
        dir.writeUInt8(0, at + 3);                        // reserved
        dir.writeUInt16LE(1, at + 4);                     // planes
        dir.writeUInt16LE(32, at + 6);                    // bit depth
        dir.writeUInt32LE(e.data.length, at + 8);
        dir.writeUInt32LE(offset, at + 12);
        offset += e.data.length;
        blobs.push(e.data);
    });
    return Buffer.concat([dir, ...blobs]);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    try {
        const detailed = path.join(ROOT, 'public', 'brand', 'mark.svg');
        const small = path.join(ROOT, 'public', 'brand', 'mark-small.svg');

        const entries = [];
        for (const px of SIZES) {
            const src = px <= SMALL_AT_OR_BELOW ? small : detailed;
            const image = await render(src, px);
            if (image.isEmpty()) throw new Error(`render produced nothing at ${px}px`);
            // Every size ships as an uncompressed DIB. PNG-compressed
            // entries are legal and smaller, but GDI+ - which is what
            // System.Drawing and a good deal of older Windows tooling use to
            // read icons - cannot decode them, so the large sizes silently
            // failed to load anywhere outside the shell. A few hundred KB is
            // not worth that.
            const data = dibEntry(image, px);
            entries.push({ px, data });
            console.log(`  ${String(px).padStart(3)}px  ${px <= SMALL_AT_OR_BELOW ? 'small ' : 'detail'}  ` +
                `dib  ${data.length} bytes`);
        }

        fs.mkdirSync(path.dirname(OUT_ICO), { recursive: true });
        fs.writeFileSync(OUT_ICO, packIco(entries));
        console.log(`wrote ${path.relative(ROOT, OUT_ICO)} (${fs.statSync(OUT_ICO).size} bytes, ${entries.length} sizes)`);

        // A plain PNG for the README and anywhere that cannot read an .ico.
        fs.mkdirSync(path.dirname(OUT_PNG), { recursive: true });
        fs.writeFileSync(OUT_PNG, (await render(detailed, 256)).toPNG());
        console.log(`wrote ${path.relative(ROOT, OUT_PNG)}`);

        app.exit(0);
    } catch (err) {
        console.error('icon generation failed:', err.message);
        app.exit(1);
    }
});
