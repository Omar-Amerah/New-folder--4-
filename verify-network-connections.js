const assert = require('assert');
const { negotiate } = require('./src/server/protocol');
assert.strictEqual(negotiate({protocolVersion:4,minProtocolVersion:4,maxProtocolVersion:4,capabilities:['messagepack']}).ok, true);
assert.strictEqual(negotiate({protocolVersion:3,minProtocolVersion:3,maxProtocolVersion:3,capabilities:['messagepack']}).code, 'incompatible-protocol');
assert.strictEqual(negotiate({protocolVersion:5,minProtocolVersion:5,maxProtocolVersion:5,capabilities:['messagepack']}).code, 'incompatible-protocol');
assert.strictEqual(negotiate({protocolVersion:4,minProtocolVersion:4,maxProtocolVersion:4,capabilities:[]}).code, 'missing-capability');
console.log('network connection verification passed');
