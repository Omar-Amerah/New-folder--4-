"use strict";
const assert = require("assert");
(async () => {
  const m = await import("./public/src/snapshotMerge.js");
  const full = { type:"state", room:"R", stateEpoch:1, snapshotSeq:1, snapshotKind:"full", staticRevision:1, players:[{id:"p",design:[1]}], ships:[{id:"s",design:[{type:"core"}],chp:[10,20],componentHeat:[[1,0,0.1,10],[2,0,0.2,10]]}], bullets:[], effects:[], map:{seed:1}, world:{width:1}, rules:{} };
  const r1 = m.mergeSnapshotTransaction(null, {stateEpoch:0,snapshotSeq:0,hasFullBaseline:false}, full);
  assert.equal(r1.ok, true);
  const compact = { type:"state", room:"R", stateEpoch:1, snapshotSeq:2, snapshotKind:"compact", baseSnapshotSeq:1, staticRevision:1, players:[{id:"p"}], ships:[{id:"s",chpD:[0,9],componentHeatD:[1,3,0,0.3,10]}], bullets:[], effects:[] };
  const r2 = m.mergeSnapshotTransaction(r1.snapshot, r1.networkState, compact);
  assert.equal(r2.ok, true); assert.deepEqual(r2.snapshot.ships[0].chp, [9,20]); assert.deepEqual(r1.snapshot.ships[0].chp, [10,20]);
  assert.equal(m.inspectSnapshotEnvelope(r2.networkState, compact).reason, "duplicate-sequence");
  assert.equal(m.inspectSnapshotEnvelope(r2.networkState, {...compact,snapshotSeq:1}).reason, "stale-sequence");
  assert.equal(m.inspectSnapshotEnvelope(r1.networkState, {...compact,snapshotSeq:3,baseSnapshotSeq:2}).reason, "sequence-gap");
  assert.equal(m.inspectSnapshotEnvelope(r1.networkState, {...compact,baseSnapshotSeq:0}).reason, "wrong-base");
  assert.equal(m.inspectSnapshotEnvelope(r1.networkState, {...compact,stateEpoch:2,snapshotSeq:1}).reason, "missing-baseline");
  assert.equal(m.inspectSnapshotEnvelope({stateEpoch:2,snapshotSeq:1,hasFullBaseline:true}, {...compact,stateEpoch:1}).reason, "stale-epoch");
  assert.equal(m.inspectSnapshotEnvelope({stateEpoch:1,snapshotSeq:0,hasFullBaseline:false}, compact).reason, "missing-baseline");
  assert.equal(m.inspectSnapshotEnvelope({...r1.networkState, staticRevision:2}, compact).reason, "static-revision-mismatch");
  for (const bad of [[0], [0, 1, 0, 2], [2, 1], [0, 1, 0, 2]]) {
    const msg = {...compact, snapshotSeq:2, chaff:1, ships:[{id:"s", chpD:bad}]};
    assert.equal(m.mergeSnapshotTransaction(r1.snapshot, r1.networkState, msg).ok, false);
  }
  assert.equal(m.mergeSnapshotTransaction(r1.snapshot, r1.networkState, {...compact, ships:[{id:"new",design:[],chp:[1],componentHeat:[]}] }).ok, true);
  assert.equal(m.mergeSnapshotTransaction(r1.snapshot, r1.networkState, {...compact, ships:[] }).snapshot.ships.length, 0);
  const epochFull = {...full,stateEpoch:2,snapshotSeq:1,ships:[{id:"s",design:[{type:"new"}],chp:[1],componentHeat:[[0,0,0,0]]}]};
  assert.equal(m.mergeSnapshotTransaction(r2.snapshot, r2.networkState, epochFull).snapshot.ships[0].chp[0], 1);
  console.log("Snapshot contract verification passed");
})().catch((err)=>{ console.error(err); process.exit(1); });
