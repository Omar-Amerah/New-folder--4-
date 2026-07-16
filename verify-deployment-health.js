const assert = require('assert');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { createGameServer } = require('./server');

function request(port, path='/health', opts={}){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path,method:opts.method||'GET',headers:opts.headers||{}},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({res,body}));});req.on('error',reject);req.end();});}
function wsReq(port, origin){return new Promise((resolve)=>{const s=net.connect(port,'127.0.0.1',()=>{const key=crypto.randomBytes(16).toString('base64');const lines=[`GET /socket HTTP/1.1`,`Host: 127.0.0.1:${port}`,'Upgrade: websocket','Connection: Upgrade','Sec-WebSocket-Version: 13',`Sec-WebSocket-Key: ${key}`]; if(origin) lines.push(`Origin: ${origin}`); lines.push('',''); s.write(lines.join('\r\n'));});let data='';s.on('data',d=>{data+=d});s.on('close',()=>resolve(data));setTimeout(()=>{s.destroy();resolve(data)},500);});}
(async()=>{
 const oldEnv=process.env.NODE_ENV, oldAllow=process.env.WS_ALLOWED_ORIGINS;
 const srv=createGameServer({port:0,allowedOrigins:'https://front.example'}); await srv.start(); const port=srv.address().port;
 try{
  let r=await request(port); assert.equal(r.res.statusCode,200); assert.equal(r.res.headers['cache-control'],'no-store'); const body=JSON.parse(r.body); assert.equal(body.ok,true); assert.equal(body.service,'modular-fleet-arena'); assert.equal(body.protocolVersion,4); assert.equal(body.originPolicy,'allowlist');
  for (const forbidden of ['resumeToken','resumeCredentials','players','room','rooms','ip','allowedOrigins','snapshots']) assert(!Object.prototype.hasOwnProperty.call(body,forbidden),`sensitive field ${forbidden}`);
  r=await request(port,'/health',{method:'HEAD'}); assert.equal(r.res.statusCode,200); assert.equal(r.body,''); assert.equal(r.res.headers['cache-control'],'no-store');
  r=await request(port,'/health',{headers:{Origin:'https://front.example'}}); assert.equal(r.res.headers['access-control-allow-origin'],'https://front.example');
  r=await request(port,'/health',{headers:{Origin:'https://evil.example'}}); assert.equal(r.res.headers['access-control-allow-origin'],undefined);
  assert((await wsReq(port,'https://evil.example')).startsWith('HTTP/1.1 403'),'strict ws origin rejected');
  assert((await wsReq(port,'https://front.example')).includes('101 Switching Protocols'),'allowed ws origin upgrades');
 } finally { await srv.stop(); process.env.NODE_ENV=oldEnv; if(oldAllow===undefined) delete process.env.WS_ALLOWED_ORIGINS; else process.env.WS_ALLOWED_ORIGINS=oldAllow; }
 process.env.NODE_ENV='production'; delete process.env.WS_ALLOWED_ORIGINS; let warned=''; const orig=console.warn; console.warn=(m)=>{warned+=m}; const prod=createGameServer({port:0}); await prod.start(); await prod.stop(); console.warn=orig; assert(warned.includes('Production WebSocket origin allowlist is empty. Cross-origin frontends such as Netlify will be rejected.'));
 console.log('deployment health verification passed');
})().catch(e=>{console.error(e);process.exit(1)});
