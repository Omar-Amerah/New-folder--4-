const assert = require('assert');
const { WebSocketFrameParser } = require('./src/server/wsFrameParser');
const { encodeMessage } = require('./src/server/wsCodec');
function frame(payload, opcode, fin=true){const data=Buffer.from(payload);let h=Buffer.from([ (fin?0x80:0)|opcode, 0x80|data.length]);const m=Buffer.from([1,2,3,4]);const p=Buffer.alloc(data.length);for(let i=0;i<data.length;i++)p[i]=data[i]^m[i%4];return Buffer.concat([h,m,p]);}
const msg=encodeMessage({type:'ping',n:1});
let p=new WebSocketFrameParser();
let a=p.push(frame(msg.subarray(0,2),2,false)); assert.strictEqual(a[0].type,'fragment');
a=p.push(Buffer.concat([frame('x',9,true), frame(msg.subarray(2),0,true)])); assert.strictEqual(a[0].type,'ping'); assert.strictEqual(a[1].type,'message'); assert.deepStrictEqual(a[1].payload,msg);
p=new WebSocketFrameParser(); assert.strictEqual(p.push(frame('x',0,true))[0].code,1002);
p=new WebSocketFrameParser(); p.push(frame('a',2,false)); assert.strictEqual(p.push(frame('b',2,true))[0].code,1002);
p=new WebSocketFrameParser({maxMessageBytes:3}); p.push(frame('12',2,false)); assert.strictEqual(p.push(frame('34',0,true))[0].code,1009);
console.log('websocket fragmentation verification passed');
