const assert = require('assert');
const { encodeMessage, decodeBinary } = require('./src/server/wsCodec');
const msg = { type:'join', protocolVersion:4, minProtocolVersion:4, maxProtocolVersion:4, capabilities:['messagepack'], unicode:'✓', n:1.5, a:[null,true] };
assert.deepStrictEqual(decodeBinary(encodeMessage(msg)), msg);
console.log('network protocol verification passed');
