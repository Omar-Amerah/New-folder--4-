const assert = require('assert');
const { encode, decode } = require('@msgpack/msgpack');
const { validateClientMessage } = require('./src/server/clientSchemas');
(async () => {
  const merge = await import('./public/src/snapshotMerge.js');
  const resync = await import('./public/src/snapshotResync.js');
  const reasons = new Set(Object.values(merge.SNAPSHOT_REJECTION));
  const extras = [null, undefined, '', '   ', {}, [], 'surprise', 'epoch-mismatch', 'missing-epoch-baseline', 'reconnect-recovery', 'malformed-snapshot'];
  for (const local of [...reasons, ...extras]) {
    const reason = resync.mapSnapshotRejectionToResyncReason(local);
    assert.strictEqual(typeof reason, 'string');
    const decoded = decode(encode({ type: 'requestFullState', epoch: 1, sequence: 2, reason }));
    const valid = validateClientMessage(decoded);
    assert.strictEqual(valid.ok, true, `${String(local)} mapped to invalid ${reason}: ${valid.message}`);
  }
  console.log(`resync reason contract ok (${reasons.size} exported reasons plus fallbacks)`);
})();
