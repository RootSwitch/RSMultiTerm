'use strict';
// Color maths shared by the terminal palette and the highlight engine.
//
// This exists because the terminal background became themeable: a rule
// color authored to sit on near-black (#69f0ae green) is close to invisible
// on Parchment, so display-time contrast correction is what makes light
// themes usable rather than merely available. Stored rule colors are never
// modified - only what gets painted.

(function () {
    function hexToRgb(hex) {
        if (!hex) return null;
        let h = String(hex).trim();
        if (h[0] === '#') h = h.slice(1);
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return null;
        return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16),
        };
    }

    function rgbToHex({ r, g, b }) {
        const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
        return `#${c(r)}${c(g)}${c(b)}`;
    }

    // WCAG relative luminance.
    function luminance(rgb) {
        const f = (v) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(rgb.r) + 0.7152 * f(rgb.g) + 0.0722 * f(rgb.b);
    }

    function contrast(a, b) {
        const la = luminance(a), lb = luminance(b);
        const hi = Math.max(la, lb), lo = Math.min(la, lb);
        return (hi + 0.05) / (lo + 0.05);
    }

    function isLight(hex) {
        const rgb = hexToRgb(hex);
        return rgb ? luminance(rgb) > 0.45 : false;
    }

    // Nudge `fg` toward black (on light backgrounds) or white (on dark) until
    // it clears the target ratio. Hue is preserved by scaling channels, so a
    // green rule stays recognisably green - just legible.
    const cache = new Map();
    function readable(fg, bg, target = 4.0) {
        if (!fg || !bg) return fg;
        const key = `${fg}|${bg}|${target}`;
        if (cache.has(key)) return cache.get(key);

        const bgRgb = hexToRgb(bg);
        let rgb = hexToRgb(fg);
        if (!rgb || !bgRgb) { cache.set(key, fg); return fg; }

        const towardBlack = luminance(bgRgb) > 0.45;
        for (let i = 0; i < 24 && contrast(rgb, bgRgb) < target; i++) {
            rgb = towardBlack
                ? { r: rgb.r * 0.86, g: rgb.g * 0.86, b: rgb.b * 0.86 }
                : { r: rgb.r + (255 - rgb.r) * 0.12, g: rgb.g + (255 - rgb.g) * 0.12, b: rgb.b + (255 - rgb.b) * 0.12 };
        }
        const out = rgbToHex(rgb);
        cache.set(key, out);
        return out;
    }

    function rgba(hex, alpha) {
        const rgb = hexToRgb(hex);
        if (!rgb) return `rgba(76, 139, 245, ${alpha})`;
        return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
    }

    function clearCache() { cache.clear(); }

    window.Colors = { hexToRgb, rgbToHex, luminance, contrast, isLight, readable, rgba, clearCache };
})();
