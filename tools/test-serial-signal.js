'use strict';
// Serial line controls: break, DTR/RTS, mid-session speed. No COM port
// exists on a build machine, so the port is a fake that records set()/
// update() calls - what is under test is the sequencing and the guards,
// not serialport's bindings.
//
// The property that matters most: a break ALWAYS deasserts. A break left
// high wedges the line until the port is closed - on a console cable into
// a switch mid-boot, that is a bricked recovery session.

const assert = require('assert');
const { SerialTransport } = require('../engine/transports/serial');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rig() {
    const t = new SerialTransport();
    const calls = [];
    t._port = {
        isOpen: true,
        path: 'COM7',
        set(opts, cb) { calls.push({ ...opts, at: Date.now() }); cb(); },
        update(opts, cb) { calls.push({ update: opts }); cb(); },
    };
    t._signals = { dtr: true, rts: true };
    t._baud = 9600;
    t._status = () => {};
    return { t, calls };
}

(async () => {
    // --- break asserts, waits, deasserts -----------------------------------
    {
        const { t, calls } = rig();
        const r = await t.signal({ op: 'break', ms: 200 });
        assert.strictEqual(r.ms, 200);
        assert.strictEqual(calls.length, 2, 'exactly assert + deassert');
        assert.strictEqual(calls[0].brk, true);
        assert.strictEqual(calls[1].brk, false, 'the break must END');
        const held = calls[1].at - calls[0].at;
        assert.ok(held >= 150, `break held ${held}ms, wanted ~200`);
    }

    // --- break duration is clamped, both directions ------------------------
    {
        const { t } = rig();
        assert.strictEqual((await t.signal({ op: 'break', ms: 5 })).ms, 100,
            'too-short breaks get stretched (USB adapters swallow them)');
        assert.strictEqual((await t.signal({ op: 'break', ms: 99999 })).ms, 3000,
            'a minute-long break is a wedged line, not a request');
    }

    // --- a failing wait still deasserts ------------------------------------
    // Simulated by making the FIRST set succeed and then poisoning the
    // timer path is not possible from here; what can be forced is set()
    // itself failing on assert - then nothing was held, so nothing leaks.
    {
        const { t } = rig();
        t._port.set = (opts, cb) => cb(new Error('device unplugged'));
        await assert.rejects(() => t.signal({ op: 'break' }), /unplugged/);
    }

    // --- DTR/RTS set only what was asked, and mirror it --------------------
    {
        const { t, calls } = rig();
        const r = await t.signal({ op: 'set', dtr: false });
        assert.deepStrictEqual(calls[0], { ...calls[0], dtr: false });
        assert.strictEqual('rts' in calls[0], false, 'RTS untouched by a DTR toggle');
        assert.deepStrictEqual(r.signals, { dtr: false, rts: true });
        const r2 = await t.signal({ op: 'set', rts: false });
        assert.deepStrictEqual(r2.signals, { dtr: false, rts: false });
        await assert.rejects(() => t.signal({ op: 'set' }), /nothing to set/);
    }

    // --- speed change validates before touching the port -------------------
    {
        const { t, calls } = rig();
        await assert.rejects(() => t.signal({ op: 'baud', baud: 'fast' }), /not a usable/);
        await assert.rejects(() => t.signal({ op: 'baud', baud: 0 }), /not a usable/);
        assert.strictEqual(calls.length, 0, 'a refused speed never reaches update()');
        const r = await t.signal({ op: 'baud', baud: 115200 });
        assert.strictEqual(r.baud, 115200);
        assert.deepStrictEqual(calls[0], { update: { baudRate: 115200 } });
        const st = await t.signal({ op: 'status' });
        assert.strictEqual(st.baud, 115200, 'status reports the NEW speed');
        assert.deepStrictEqual(st.signals, { dtr: true, rts: true });
    }

    // --- a closed port refuses everything ----------------------------------
    {
        const { t } = rig();
        t._port.isOpen = false;
        await assert.rejects(() => t.signal({ op: 'break' }), /not open/);
    }

    await sleep(0);
    console.log('ok - serial signals (break assert/deassert + clamps, dtr/rts mirror, baud validation, closed-port refusal)');
})().catch((err) => { console.error('FAIL -', err.stack || err.message); process.exit(1); });
