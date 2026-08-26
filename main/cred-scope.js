'use strict';
// Which hosts a credential profile may be used with.
//
// The problem this closes: getAuth(name) took a profile name and nothing
// else, so main decrypted a stored AD password without ever knowing where
// it was about to be sent. A renderer that could name a host - which a
// compromised one can, via rs:tree.upsert - could have that password
// delivered to a machine of its choosing during SSH auth. The first-contact
// fingerprint dialog is no help: the renderer draws it AND answers its own
// rs:hostkey.answer, so under renderer compromise no in-app prompt can gate
// anything. The decision has to be one MAIN can make alone, from data the
// renderer cannot write.
//
// So: a profile carries a list of patterns, and main checks the target host
// against it before decrypting anything. No prompt to forge, no round trip.
//
// It earns its keep without an attacker, too. "This AD account is for
// 10.50.0.0/16" stops the ordinary mistake of picking the wrong profile for
// a customer's box - the failure mode where a real credential goes to a
// real machine that should never have seen it.
//
// Patterns, deliberately few and all of them things a network admin already
// writes down:
//   10.50.1.7          an exact address or hostname (case-insensitive)
//   10.50.0.0/16       a CIDR range (IPv4)
//   *.corp.local       a wildcard, matching one or more leading labels
//   10.50.1.*          a trailing wildcard, matching exactly ONE label -
//                      it does not admit 10.50.1.7.evil.com
//
// An EMPTY list means "no restriction" - every profile that exists today
// has one, and silently refusing them all on upgrade would be worse than
// the risk. Settings nudges once; the enforcement is real the moment a
// scope is set.

function ipToInt(ip) {
    const parts = String(ip).split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
        if (!/^\d{1,3}$/.test(p)) return null;
        const b = Number(p);
        if (b > 255) return null;
        n = (n * 256) + b;
    }
    return n;
}

// One pattern against one host. Returns true only on a definite match:
// anything unparseable is a non-match, never a pass.
function matches(pattern, host) {
    const pat = String(pattern || '').trim().toLowerCase();
    const h = String(host || '').trim().toLowerCase();
    if (!pat || !h) return false;

    // CIDR. Only meaningful when the target is a literal IPv4 address - a
    // hostname is NOT resolved here on purpose: resolution is attacker-
    // influenced (DNS), and a scope that can be widened by whoever answers
    // a lookup is not a scope.
    const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(pat);
    if (cidr) {
        const bits = Number(cidr[2]);
        if (bits > 32) return false;
        const net = ipToInt(cidr[1]);
        const addr = ipToInt(h);
        if (net === null || addr === null) return false;
        if (bits === 0) return true;
        const mask = bits === 32 ? 0xffffffff : ~((2 ** (32 - bits)) - 1) >>> 0;
        return ((net & mask) >>> 0) === ((addr & mask) >>> 0);
    }

    if (pat === h) return true;

    // Wildcards. '*' never stands for the empty string, so '*.corp.local'
    // does not match bare 'corp.local' - the parent domain is a different
    // thing from a host under it.
    //
    // Where the '*' SITS decides how far it may reach, and that distinction
    // is the fix for a real bypass:
    //
    //   *.corp.local   what follows the '*' is a DOT-anchored suffix, so
    //                  however many labels it eats, the host is still under
    //                  corp.local. Spanning is safe here, and useful:
    //                  'a.b.corp.local' is inside the estate.
    //   10.50.1.*      nothing follows. Letting this span labels admitted
    //                  '10.50.1.7.evil.com' - a name anyone who can
    //                  register a domain can create - into a scope written
    //                  to exclude exactly that.
    //   sw-*-01        what follows ('-01') is not dot-anchored, so
    //                  spanning would admit 'sw-core.evil-01' the same way.
    //
    // So: a '*' may cross dots only when the text right after it starts
    // with one. Otherwise it stands for a single label. Use CIDR for ranges
    // that need to cover several octets.
    if (pat.includes('*')) {
        const raw = pat.split('*');
        const esc = raw.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        let src = '';
        for (let i = 0; i < esc.length; i++) {
            src += esc[i];
            if (i === esc.length - 1) break;
            src += raw[i + 1].startsWith('.') ? '.+' : '[^.]+';
        }
        return new RegExp(`^${src}$`).test(h);
    }
    return false;
}

// The check itself. `scope` is the profile's list; absent or empty means
// unrestricted.
function allows(scope, host) {
    if (!Array.isArray(scope) || scope.length === 0) return true;
    return scope.some((p) => matches(p, host));
}

// Editor input to a stored list: trimmed, de-duplicated, order kept, and
// anything that is not a usable pattern rejected loudly rather than stored
// as a rule that silently matches nothing.
function parse(text) {
    const out = [];
    const seen = new Set();
    for (const raw of String(text || '').split(/[\s,;]+/)) {
        const p = raw.trim().toLowerCase();
        if (!p) continue;
        if (seen.has(p)) continue;
        // A pattern must be something matches() can act on. The cheap test
        // is that it matches ITSELF once the wildcards are filled in - a
        // CIDR is checked structurally instead.
        const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(p);
        if (cidr) {
            if (ipToInt(cidr[1]) === null || Number(cidr[2]) > 32) {
                throw new Error(`'${raw.trim()}' is not a valid CIDR range`);
            }
        } else if (!/^[a-z0-9*._-]+$/.test(p)) {
            throw new Error(`'${raw.trim()}' is not a valid host pattern`);
        }
        seen.add(p);
        out.push(p);
    }
    return out;
}

module.exports = { allows, matches, parse };
