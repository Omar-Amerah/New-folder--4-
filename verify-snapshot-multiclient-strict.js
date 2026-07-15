"use strict";
const assert = require('assert/strict');
const EventEmitter = require('events');
const { decode } = require('@msgpack/msgpack');
const outbound = require('./src/server/outbound');
const delivery = require('./src/server/snapshotDelivery');

class Socket extends EventEmitter { constructor(pattern){ super(); this.pattern=pattern.slice(); this.destroyed=false; this.writes=[]; } write(){ return this.pattern.length ? this.pattern.shift() : true; } }
function makePlayer(id){ return { id, name:id, color:'#39f', team:'blue', isBot:false, connected:true, ready:false, money:0, income:0, earned:0, spent:0, shipCap:5, deployedFleetCost:0, destroyedEnemyCost:0, lastReward:0, score:0, kills:0, losses:0, captures:0, ships:[], design:[{type:'core'}], stats:{unitCost:1}, shipsBuilt:0, lostFleetCost:0, rallyPoint:{x:0,y:0} }; }
function makeShip(id, ownerId, x=1){ return { id, ownerId, designRevision:1, x, y:2, vx:0, vy:0, angle:0, targetX:0, targetY:0, hp:100, maxHp:100, shield:3, maxShield:5, radius:10, cost:1, weaponAngles:[0], alive:true, stats:{unitCost:1}, design:[{type:'core'},{type:'engine'}], componentHp:[10,20], componentHeat:[1,2], componentHeatState:[0,0], componentThermals:[{capacity:10},{capacity:20}], dirtyComponents:new Set(), dirtyHeat:new Set(), designSent:false }; }
function room(){ const pa=makePlayer('pa'), pb=makePlayer('pb'), pc=makePlayer('pc'); const s=makeShip('s','pa'); pa.ships.push(s); return { code:'R', phase:'active', adminId:'pa', stateEpoch:1, snapshotSeq:0, staticRevision:1, componentCatalogueRevision:1, mapSizeLabel:'tiny', world:{width:100,height:100}, map:{seed:1,asteroids:[]}, rules:{gameMode:'solo'}, winner:null, matchStartedAt:1, maxScore:100, bullets:[], effects:[], points:[], controlVictory:null, players:new Map([[pa.id,pa],[pb.id,pb],[pc.id,pc]]), ships:new Map([[s.id,s]]), clients:new Set() }; }
function attach(r,id,pattern){ const socket=new Socket(pattern); const client={id,socket,isClosed:false,room:r,player:r.players.get(id)}; r.clients.add(client); return client; }
async function mergeWritten(writes){ const m=await import('./public/src/snapshotMerge.js'); let snap=null, net={stateEpoch:0,snapshotSeq:0,staticRevision:0,hasFullBaseline:false}; let prev=0; for(const packet of writes){ if(packet.snapshotKind==='compact'){ assert.equal(packet.snapshotSeq, prev+1, `${packet.snapshotSeq} not contiguous from ${prev}`); assert.equal(packet.baseSnapshotSeq, prev, 'compact base must equal previous accepted'); } const res=m.mergeSnapshotTransaction(snap, net, packet); assert.equal(res.ok, true, `${res.reason} ${JSON.stringify(packet)}`); snap=res.snapshot; net=res.networkState; prev=net.snapshotSeq; } return snap; }
outbound.configureOutbound({ writeFrame(socket,payload){ const packet=decode(payload); socket.writes.push(packet); return socket.pattern.length ? socket.pattern.shift() : true; } });
(async()=>{
  const r=room(); const a=attach(r,'pa',[true,true,true,true,true,true]); const b=attach(r,'pb',[true,true,true,true,true,true]); const c=attach(r,'pc',[true,false]);
  delivery.broadcastSnapshot(r,1,true);
  assert.deepEqual([a,b,c].map(x=>x.socket.writes[0].snapshotSeq), [1,1,1]);
  r.ships.get('s').x=3; delivery.broadcastSnapshot(r,2);
  assert.deepEqual([a,b,c].map(x=>x.socket.writes[1].snapshotKind), ['compact','compact','compact']);
  assert.deepEqual([a,b,c].map(x=>x.socket.writes[1].snapshotSeq), [2,2,2]);
  delivery.sendFullSnapshot(a,3,'test-targeted');
  assert.equal(a.socket.writes.at(-1).snapshotKind,'full'); assert.equal(a.socket.writes.at(-1).snapshotSeq,3); assert.equal(b.socket.writes.at(-1).snapshotSeq,2);
  r.ships.get('s').x=4; delivery.broadcastSnapshot(r,4);
  assert.equal(a.socket.writes.at(-1).snapshotKind,'compact'); assert.equal(a.socket.writes.at(-1).snapshotSeq,4); assert.equal(a.socket.writes.at(-1).baseSnapshotSeq,3);
  assert.equal(b.socket.writes.at(-1).snapshotKind,'full'); assert.equal(b.socket.writes.at(-1).snapshotSeq,4);
  assert.equal(outbound.getOutbound(c).snapshot.meta.snapshotKind,'full'); assert.equal(outbound.getOutbound(c).snapshot.meta.snapshotSeq,4);
  const s=r.ships.get('s'); s.componentHp[0]=7; s.dirtyComponents.add(0); s.componentHeat[1]=9; s.dirtyHeat.add(1); const n=makeShip('n','pc',9); r.ships.set('n',n); r.players.get('pc').ships.push(n); delivery.broadcastSnapshot(r,5);
  assert.equal(outbound.getOutbound(c).snapshot.meta.snapshotKind,'full'); assert.equal(outbound.getOutbound(c).snapshot.meta.snapshotSeq,5);
  c.socket.emit('drain');
  const snaps=await Promise.all([mergeWritten(a.socket.writes),mergeWritten(b.socket.writes),mergeWritten(c.socket.writes)]);
  for(const snap of snaps){ const ship=snap.ships.find(x=>x.id==='s'); const newer=snap.ships.find(x=>x.id==='n'); assert.ok(newer?.design); assert.equal(ship.chp[0],7); assert.equal(ship.componentHeat[1][0],9); assert.ok(snap.map&&snap.world&&snap.rules); }
  console.log('Snapshot multi-client strict verification passed');
})().catch(e=>{ console.error(e); process.exit(1); });
