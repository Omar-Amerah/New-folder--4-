const assert=require('assert'); const {WebSocketFrameParser}=require('./src/server/wsFrameParser');
function f(n){const d=Buffer.alloc(n,1),h=Buffer.from([0x82,0x80|n]),m=Buffer.from([1,2,3,4]),p=Buffer.alloc(n);for(let i=0;i<n;i++)p[i]=d[i]^m[i%4];return Buffer.concat([h,m,p]);}
for(let c=0;c<50;c++){const p=new WebSocketFrameParser();for(let i=0;i<20;i++)assert.strictEqual(p.push(f(10))[0].type,'message');p.reset();assert.strictEqual(p.diagnostics().bufferedBytes,0)}
console.log('websocket soak verification passed');
