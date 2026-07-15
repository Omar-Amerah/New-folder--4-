const assert = require('assert');
const { readFrame } = require('./src/server/websocketServer');
const { MAX_MESSAGE_BYTES } = require('./src/server/config');
function masked(payload, opcode=2, extra={}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  let len = data.length, head;
  if (len < 126) head = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len <= 65535) { head = Buffer.alloc(4); head[0]=0x80|opcode; head[1]=0x80|126; head.writeUInt16BE(len,2); }
  else { head = Buffer.alloc(10); head[0]=0x80|opcode; head[1]=0x80|127; head.writeUInt32BE(0,2); head.writeUInt32BE(len,6); }
  if (extra.first !== undefined) head[0] = extra.first;
  if (extra.second !== undefined) head[1] = extra.second;
  const mask=Buffer.from([1,2,3,4]); const out=Buffer.alloc(data.length); for(let i=0;i<data.length;i++) out[i]=data[i]^mask[i%4];
  return Buffer.concat([head, mask, out]);
}
for (const n of [0,1,2,125,126,65535]) assert.strictEqual(readFrame(masked(Buffer.alloc(n))).payload.length, n);
const combo=Buffer.concat([masked('a'), masked('b')]); const a=readFrame(combo); assert.strictEqual(a.payload.toString(),'a'); assert.strictEqual(readFrame(combo.subarray(a.bytesRead)).payload.toString(),'b');
const split=masked('payload'); for(let i=0;i<split.length;i++) assert.strictEqual(readFrame(split.subarray(0,i)), null);
assert.strictEqual(readFrame(Buffer.from([0x82,0]))?.error, true, 'unmasked rejected');
assert.strictEqual(readFrame(masked('x',2,{first:0xC2}))?.error, true, 'RSV rejected');
assert.strictEqual(readFrame(masked('x',3))?.error, true, 'opcode rejected');
assert.strictEqual(readFrame(masked('x',2,{first:0x02}))?.error, true, 'fragment rejected');
assert.strictEqual(readFrame(masked(Buffer.alloc(126),9))?.error, true, 'large control rejected');
assert.ok(readFrame(masked(Buffer.alloc(MAX_MESSAGE_BYTES))));
assert.strictEqual(readFrame(masked(Buffer.alloc(MAX_MESSAGE_BYTES+1)))?.closeCode, 1009);
assert.strictEqual(readFrame(Buffer.from([0x82,0xfe,0,1,1,2,3,4,0]))?.error, true, 'non-minimal length rejected');
console.log('websocket frame verification passed');
