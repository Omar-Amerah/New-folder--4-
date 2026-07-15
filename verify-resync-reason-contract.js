import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { encode, decode } from '@msgpack/msgpack';
import { SNAPSHOT_REJECTION } from './public/src/snapshotMerge.js';
import { CANONICAL_RESYNC_REASONS, buildRequestFullStateMessage, mapSnapshotResyncReason } from './public/src/snapshotResync.js';
const require = createRequire(import.meta.url);
const { validateClientMessage } = require('./src/server/clientSchemas.js');
const cases = [...Object.values(SNAPSHOT_REJECTION), null, undefined, '', {}, 'surprise', ' sequence-gap ', ' malformed-delta '];
for (const local of cases) {
  const wire = mapSnapshotResyncReason(local);
  assert.equal(typeof wire, 'string');
  assert.ok(CANONICAL_RESYNC_REASONS.includes(wire), `canonical ${String(local)} -> ${wire}`);
  const built = buildRequestFullStateMessage({ stateEpoch: 3, snapshotSeq: 7 }, local, { requestId: 'req_1' });
  assert.equal(built.localReason, local);
  assert.equal(built.wireReason, wire);
  const decoded = decode(encode(built.message));
  const validation = validateClientMessage(decoded);
  assert.equal(validation.ok, true, `${String(local)} produced ${JSON.stringify(validation)}`);
  assert.notEqual(validation.code, 'invalid-resync-request');
}
for (const reason of CANONICAL_RESYNC_REASONS) {
  assert.equal(validateClientMessage({ type: 'requestFullState', epoch: 1, sequence: 1, reason }).ok, true);
}
console.log(`resync reason contract passed for ${cases.length} local reasons and ${CANONICAL_RESYNC_REASONS.length} wire reasons`);
