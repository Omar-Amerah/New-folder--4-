"use strict";
const assert = require("assert");
const { encode, decode } = require("@msgpack/msgpack");
const { snapshotRoom } = require("./src/server/snapshots");
(async () => {
  const m = await import("./public/src/snapshotMerge.js");
  const full = {
    type:"state", room:"R", stateEpoch:1, snapshotSeq:1, snapshotKind:"full", staticRevision:1,
    players:[{id:"p",design:[{type:"core"}],stats:{kills:0},name:"Pilot",team:"blue",colour:"#39f",score:7}],
    ships:[{id:"s",ownerId:"p",alive:true,design:[{type:"core"},{type:"engine"},{type:"heatSink"}],chp:[10,20,30],componentHeat:[[1,0,0.1,10],[2,0,0.2,10],[0,0,0,10]]}],
    bullets:[], effects:[], map:{seed:1}, world:{width:1}, rules:{asteroidDensity:"none"}, mapSizeLabel:"small"
  };
  const baselineNet = {stateEpoch:0,snapshotSeq:0,staticRevision:undefined,hasFullBaseline:false};
  const r1 = m.mergeSnapshotTransaction(null, baselineNet, full);
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.snapshot.ships[0].design, full.ships[0].design);
  assert.deepEqual(r1.snapshot.ships[0].chp, [10,20,30]);
  assert.deepEqual(r1.snapshot.ships[0].componentHeat, [[1,0,0.1,10],[2,0,0.2,10],[0,0,0,10]]);

  const compact2 = { type:"state", room:"R", stateEpoch:1, snapshotSeq:2, snapshotKind:"compact", baseSnapshotSeq:1, staticRevision:1, players:[{id:"p",score:8}], ships:[{id:"s",ownerId:"p",alive:true,chpD:[0,9],componentHeatD:[1,3,0,0.3,10]}], bullets:[], effects:[] };
  const r2 = m.mergeSnapshotTransaction(r1.snapshot, r1.networkState, compact2);
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.snapshot.ships[0].design, full.ships[0].design);
  assert.deepEqual(r2.snapshot.ships[0].chp, [9,20,30]);
  assert.deepEqual(r2.snapshot.ships[0].componentHeat, [[1,0,0.1,10],[3,0,0.3,10],[0,0,0,10]]);
  assert.equal(r2.snapshot.ships[0].design.length, r2.snapshot.ships[0].chp.length);
  assert.equal(r2.snapshot.ships[0].design.length, r2.snapshot.ships[0].componentHeat.length);
  assert.deepEqual(r1.snapshot.ships[0].chp, [10,20,30]);
  assert.deepEqual(r1.snapshot.ships[0].componentHeat[1], [2,0,0.2,10]);

  const compact3 = { ...compact2, snapshotSeq:3, baseSnapshotSeq:2, players:[{id:"p",score:9}], ships:[{id:"s",ownerId:"p",alive:true,chpD:[2,25],componentHeatD:[0,4,1,0.4,10,2,5,0,0.5,10]}] };
  const r3 = m.mergeSnapshotTransaction(r2.snapshot, r2.networkState, compact3);
  assert.equal(r3.ok, true);
  assert.deepEqual(r3.snapshot.ships[0].chp, [9,20,25]);
  assert.deepEqual(r3.snapshot.ships[0].componentHeat, [[4,1,0.4,10],[3,0,0.3,10],[5,0,0.5,10]]);
  assert.equal(r3.snapshot.ships[0].design.length, r3.snapshot.ships[0].chp.length);
  assert.equal(r3.snapshot.ships[0].design.length, r3.snapshot.ships[0].componentHeat.length);
  assert.deepEqual(r3.snapshot.players[0].design, full.players[0].design);
  assert.deepEqual(r3.snapshot.players[0].stats, full.players[0].stats);
  assert.equal(r3.snapshot.players[0].name, "Pilot");
  assert.equal(r3.snapshot.players[0].team, "blue");
  assert.equal(r3.snapshot.players[0].colour, "#39f");
  assert.equal(r3.snapshot.players[0].score, 9);
  assert.deepEqual(r3.snapshot.map, full.map);
  assert.deepEqual(r3.snapshot.world, full.world);
  assert.deepEqual(r3.snapshot.rules, full.rules);
  assert.equal(r3.snapshot.mapSizeLabel, full.mapSizeLabel);
  assert.deepEqual(r2.snapshot.ships[0].componentHeat, [[1,0,0.1,10],[3,0,0.3,10],[0,0,0,10]]);

  const compactMissingStatic = { type:"state", room:"R", stateEpoch:1, snapshotSeq:4, snapshotKind:"compact", baseSnapshotSeq:3, staticRevision:1, players:[{id:"p"}], ships:[{id:"s",ownerId:"p",alive:true}], bullets:[], effects:[] };
  const r4 = m.mergeSnapshotTransaction(r3.snapshot, r3.networkState, compactMissingStatic);
  assert.equal(r4.ok, true);
  assert.deepEqual(r4.snapshot.ships[0].design, full.ships[0].design);
  assert.deepEqual(r4.snapshot.ships[0].chp, [9,20,25]);
  assert.deepEqual(r4.snapshot.ships[0].componentHeat, [[4,1,0.4,10],[3,0,0.3,10],[5,0,0.5,10]]);
  assert.deepEqual(r4.snapshot.players[0].design, full.players[0].design);
  assert.deepEqual(r4.snapshot.players[0].stats, full.players[0].stats);
  assert.deepEqual(r4.snapshot.map, full.map);
  assert.deepEqual(r4.snapshot.world, full.world);
  assert.deepEqual(r4.snapshot.rules, full.rules);
  assert.equal(r4.snapshot.mapSizeLabel, full.mapSizeLabel);



  const nullStaticCompact = {
    type:"state", room:"R", stateEpoch:1, snapshotSeq:5, snapshotKind:"compact", baseSnapshotSeq:4, staticRevision:1,
    map:null, world:null, rules:null, mapSizeLabel:null,
    players:[{id:"p",design:null,stats:null,name:null,team:null,colour:null,color:null,score:0,money:0,ready:false,connected:false}],
    ships:[{id:"s",ownerId:"p",alive:true,design:null,chp:null,componentHeat:null,chpD:[1,18],componentHeatD:[1,6,0,0.6,10]}],
    bullets:[], effects:[], emptyObject:{}, emptyArray:[], falseValue:false, zeroValue:0
  };
  const r5 = m.mergeSnapshotTransaction(r4.snapshot, r4.networkState, nullStaticCompact);
  assert.equal(r5.ok, true);
  assert.deepEqual(r5.snapshot.map, full.map, "decoded null map preserves baseline");
  assert.deepEqual(r5.snapshot.world, full.world, "decoded null world preserves baseline");
  assert.deepEqual(r5.snapshot.rules, full.rules, "decoded null rules preserves baseline");
  assert.equal(r5.snapshot.mapSizeLabel, full.mapSizeLabel, "decoded null mapSizeLabel preserves baseline");
  assert.deepEqual(r5.snapshot.players[0].design, full.players[0].design, "decoded null player design preserves baseline");
  assert.deepEqual(r5.snapshot.players[0].stats, full.players[0].stats, "decoded null player stats preserves baseline");
  assert.equal(r5.snapshot.players[0].name, "Pilot");
  assert.equal(r5.snapshot.players[0].team, "blue");
  assert.equal(r5.snapshot.players[0].colour, "#39f");
  assert.equal(r5.snapshot.players[0].color, undefined);
  assert.equal(r5.snapshot.players[0].score, 0, "legitimate zero remains authoritative");
  assert.equal(r5.snapshot.players[0].money, 0, "legitimate zero money remains authoritative");
  assert.equal(r5.snapshot.players[0].ready, false, "legitimate false remains authoritative");
  assert.equal(r5.snapshot.players[0].connected, false, "legitimate false connected remains authoritative");
  assert.deepEqual(r5.snapshot.ships[0].design, full.ships[0].design, "decoded null ship design preserves baseline");
  assert.deepEqual(r5.snapshot.ships[0].chp, [9,18,25], "decoded null chp applies delta");
  assert.deepEqual(r5.snapshot.ships[0].componentHeat, [[4,1,0.4,10],[6,0,0.6,10],[5,0,0.5,10]], "decoded null heat applies delta");
  assert.deepEqual(r5.snapshot.emptyObject, {}, "legitimate empty object remains authoritative");
  assert.deepEqual(r5.snapshot.emptyArray, [], "legitimate empty array remains authoritative");
  assert.equal(r5.snapshot.falseValue, false, "legitimate false top-level value remains authoritative");
  assert.equal(r5.snapshot.zeroValue, 0, "legitimate zero top-level value remains authoritative");

  const undefinedWireCompact = decode(encode({
    ...nullStaticCompact,
    snapshotSeq:6,
    baseSnapshotSeq:5,
    map:undefined,
    world:undefined,
    rules:undefined,
    mapSizeLabel:undefined,
    players:[{id:"p",design:undefined,stats:undefined,name:undefined,team:undefined,colour:undefined,color:undefined,score:10}],
    ships:[{id:"s",ownerId:"p",alive:true,design:undefined,chp:undefined,componentHeat:undefined,chpD:[0,7],componentHeatD:[0,8,0,0.8,10]}]
  }));
  assert.equal(undefinedWireCompact.map, null, "MessagePack decodes explicit undefined properties as null");
  const r6 = m.mergeSnapshotTransaction(r5.snapshot, r5.networkState, undefinedWireCompact);
  assert.equal(r6.ok, true);
  assert.deepEqual(r6.snapshot.map, full.map);
  assert.deepEqual(r6.snapshot.world, full.world);
  assert.deepEqual(r6.snapshot.rules, full.rules);
  assert.equal(r6.snapshot.mapSizeLabel, full.mapSizeLabel);
  assert.deepEqual(r6.snapshot.players[0].design, full.players[0].design);
  assert.deepEqual(r6.snapshot.players[0].stats, full.players[0].stats);
  assert.deepEqual(r6.snapshot.ships[0].design, full.ships[0].design);
  assert.deepEqual(r6.snapshot.ships[0].chp, [7,18,25]);
  assert.deepEqual(r6.snapshot.ships[0].componentHeat, [[8,0,0.8,10],[6,0,0.6,10],[5,0,0.5,10]]);

  assert.equal(m.mergeSnapshotTransaction(r1.snapshot, r1.networkState, {...compact2, ships:[{id:"new-null",design:null,chp:[1],componentHeat:[]}] }).reason, "missing-baseline");

  assert.equal(m.inspectSnapshotEnvelope(r2.networkState, compact2).reason, "duplicate-sequence");
  assert.equal(m.inspectSnapshotEnvelope(r2.networkState, {...compact2,snapshotSeq:1}).reason, "stale-sequence");
  assert.equal(m.inspectSnapshotEnvelope(r1.networkState, {...compact2,snapshotSeq:10,baseSnapshotSeq:1}).ok, true, "compact sequence may skip when base matches current baseline");
  assert.equal(m.inspectSnapshotEnvelope(r1.networkState, {...compact2,snapshotSeq:10,baseSnapshotSeq:2}).reason, "sequence-gap");
  assert.equal(m.inspectSnapshotEnvelope(r1.networkState, {...compact2,snapshotSeq:10,baseSnapshotSeq:0}).reason, "wrong-base");
  assert.equal(m.inspectSnapshotEnvelope(r1.networkState, {...compact2,stateEpoch:2,snapshotSeq:1}).reason, "missing-baseline");
  assert.equal(m.inspectSnapshotEnvelope({stateEpoch:2,snapshotSeq:1,hasFullBaseline:true}, {...compact2,stateEpoch:1}).reason, "stale-epoch");
  assert.equal(m.inspectSnapshotEnvelope({stateEpoch:1,snapshotSeq:0,hasFullBaseline:false}, compact2).reason, "missing-baseline");
  assert.equal(m.inspectSnapshotEnvelope({...r1.networkState, staticRevision:2}, compact2).reason, "static-revision-mismatch");
  for (const bad of [[0], [0, 1, 0, 2], [3, 1], [0, 1, 0, 2]]) {
    const msg = {...compact2, snapshotSeq:2, chaff:1, ships:[{id:"s", chpD:bad}]};
    assert.equal(m.mergeSnapshotTransaction(r1.snapshot, r1.networkState, msg).ok, false);
  }
  assert.equal(m.mergeSnapshotTransaction(r1.snapshot, r1.networkState, {...compact2, ships:[{id:"new",design:[],chp:[1],componentHeat:[]}] }).ok, true);
  assert.equal(m.mergeSnapshotTransaction(r1.snapshot, r1.networkState, {...compact2, ships:[] }).snapshot.ships.length, 0);


  const room = {
    code:"WIRE", phase:"active", adminId:"p", stateEpoch:1, snapshotSeq:1, staticRevision:1, componentCatalogueRevision:1,
    mapSizeLabel:"tiny", world:{width:100,height:100,label:"tiny"}, map:{asteroids:[],relays:[]}, rules:{gameMode:"control"},
    winner:null, matchStartedAt:1, maxScore:100, bullets:[], effects:[], points:[], controlVictory:null,
    players:new Map(), ships:new Map()
  };
  const player = { id:"p", name:"Pilot", color:"#39f", team:"blue", isBot:false, connected:true, ready:false, money:0, income:0, earned:0, spent:0, shipCap:3, deployedFleetCost:0, destroyedEnemyCost:0, lastReward:0, score:0, kills:0, losses:0, captures:0, ships:[], design:[{type:"core"}], stats:{unitCost:1}, shipsBuilt:0, lostFleetCost:0, rallyPoint:{x:0,y:0} };
  const ship = { id:"ship", ownerId:"p", designRevision:1, x:0, y:0, vx:0, vy:0, angle:0, targetX:0, targetY:0, hp:10, maxHp:10, shield:0, maxShield:0, radius:10, cost:1, weaponAngles:[], alive:true, stats:{unitCost:1}, design:[{type:"core"},{type:"engine"}], componentHp:[10,20], componentHeat:[1,2], componentHeatState:[0,0], componentThermals:[{capacity:10},{capacity:20}], dirtyComponents:new Set([1]), dirtyHeat:new Set([1]), designSent:false };
  player.ships.push(ship);
  room.players.set(player.id, player);
  room.ships.set(ship.id, ship);
  const fullWire = decode(encode(snapshotRoom(room, 1000, player, true)));
  const acceptedFull = m.mergeSnapshotTransaction(null, baselineNet, fullWire);
  assert.equal(acceptedFull.ok, true);
  ship.designSent = true;
  room.snapshotSeq = 2;
  const compactPacket = snapshotRoom(room, 1100, player, false);
  assert.equal(Object.prototype.hasOwnProperty.call(compactPacket, "map"), false, "compact snapshotRoom omits map key");
  assert.equal(Object.prototype.hasOwnProperty.call(compactPacket, "world"), false, "compact snapshotRoom omits world key");
  assert.equal(Object.prototype.hasOwnProperty.call(compactPacket, "rules"), false, "compact snapshotRoom omits rules key");
  assert.equal(Object.prototype.hasOwnProperty.call(compactPacket, "mapSizeLabel"), false, "compact snapshotRoom omits mapSizeLabel key");
  assert.equal(Object.prototype.hasOwnProperty.call(compactPacket.players[0], "design"), false, "compact player omits design key");
  assert.equal(Object.prototype.hasOwnProperty.call(compactPacket.players[0], "stats"), false, "compact player omits stats key");
  const legacyCompactWire = decode(encode({ ...compactPacket, map:undefined, world:undefined, rules:undefined, mapSizeLabel:undefined, players: compactPacket.players.map((p) => ({...p, design:undefined, stats:undefined, name:undefined, team:undefined, color:undefined})), ships: compactPacket.ships.map((s) => ({...s, design:undefined, chp:undefined, componentHeat:undefined})) }));
  const mergedWire = m.mergeSnapshotTransaction(acceptedFull.snapshot, acceptedFull.networkState, legacyCompactWire);
  assert.equal(mergedWire.ok, true);
  assert.deepEqual(mergedWire.snapshot.map, fullWire.map);
  assert.deepEqual(mergedWire.snapshot.world, fullWire.world);
  assert.deepEqual(mergedWire.snapshot.rules, fullWire.rules);
  assert.equal(mergedWire.snapshot.mapSizeLabel, fullWire.mapSizeLabel);
  assert.deepEqual(mergedWire.snapshot.players[0].design, fullWire.players[0].design);
  assert.deepEqual(mergedWire.snapshot.players[0].stats, fullWire.players[0].stats);
  assert.equal(mergedWire.snapshot.players[0].name, fullWire.players[0].name);
  assert.equal(mergedWire.snapshot.players[0].team, fullWire.players[0].team);
  assert.equal(mergedWire.snapshot.players[0].color, fullWire.players[0].color);
  assert.deepEqual(mergedWire.snapshot.ships[0].design, fullWire.ships[0].design);
  assert.deepEqual(mergedWire.snapshot.ships[0].chp, [10,20]);
  assert.deepEqual(mergedWire.snapshot.ships[0].componentHeat, [[1,0,0.1,10],[2,0,0.1,20]]);
  assert.equal(mergedWire.snapshot.players[0].ready, false);
  assert.equal(mergedWire.snapshot.players[0].money, 0);

  const epochFull = {...full,stateEpoch:2,snapshotSeq:1,ships:[{id:"s",design:[{type:"new"}],chp:[1],componentHeat:[[0,0,0,0]]}]};
  assert.equal(m.mergeSnapshotTransaction(r2.snapshot, r2.networkState, epochFull).snapshot.ships[0].chp[0], 1);
  console.log("Snapshot contract verification passed");
})().catch((err)=>{ console.error(err); process.exit(1); });
