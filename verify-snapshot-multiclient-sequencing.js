"use strict";
const assert = require("assert");
const { EventEmitter } = require("events");
const { decode } = require("@msgpack/msgpack");
const delivery = require("./src/server/snapshotDelivery");
const outbound = require("./src/server/outbound");

function makeRoom() {
  const players = new Map(); const ships = new Map(); const clients = new Set();
  const room = { code:"M", phase:"active", adminId:"p1", stateEpoch:1, snapshotSeq:0, staticRevision:1, componentCatalogueRevision:1, mapSizeLabel:"tiny", world:{width:100,height:100}, map:{seed:1,asteroids:[]}, rules:{gameMode:"solo"}, winner:null, matchStartedAt:1, maxScore:100, bullets:[], effects:[], points:[], controlVictory:null, players, ships, clients };
  for (let i=1;i<=3;i++) { const p={id:`p${i}`,name:`P${i}`,color:"#fff",team:`t${i}`,isBot:false,connected:true,ready:true,money:0,income:0,earned:0,spent:0,shipCap:3,deployedFleetCost:0,destroyedEnemyCost:0,lastReward:0,score:0,kills:0,losses:0,captures:0,ships:[],design:[{type:"core"}],stats:{unitCost:1},shipsBuilt:0,lostFleetCost:0,rallyPoint:{x:0,y:0}}; const s={id:`s${i}`,ownerId:p.id,designRevision:1,x:i,y:i,vx:0,vy:0,angle:0,targetX:0,targetY:0,hp:10,maxHp:10,shield:0,maxShield:0,radius:10,cost:1,weaponAngles:[],alive:true,stats:{unitCost:1},design:[{type:"core"},{type:"heatSink"}],componentHp:[10,20],componentHeat:[0,0],componentHeatState:[0,0],componentThermals:[{capacity:10},{capacity:20}],dirtyComponents:new Set(),dirtyHeat:new Set(),designSent:false}; p.ships.push(s); players.set(p.id,p); ships.set(s.id,s); }
  return room;
}
function client(room, id, pattern=[true]) { const socket = new EventEmitter(); socket.destroyed=false; socket.writes=[]; socket.pattern=pattern.slice(); socket.write=()=>true; const c={id, socket, room, player:room.players.get(id), isClosed:false}; room.clients.add(c); return c; }
function installWriter() { outbound.configureOutbound({ writeFrame(socket, payload) { const msg=decode(payload); socket.writes.push(msg); const ok = socket.pattern.length ? socket.pattern.shift() : true; return ok; } }); }
async function mergePackets(packets) { const m = await import("./public/src/snapshotMerge.js"); let snap=null, net={stateEpoch:0,snapshotSeq:0,staticRevision:0,hasFullBaseline:false}; for (const packet of packets) { const r=m.mergeSnapshotTransaction(snap, net, packet); assert.equal(r.ok, true, `${packet.snapshotKind} seq=${packet.snapshotSeq} base=${packet.baseSnapshotSeq} rejected ${r.reason}`); snap=r.snapshot; net=r.networkState; } return {snap, net}; }
(async()=>{
  installWriter();
  const room=makeRoom(); const a=client(room,"p1",[true,true,false]); const b=client(room,"p2",[true,true,true,true,true]); const c=client(room,"p3",[true,true,true,true,true]);
  delivery.broadcastSnapshot(room,1,true);
  assert.equal(a.socket.writes[0].snapshotSeq,1); assert.equal(b.socket.writes[0].snapshotSeq,1); assert.equal(c.socket.writes[0].snapshotSeq,1);
  await mergePackets(a.socket.writes); await mergePackets(b.socket.writes); await mergePackets(c.socket.writes);
  delivery.sendFullSnapshot(a,2,"client-request");
  assert.equal(a.socket.writes.at(-1).snapshotKind,"full"); assert.equal(a.socket.writes.at(-1).snapshotSeq,2); assert.equal(b.socket.writes.length,1,"targeted full skipped unrelated client");
  room.ships.get("s1").componentHp[0]=7; room.ships.get("s1").dirtyComponents.add(0); room.ships.get("s1").componentHeat[1]=5; room.ships.get("s1").dirtyHeat.add(1);
  delivery.broadcastSnapshot(room,3,false);
  const ac=a.socket.writes.at(-1), bc=b.socket.writes.at(-1), cc=c.socket.writes.at(-1);
  assert.equal(ac.snapshotSeq,3); assert.equal(bc.snapshotSeq,3); assert.equal(cc.snapshotSeq,3); assert.equal(ac.baseSnapshotSeq,2); assert.equal(bc.baseSnapshotSeq,1); assert.equal(cc.baseSnapshotSeq,1);
  await mergePackets(a.socket.writes); await mergePackets(b.socket.writes); await mergePackets(c.socket.writes);
  delivery.broadcastSnapshot(room,4,false); delivery.broadcastSnapshot(room,5,false); assert.ok(outbound.getOutbound(a).snapshot, "slow client has bounded queued snapshot"); assert.ok(a.socket.writes.length <= 3, "slow client did not receive unbounded writes"); assert.ok(b.socket.writes.at(-1).snapshotSeq > 3, "healthy client continues"); a.socket.emit("drain"); assert.ok(a.socket.writes.at(-1).snapshotKind === "full" || a.socket.writes.at(-1).baseSnapshotSeq === a.socket.writes.at(-2).snapshotSeq);
  await mergePackets(a.socket.writes); await mergePackets(b.socket.writes);
  const m = await import("./public/src/snapshotMerge.js"); const oldEpoch = {...a.socket.writes.at(-1), stateEpoch:1, snapshotSeq:99, snapshotKind:"compact", baseSnapshotSeq:a.socket.writes.at(-1).snapshotSeq}; assert.equal(m.inspectSnapshotEnvelope({stateEpoch:2,snapshotSeq:a.socket.writes.at(-1).snapshotSeq,staticRevision:1,hasFullBaseline:true}, oldEpoch).reason,"stale-epoch");
  console.log("Snapshot multiclient sequencing verification passed");
})().catch(e=>{console.error(e);process.exit(1);});
