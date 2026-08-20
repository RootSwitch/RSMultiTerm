'use strict';
// Line diff. Hand-rolled because the job is small and the dependency would
// not be: an LCS over lines, walked back into a list of ops.
//
// Network output is columnar (show int status, route tables), so the diff is
// line-level and column-preserving rather than word-level - a word diff on
// aligned columns produces confetti.

(function () {
    // Normalisation is a display-time choice, not a data change: trailing
    // whitespace differences and volatile fields (uptime counters,
    // timestamps) otherwise swamp the real differences.
    function normalize(line, opts) {
        let s = line;
        if (opts.ignoreTrailingWhitespace !== false) s = s.replace(/\s+$/, '');
        if (opts.ignoreAllWhitespace) s = s.replace(/\s+/g, ' ').trim();
        if (opts.ignoreCase) s = s.toLowerCase();
        for (const re of opts.stripPatterns || []) {
            try { s = s.replace(new RegExp(re, 'g'), ''); } catch (_) { /* user regex */ }
        }
        return s;
    }

    // Classic LCS table. Bounded deliberately: two 5000-line configs is 25M
    // cells, which is where a naive table stops being free. Above the cap we
    // fall back to a line-anchored chunk diff.
    const CELL_CAP = 4_000_000;

    function lcsOps(a, b) {
        const n = a.length, m = b.length;
        const dp = [];
        for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                dp[i][j] = a[i] === b[j]
                    ? dp[i + 1][j + 1] + 1
                    : Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
        const ops = [];
        let i = 0, j = 0;
        while (i < n && j < m) {
            if (a[i] === b[j]) { ops.push({ op: 'same', ai: i, bi: j }); i++; j++; }
            else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: 'del', ai: i }); i++; }
            else { ops.push({ op: 'add', bi: j }); j++; }
        }
        while (i < n) { ops.push({ op: 'del', ai: i }); i++; }
        while (j < m) { ops.push({ op: 'add', bi: j }); j++; }
        return ops;
    }

    // Cheap fallback for very large inputs: anchor on lines that appear
    // exactly once on both sides, diff the gaps between anchors.
    function anchoredOps(a, b) {
        const countIn = (arr) => {
            const m = new Map();
            arr.forEach((l, i) => {
                const e = m.get(l);
                if (e) e.count++; else m.set(l, { count: 1, index: i });
            });
            return m;
        };
        const ca = countIn(a), cb = countIn(b);
        const anchors = [];
        for (const [line, ea] of ca) {
            if (ea.count !== 1) continue;
            const eb = cb.get(line);
            if (eb && eb.count === 1) anchors.push([ea.index, eb.index]);
        }
        anchors.sort((x, y) => x[0] - y[0]);
        // Keep only anchors that are increasing on both sides.
        const kept = [];
        let lastB = -1;
        for (const [ai, bi] of anchors) {
            if (bi > lastB) { kept.push([ai, bi]); lastB = bi; }
        }
        const ops = [];
        let i = 0, j = 0;
        const flushGap = (ai, bi) => {
            while (i < ai && j < bi) {
                if (a[i] === b[j]) ops.push({ op: 'same', ai: i, bi: j });
                else { ops.push({ op: 'del', ai: i }); ops.push({ op: 'add', bi: j }); }
                i++; j++;
            }
            while (i < ai) { ops.push({ op: 'del', ai: i }); i++; }
            while (j < bi) { ops.push({ op: 'add', bi: j }); j++; }
        };
        for (const [ai, bi] of kept) {
            flushGap(ai, bi);
            ops.push({ op: 'same', ai, bi });
            i = ai + 1; j = bi + 1;
        }
        flushGap(a.length, b.length);
        return ops;
    }

    // Returns {rows:[{type:'same'|'add'|'del'|'change', left, right}], stats}
    function diff(leftText, rightText, opts = {}) {
        const rawA = String(leftText).split(/\r\n|\r|\n/);
        const rawB = String(rightText).split(/\r\n|\r|\n/);
        // A trailing newline yields an empty last element that is noise.
        if (rawA.length && rawA[rawA.length - 1] === '') rawA.pop();
        if (rawB.length && rawB[rawB.length - 1] === '') rawB.pop();

        const a = rawA.map((l) => normalize(l, opts));
        const b = rawB.map((l) => normalize(l, opts));

        const ops = (a.length + 1) * (b.length + 1) > CELL_CAP
            ? anchoredOps(a, b)
            : lcsOps(a, b);

        // Pair adjacent del/add runs into change rows so the side-by-side
        // view lines up rather than stair-stepping.
        const rows = [];
        let k = 0;
        while (k < ops.length) {
            const o = ops[k];
            if (o.op === 'same') {
                rows.push({ type: 'same', left: rawA[o.ai], right: rawB[o.bi] });
                k++;
                continue;
            }
            const dels = [];
            const adds = [];
            while (k < ops.length && ops[k].op === 'del') { dels.push(rawA[ops[k].ai]); k++; }
            while (k < ops.length && ops[k].op === 'add') { adds.push(rawB[ops[k].bi]); k++; }
            const n = Math.max(dels.length, adds.length);
            for (let x = 0; x < n; x++) {
                const left = x < dels.length ? dels[x] : null;
                const right = x < adds.length ? adds[x] : null;
                rows.push({
                    type: left !== null && right !== null ? 'change' : (left !== null ? 'del' : 'add'),
                    left, right,
                });
            }
        }

        const stats = rows.reduce((acc, r) => {
            acc[r.type] = (acc[r.type] || 0) + 1;
            return acc;
        }, { same: 0, add: 0, del: 0, change: 0 });
        return { rows, stats };
    }

    // Pull the output of the last command out of terminal scrollback.
    //
    // Heuristic: a line STARTS with a prompt when it opens with a short
    // token containing none of #>$% followed by one of them - "core-sw-01#",
    // "user@router>", "alice@host:~$". The command usually follows with no
    // space ("core-sw-01#show int status"), so anchoring on the terminator
    // rather than on end-of-line is what makes this work on real scrollback.
    // Excluding the terminators from the token is what keeps "% Invalid
    // input" and ordinary output from reading as prompts.
    //
    // The text between the last two prompts is the last command and its
    // output. It will sometimes be wrong (paged output, config mode, a
    // banner containing a #), which is why the diff view puts the result in
    // an editable pane instead of treating it as ground truth.
    const PROMPT = /^[^\s#>$%]{1,64}[#>$%]/;

    function lastCommandOutput(lines) {
        const promptRows = [];
        for (let i = lines.length - 1; i >= 0 && promptRows.length < 2; i--) {
            const l = lines[i].replace(/\s+$/, '');
            if (!l) continue;
            if (PROMPT.test(l)) promptRows.push(i);
        }
        if (promptRows.length < 2) {
            // No two prompts: hand back everything and let the human trim.
            return { text: lines.join('\n'), confident: false };
        }
        const [end, start] = promptRows;   // collected newest-first
        return { text: lines.slice(start, end).join('\n'), confident: true };
    }

    window.DiffEngine = { diff, lastCommandOutput, normalize, PROMPT };
})();
