const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { decodeBinary } = require('./src/server/wsCodec');
const { configureOutbound, flushOutbound, getOutbound } = require('./src/server/outbound');
const { broadcastSnapshot } = require('./src/server/snapshotDelivery');

function framePayload(frame){ const b=Buffer.from(frame); let off=2,len=b[1]&0x7f; if(len===126){len=b.readUInt16BE(2);off=4;} else if(len===127){len=b.readUInt32BE(6);off=10;} return b.subarray(off,off+len); }
class FakeSocket extends EventEmitter { constructor(){ super(); this.destroyed=false; this.block=false; this.frames=[]; } write(buf){ this.frames.push(Buffer.from(buf)); return !this.block; } drain(){ this.block=false; this.emit('drain'); } }
function makeRoom(){ const ship={id:'s1',ownerId:'p1',designRevision:1,x:0,y:0,vx:0,vy:0,angle:0,targetX:0,targetY:0,hp:100,maxHp:100,shield:0,maxShield:0,radius:10,cost:10,stats:{unitCost:10},weaponAngles:[],alive:true,design:[{type:'core'}],componentHp:[10,20],componentHeat:[0,0],componentHeatState:[0,0],componentThermals:[{capacity:10},{capacity:10}],dirtyComponents:new Set(),dirtyHeat:new Set()}; const player={id:'p1',name:'p1',color:'#fff',team:'A',ready:true,money:0,income:0,earned:0,spent:0,shipCap:10,ships:[ship],design:[{type:'core'}],stats:{},connected:true}; return {code:'T',stateEpoch:1,snapshotSeq:0,staticRevision:1,componentCatalogueRevision:1,clients:new Set(),players:new Map([['p1',player]]),ships:new Map([['s1',ship]]),bullets:[],points:[],effects:[],phase:'active',adminId:'p1',rules:{},world:{width:1000,height:1000},map:{name:'m'},mapSizeLabel:'test'}; }
const written=[]; configureOutbound({ writeFrame(socket,payload,opcode){ const ok=socket.write(Buffer.concat([Buffer.from([0x80|opcode,payload.length]),Buffer.from(payload)])); if(ok) written.push(decodeBinary(payload)); return ok; }});
const room=makeRoom(); const socket=new FakeSocket(); const client={socket,isClosed:false,room,player:room.players.get('p1')}; room.clients.add(client);
broadcastSnapshot(room, Date.now(), true); assert.equal(written.at(-1).snapshotKind,'full');
socket.block=true;
room.ships.get('s1').x=10; room.ships.get('s1').dirtyComponents.add(0); room.ships.get('s1').componentHp[0]=7; broadcastSnapshot(room, Date.now());
assert.equal(getOutbound(client).blocked,true);
room.ships.get('s1').x=20; room.ships.get('s1').dirtyHeat.add(1); room.ships.get('s1').componentHeat[1]=5; broadcastSnapshot(room, Date.now());
assert.equal(getOutbound(client).snapshot.kind,'snapshot-compact');
room.ships.get('s1').x=25;
broadcastSnapshot(room, Date.now());
assert.equal(getOutbound(client).snapshot,null, 'third blocked update promotes to full and drops queued compact');
const ship2={...room.ships.get('s1'),id:'s2',x:30,componentHp:[5,6],componentHeat:[1,2],componentHeatState:[0,0],componentThermals:[{capacity:10},{capacity:10}],dirtyComponents:new Set(),dirtyHeat:new Set(),designSent:false}; room.ships.set('s2',ship2); room.players.get('p1').ships.push(ship2); room.staticRevision++;
broadcastSnapshot(room, Date.now());
socket.drain(); flushOutbound(client);
const states=written.filter(m=>m.type==='state');
assert.ok(states.length>=3);
let prev=0; for(const s of states){ if(s.snapshotKind==='compact') assert.equal(s.baseSnapshotSeq,prev); prev=s.snapshotSeq; }
const final=states.at(-1); assert.equal(final.snapshotKind,'full'); assert.equal(final.ships.find(s=>s.id==='s1').chp[0],7); assert.equal(final.ships.find(s=>s.id==='s1').componentHeat[1][0],5); assert.ok(final.ships.find(s=>s.id==='s2').design); assert.ok(final.world&&final.map&&final.rules); assert.equal(client.snapshotBaseline.lastWrittenSeq, final.snapshotSeq); assert.equal(client.snapshotBaseline.lastQueuedSeq,0);
console.log(`snapshot coalescing passed with ${states.length} written snapshots; final seq ${final.snapshotSeq}`);
