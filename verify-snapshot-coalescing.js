"use strict";
const assert = require('assert');
const EventEmitter = require('events');
const { decode } = require('@msgpack/msgpack');
const outbound = require('./src/server/outbound');
const delivery = require('./src/server/snapshotDelivery');

class Socket extends EventEmitter { constructor(pattern){ super(); this.pattern = pattern.slice(); this.destroyed=false; this.writes=[]; } write(){ return this.pattern.length ? this.pattern.shift() : true; } }
function room() {
  const player = { id:'p', name:'Pilot', color:'#39f', team:'blue', isBot:false, connected:true, ready:false, money:0, income:0, earned:0, spent:0, shipCap:3, deployedFleetCost:0, destroyedEnemyCost:0, lastReward:0, score:0, kills:0, losses:0, captures:0, ships:[], design:[{type:'core'}], stats:{unitCost:1}, shipsBuilt:0, lostFleetCost:0, rallyPoint:{x:0,y:0} };
  const ship = { id:'s', ownerId:'p', designRevision:1, x:1, y:2, vx:0, vy:0, angle:0, targetX:0, targetY:0, hp:100, maxHp:100, shield:0, maxShield:0, radius:10, cost:1, weaponAngles:[0], alive:true, stats:{unitCost:1}, design:[{type:'core'},{type:'engine'}], componentHp:[10,20], componentHeat:[1,2], componentHeatState:[0,0], componentThermals:[{capacity:10},{capacity:20}], dirtyComponents:new Set(), dirtyHeat:new Set(), designSent:false };
  player.ships.push(ship);
  const r = { code:'R', phase:'active', adminId:'p', stateEpoch:1, snapshotSeq:0, staticRevision:1, componentCatalogueRevision:1, mapSizeLabel:'tiny', world:{width:100,height:100}, map:{seed:1,asteroids:[]}, rules:{gameMode:'solo'}, winner:null, matchStartedAt:1, maxScore:100, bullets:[], effects:[{id:'e', at:0, x:1, y:1}], points:[], controlVictory:null, players:new Map([[player.id, player]]), ships:new Map([[ship.id, ship]]), clients:new Set() };
  return { r, player, ship };
}
async function mergeAll(packets) { const m = await import('./public/src/snapshotMerge.js'); let snap=null, net={stateEpoch:0,snapshotSeq:0,staticRevision:0,hasFullBaseline:false}; for (const packet of packets) { const res=m.mergeSnapshotTransaction(snap, net, packet); assert.equal(res.ok, true, res.reason); snap=res.snapshot; net=res.networkState; } return snap; }
function attach(r, pattern){ const socket = new Socket(pattern); const client = { id:'c', socket, isClosed:false, player:null, room:r }; client.player = r.players.get('p'); r.clients.add(client); return client; }
const captured = new Map(); outbound.configureOutbound({ writeFrame(socket, payload){ const packet = decode(payload); socket.writes.push(packet); return socket.pattern.length ? socket.pattern.shift() : true; } });
(async()=>{
  // A: always writable full then compacts, every written packet merges.
  { const {r,ship}=room(); const c=attach(r,[true,true,true]); delivery.sendFullSnapshot(c,1); ship.x=3; delivery.broadcastSnapshot(r,2); ship.x=4; delivery.broadcastSnapshot(r,3); assert.deepEqual(c.socket.writes.map(p=>p.snapshotKind), ['full','compact','compact']); await mergeAll(c.socket.writes); }
  // B/E: block after compact; newer compact candidate promotes to full preserving hp/heat/new ship/static/map.
  { const {r,ship,player}=room(); const c=attach(r,[true,false]); delivery.sendFullSnapshot(c,1); ship.x=5; delivery.broadcastSnapshot(r,2); ship.componentHp[0]=7; ship.dirtyComponents.add(0); ship.componentHeat[1]=9; ship.dirtyHeat.add(1); const n={...ship, id:'n', design:[{type:'core'}], componentHp:[6], componentHeat:[4], componentHeatState:[0], componentThermals:[{capacity:10}], dirtyComponents:new Set(), dirtyHeat:new Set(), designSent:false}; r.ships.set('n', n); player.ships.push(n); delivery.broadcastSnapshot(r,3); ship.x=8; delivery.broadcastSnapshot(r,4); assert.equal(c.socket.writes.length,2); assert.equal(outbound.getOutbound(c).snapshot.meta.snapshotKind,'full'); c.socket.emit('drain'); assert.deepEqual(c.socket.writes.map(p=>p.snapshotKind), ['full','compact','full']); const snap=await mergeAll(c.socket.writes); assert.equal(snap.ships.find(s=>s.id==='s').chp[0],7); assert.equal(snap.ships.find(s=>s.id==='s').componentHeat[1][0],9); assert.ok(snap.ships.find(s=>s.id==='n').design); assert.ok(snap.map && snap.world && snap.rules); }
  // C: after promoted full is written, next compact bases on that written full.
  { const {r,ship}=room(); const c=attach(r,[true,false,true]); delivery.sendFullSnapshot(c,1); delivery.broadcastSnapshot(r,2); ship.x=6; delivery.broadcastSnapshot(r,3); c.socket.emit('drain'); ship.x=7; delivery.broadcastSnapshot(r,4); const last=c.socket.writes.at(-1); assert.equal(last.snapshotKind,'compact'); assert.equal(last.baseSnapshotSeq, c.socket.writes.at(-2).snapshotSeq); await mergeAll(c.socket.writes); }
  // D: multiple full requests while blocked leave only latest queued full.
  { const {r}=room(); const c=attach(r,[false]); delivery.sendFullSnapshot(c,1); delivery.sendFullSnapshot(c,2); delivery.sendFullSnapshot(c,3); assert.equal(outbound.getOutbound(c).snapshot.meta.snapshotKind,'full'); c.socket.emit('drain'); assert.equal(c.socket.writes.length,2); assert.equal(c.socket.writes[1].snapshotKind,'full'); await mergeAll(c.socket.writes); }
  console.log('Snapshot coalescing verification passed');
})().catch(e=>{ console.error(e); process.exit(1); });
