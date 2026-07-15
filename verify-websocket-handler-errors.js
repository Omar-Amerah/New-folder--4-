const assert = require('assert');
const { encodeMessage } = require('./src/server/wsCodec');
const transport = require('./src/server/websocketServer');
function masked(payload) { const data=Buffer.isBuffer(payload)?payload:Buffer.from(payload||''); let head; if(data.length<126) head=Buffer.from([0x82,0x80|data.length]); else { head=Buffer.alloc(4); head[0]=0x82; head[1]=0x80|126; head.writeUInt16BE(data.length,2); } const mask=Buffer.from([1,2,3,4]); const out=Buffer.alloc(data.length); for(let i=0;i<data.length;i++) out[i]=data[i]^mask[i%4]; return Buffer.concat([head,mask,out]); }
function fakeClient(){ const written=[]; return { id:'c-test', parser:new (require('./src/server/wsFrameParser').WebSocketFrameParser)(), state:'open', isClosed:false, room:{code:'ERR'}, socket:{ write(){}, end(){} }, heartbeat:{ lastInboundAt:0,lastPongAt:0 }, written }; }
const sent=[];
transport.configureTransport({ send:(c,m)=>sent.push(m), handleMessage:()=>{ throw new Error('controlled join failure'); } });
const c=fakeClient();
transport.handleSocketData(c, masked(encodeMessage({type:'join',name:'Tester',room:'ERR',protocolVersion:1,capabilities:[]})));
assert.strictEqual(c.badMessageCount || 0, 0, 'handler exception does not increment malformed count');
assert.strictEqual(sent.at(-1).code, 'internal-error');
assert.strictEqual(sent.at(-1).stage, 'route-dispatch');
assert.strictEqual(sent.at(-1).routeType, 'join');
assert.strictEqual(transport.transportDiagnostics.handlerFailures.at(-1).routeType, 'join');
transport.configureTransport({ send:(c,m)=>sent.push(m), handleMessage:()=>{} });
const c2=fakeClient();
transport.handleSocketData(c2, masked(Buffer.from([0xc1])));
assert.strictEqual(c2.badMessageCount, 1, 'malformed MessagePack increments malformed count');
assert.strictEqual(sent.at(-1).code, 'bad-message');
assert.strictEqual(sent.at(-1).stage, 'messagepack-decode');
console.log('websocket handler/decode error classification passed');
