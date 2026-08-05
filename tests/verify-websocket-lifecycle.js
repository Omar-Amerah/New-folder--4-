const assert=require('assert'); const {WebSocketFrameParser}=require('./src/server/wsFrameParser');
function frame(payload, opcode=9){const d=Buffer.from(payload);const h=Buffer.from([0x80|opcode,0x80|d.length]);const m=Buffer.from([1,1,1,1]);const p=Buffer.alloc(d.length);for(let i=0;i<d.length;i++)p[i]=d[i]^1;return Buffer.concat([h,m,p]);}
let p=new WebSocketFrameParser(); assert.strictEqual(p.push(frame('abc',9))[0].type,'ping'); assert.strictEqual(p.push(frame('abc',10))[0].type,'pong');
function closePayload(code, reason=''){const r=Buffer.from(reason);const b=Buffer.alloc(2+r.length);b.writeUInt16BE(code);r.copy(b,2);return b}
p=new WebSocketFrameParser(); let e=p.push(frame(closePayload(1000,'ok'),8))[0]; assert.strictEqual(e.type,'close'); assert.strictEqual(e.code,1000);
p=new WebSocketFrameParser(); assert.strictEqual(p.push(frame(Buffer.from([1]),8))[0].code,1002);
p=new WebSocketFrameParser(); assert.strictEqual(p.push(frame(closePayload(1006),8))[0].code,1002);
p=new WebSocketFrameParser(); assert.strictEqual(p.push(frame(Buffer.from([3,232,0xff]),8))[0].code,1007);
console.log('websocket lifecycle verification passed');
