'use strict';
// What should happen when the window is asked to close.
//
// This is a pure function because the close handler is re-entrant and that
// is exactly where it went wrong once: taking the final workspace snapshot
// means cancelling the close, saving, and calling close() again - which runs
// the handler a second time and, before this, asked "N sessions still
// connected" a second time too. One question per close, one snapshot per
// close, and the caller only has to keep two booleans.
//
// Steps:
//   'allow'    let the window close
//   'confirm'  ask about live sessions first (set confirmed and re-ask)
//   'snapshot' cancel the close, take the final snapshot, close again

function nextStep(state) {
    const { quitting, smoke, liveCount, confirmed, snapshotTaken } = state;
    // A quit already in progress, or a smoke run, closes without ceremony.
    if (quitting || smoke) return 'allow';
    if (liveCount > 0 && !confirmed) return 'confirm';
    if (!snapshotTaken) return 'snapshot';
    return 'allow';
}

module.exports = { nextStep };
