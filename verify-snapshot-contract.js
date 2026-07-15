"use strict";
const assert = require("assert");
(async () => {
  const m = await import("./public/src/snapshotMerge.js");
  const full = {
    type:"state", room:"R", stateEpoch:1, snapshotSeq:1, snapshotKind:"full", staticRevision:1,
    players:[{id:"p",design:[{type:"core"}],stats:{kills:0},name:"Pilot",team:"blue",colour:"#39f",score:7}],
    ships:[{id:"s",ownerId:"p",alive:true,design:[{type:"core"},{type:"engine"},{type:"heatSink"}],chp:[10,20,30],componentHeat:[[1,0,0.1,10],[2,0,0.2,10],[0,0,0,10]]}],
    bullets:[], effects:[], map:{seed:1}, world:{width:1}, rules:{asteroidDensity:"none"}
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

  assert.equal(m.inspectSnapshotEnvelope(r2.networkState, compact2).reason, "duplicate-sequence");
  assert.equal(m.inspectSnapshotEnvelope(r2.networkState, {...compact2,snapshotSeq:1}).reason, "stale-sequence");
  assert.equal(m.inspectSnapshotEnvelope(r1.networkState, {...compact2,snapshotSeq:3,baseSnapshotSeq:2}).reason, "sequence-gap");
  assert.equal(m.inspectSnapshotEnvelope(r1.networkState, {...compact2,baseSnapshotSeq:0}).reason, "wrong-base");
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
  const epochFull = {...full,stateEpoch:2,snapshotSeq:1,ships:[{id:"s",design:[{type:"new"}],chp:[1],componentHeat:[[0,0,0,0]]}]};
  assert.equal(m.mergeSnapshotTransaction(r2.snapshot, r2.networkState, epochFull).snapshot.ships[0].chp[0], 1);
  console.log("Snapshot contract verification passed");
})().catch((err)=>{ console.error(err); process.exit(1); });
