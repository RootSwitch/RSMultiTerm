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

// 9. A theme's night is a near-black tint of its accent - 14% of each
// channel - the same color the idle animations paint their sky with.
assert.strictEqual(C.night('#e58aab'), '#201318', 'Sakura at night is a dark plum');
assert.strictEqual(C.night('#2f6fd0'), '#07101d', 'Glacier at night is a dark navy');
assert.ok(!C.isLight(C.night('#ffffff')), 'even a white accent makes a dark night');
assert.strictEqual(C.night('bogus'), C.night('#3c5078'), 'a bad accent still yields a night');

// 10. "Follow the app theme, kept dark" must be dark and readable for EVERY
// built-in theme: a light theme goes to its night in its own light panel
// color, a dark theme keeps exactly what it had. The palettes come from
// themes.js itself (run with just enough of a document to load), on top of
// the :root defaults in style.css, which is what a theme does not override.
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
const defaults = {};
for (const m of rootBlock.matchAll(/(--se-[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)) defaults[m[1]] = m[2];
const themeBox = {
    window: {},
    document: { documentElement: { style: { setProperty() {}, removeProperty() {} } } },
    localStorage: { getItem: () => null, setItem() {} },
};
vm.createContext(themeBox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'themes.js'), 'utf8'), themeBox);
const THEMES = themeBox.window.Themes.THEMES;
let lightCount = 0;
for (const [key, theme] of Object.entries(THEMES)) {
    const v = { ...defaults, ...theme.vars };
    const out = C.keptDark({ input: v['--se-input'], panel: v['--se-panel'],
        txt: v['--se-txt'], accent: v['--se-accent'] });
    assert.ok(!C.isLight(out.background), `${key}: kept dark must be dark, got ${out.background}`);
    if (C.isLight(v['--se-input'])) {
        // The colors kept dark CHOOSES must be AAA-readable. A dark theme's
        // own pair is the theme's design (Solarized Dark sits at 6.3:1 on
        // purpose) and is only required to come through unchanged.
        const ratio = C.contrast(C.hexToRgb(out.foreground), C.hexToRgb(out.background));
        assert.ok(ratio >= 7, `${key}: kept dark text must be AAA-readable, got ${ratio.toFixed(1)}:1`);
        lightCount++;
        assert.strictEqual(out.background, C.night(v['--se-accent']), `${key}: a light theme goes to its night`);
        assert.strictEqual(out.foreground, v['--se-panel'], `${key}: written in its own panel color`);
    } else {
        assert.strictEqual(out.background, v['--se-input'], `${key}: a dark theme keeps its background`);
        assert.strictEqual(out.foreground, v['--se-txt'], `${key}: and its text`);
    }
}
assert.ok(lightCount >= 5 && Object.keys(THEMES).length >= 20,
    `expected the full theme set with its light themes, got ${Object.keys(THEMES).length} and ${lightCount}`);

console.log(`ok - color maths (light/dark detection, contrast correction, hue identity, ` +
    `kept dark across ${Object.keys(THEMES).length} themes, ${lightCount} of them light)`);
