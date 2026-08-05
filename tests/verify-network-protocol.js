const assert = require('assert');
const { encodeMessage, decodeBinary } = require('./src/server/wsCodec');
const msg = { type:'join', protocolVersion:6, minProtocolVersion:6, maxProtocolVersion:6, capabilities:['messagepack','entityDeltaSnapshotsV1'], unicode:'✓', n:1.5, a:[null,true] };
assert.deepStrictEqual(decodeBinary(encodeMessage(msg)), msg);
console.log('network protocol verification passed');
