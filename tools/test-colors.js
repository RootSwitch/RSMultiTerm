'use strict';
// Color maths behind the themeable terminal background. The property that
// matters: a rule color authored for a dark terminal must stay legible when
// the terminal follows a light theme, without the stored rule changing and
// without the color losing its identity (green must still read as green).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// public/colors.js is a browser IIFE that publishes on window; run it in a
// context with a window object and take what it exports.
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'colors.js'), 'utf8'), sandbox);
const C = sandbox.window.Colors;

// Backgrounds from the shipped themes: Classic dark, Parchment, Canvas.
const DARK = '#1b1e25';
const PARCHMENT = '#fffdf8';
const CANVAS = '#f8f4e9';

// Shipped rule colors, authored against DARK.
const RULES = {
    up: '#69f0ae', down: '#ff5252', warn: '#ffb74d', dim: '#9e9e9e',
    iface: '#64b5f6', fast: '#4dd0e1', sm: '#ffee58', mm: '#00e5ff', addr: '#ce93d8',
};

// 1. Light backgrounds are detected as light, dark ones as dark.
assert.strictEqual(C.isLight(PARCHMENT), true, 'parchment is light');
assert.strictEqual(C.isLight(CANVAS), true, 'canvas is light');
assert.strictEqual(C.isLight(DARK), false, 'classic is dark');

// 2. On a dark background the shipped colors already pass, so correction
// must leave them alone - the common case must not shift hues.
for (const [name, hex] of Object.entries(RULES)) {
    const out = C.readable(hex, DARK);
    assert.strictEqual(out, hex, `${name} must be untouched on a dark terminal`);
}

// 3. On light backgrounds every rule color becomes legible. Yellow on
// near-white is the brutal case: #ffee58 has a contrast ratio near 1.1.
for (const bg of [PARCHMENT, CANVAS]) {
    for (const [name, hex] of Object.entries(RULES)) {
        const before = C.contrast(C.hexToRgb(hex), C.hexToRgb(bg));
        const out = C.readable(hex, bg);
        const after = C.contrast(C.hexToRgb(out), C.hexToRgb(bg));
        assert.ok(after >= 4.0 - 0.01,
            `${name} on ${bg}: contrast only ${after.toFixed(2)} after correction`);
        assert.ok(after > before, `${name} on ${bg}: correction must improve contrast`);
    }
}

// 3b. The mirror case: a user picks a dark color for a rule and runs a dark
// terminal. Correction has to brighten, not darken - the direction depends on
// the background, not on a fixed assumption about which way is "safe".
for (const dark of ['#333333', '#1a3a1a', '#2b0000']) {
    const out = C.readable(dark, DARK);
    const after = C.contrast(C.hexToRgb(out), C.hexToRgb(DARK));
    assert.ok(after >= 4.0 - 0.01,
        `${dark} on a dark terminal: contrast only ${after.toFixed(2)} after correction`);
    assert.ok(C.luminance(C.hexToRgb(out)) > C.luminance(C.hexToRgb(dark)),
        `${dark} on a dark terminal must be brightened, not darkened`);
}

// 4. Identity is preserved: the corrected color keeps its dominant channel,
// so "green" stays green rather than collapsing to black.
const greenOnLight = C.hexToRgb(C.readable(RULES.up, PARCHMENT));
assert.ok(greenOnLight.g > greenOnLight.r && greenOnLight.g > greenOnLight.b,
    'corrected green is still green');
const redOnLight = C.hexToRgb(C.readable(RULES.down, PARCHMENT));
assert.ok(redOnLight.r > redOnLight.g && redOnLight.r > redOnLight.b,
    'corrected red is still red');
const blueOnLight = C.hexToRgb(C.readable(RULES.iface, PARCHMENT));
assert.ok(blueOnLight.b > blueOnLight.r, 'corrected blue is still blue');

// 5. Correction is stable and cached: same inputs, same output.
assert.strictEqual(C.readable(RULES.up, PARCHMENT), C.readable(RULES.up, PARCHMENT));
C.clearCache();
assert.strictEqual(C.readable(RULES.up, PARCHMENT), C.readable(RULES.up, PARCHMENT),
    'result survives a cache clear unchanged');

// 6. Malformed input degrades to the original color rather than throwing -
// rule colors are user-editable free text.
assert.strictEqual(C.readable('not-a-color', PARCHMENT), 'not-a-color');
assert.strictEqual(C.readable(null, PARCHMENT), null);
assert.strictEqual(C.readable(RULES.up, 'nonsense'), RULES.up);

// 7. Shorthand hex parses (themes.js palettes use both forms). Compared
// field-wise: objects built inside the vm context have a foreign prototype,
// so deepStrictEqual would fail on the realm rather than the values.
const white = C.hexToRgb('#fff');
assert.ok(white.r === 255 && white.g === 255 && white.b === 255, 'shorthand hex');
const black = C.hexToRgb('#000000');
assert.ok(black.r === 0 && black.g === 0 && black.b === 0, 'full hex');
assert.strictEqual(C.hexToRgb('#12345'), null, 'malformed hex rejected');

// 8. rgba() builds a usable selection color and falls back safely.
assert.strictEqual(C.rgba('#4c8bf5', 0.35), 'rgba(76, 139, 245, 0.35)');
assert.ok(C.rgba('bogus', 0.35).startsWith('rgba('), 'bad input still yields a color');

console.log('ok - color maths (light/dark detection, contrast correction, hue identity)');
