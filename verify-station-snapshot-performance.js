"use strict";

const assert = require("node:assert/strict");
const { createRoom, sanitizeRoomRules } = require("./src/server/rooms");
const { createStationsForRoom } = require("./src/server/stations");
const {
  snapshotRoom,
  buildSharedSnapshot,
  collectSnapshotStationStaticRevisions,
  collectSnapshotStationComponentRevisions,
  collectSnapshotConditionStationIds,
  markSnapshotStationStaticWritten,
  markSnapshotStationComponentWritten,
  markSnapshotConditionStationsWritten
} = require("./src/server/snapshots");
const { encodeMessage } = require("./src/server/wsCodec");

function makePlayer(id, team) {
  return {
    id,
    name: id,
    color: team === "blue" ? "#38d5ff" : "#ef4444",
    team,
    isBot: false,
    connected: true,
    ready: true,
    money: 1000,
    income: 0,
    earned: 0,
    spent: 0,
    shipCap: 6,
    deployedFleetCost: 0,
    destroyedEnemyCost: 0,
    lastReward: 0,
    kills: 0,
    losses: 0,
    captures: 0,
    ships: [],
    design: [{ x: 7, y: 7, type: "core", rotation: 0 }],
    stats: { unitCost: 1 },
    shipsBuilt: 0,
    lostFleetCost: 0
  };
}

function markWritten(client, snapshot) {
  markSnapshotStationStaticWritten(client, collectSnapshotStationStaticRevisions(snapshot));
  markSnapshotStationComponentWritten(client, collectSnapshotStationComponentRevisions(snapshot));
  markSnapshotConditionStationsWritten(client, collectSnapshotConditionStationIds(snapshot));
}

(async () => {
  const room = createRoom("SPER");
  room.rules = sanitizeRoomRules({
    ...room.rules,
    gameMode: "teams",
    infrastructureMode: "stations",
    visibilityMode: "sensors"
  }, 2);
  room.phase = "active";
  const blue = makePlayer("blue-player", "blue");
  const red = makePlayer("red-player", "red");
  room.players.set(blue.id, blue);
  room.players.set(red.id, red);
  createStationsForRoom(room, 0);

  const client = { id: "blue-client", room, player: blue };
  room._buildingSnapshotSeq = 1;
  // Delivery builds one viewer-independent compact shared layer even when a
  // recipient needs a full baseline. Exercise that exact layering contract.
  const fullShared = buildSharedSnapshot(room, 1000, false, true);
  const full = snapshotRoom(room, 1000, blue, true, fullShared, client);
  markWritten(client, full);

  room._buildingSnapshotSeq = 2;
  room._buildingBaseSnapshotSeq = 1;
  const compact = snapshotRoom(room, 1033, blue, false, null, client);
  const alliedFull = full.stations.find((station) => station.team === blue.team);
  const alliedCompact = compact.stations.find((station) => station.id === alliedFull.id);

  assert.ok(alliedFull.design?.length, "full station baseline contains design geometry");
  assert.ok(alliedFull.hardpoints?.length, "full station baseline contains hardpoints");
  assert.ok(alliedFull.componentHp?.length, "full visible station baseline contains component health");
  assert.equal(alliedFull.stationType, "home", "full station baseline restores its infrastructure type");
  assert.ok(alliedFull.hangar?.id === "central", "full station baseline carries one central hangar record");
  assert.equal(alliedFull.launchBays, undefined, "full station baseline carries no launch-bay array");
  assert.equal(alliedFull.hangars, undefined, "full station baseline carries no plural compatibility hangar");
  assert.ok(Number.isFinite(alliedFull.x) && Number.isFinite(alliedFull.y), "full station baseline restores its world position");
  assert.ok(Number.isFinite(alliedFull.radius) && alliedFull.radius > 0, "full station baseline restores its collision radius");
  assert.equal(alliedCompact.design, undefined, "compact station update omits cached design");
  assert.equal(alliedCompact.hardpoints, undefined, "compact station update omits cached hardpoints");
  assert.equal(alliedCompact.componentHp, undefined, "unchanged compact station update omits cached health");
  assert.equal(alliedCompact.hangar, undefined, "compact station update omits cached hangar geometry");
  assert.equal(alliedCompact.launchBays, undefined, "compact station update carries no launch-bay array");
  assert.equal(alliedCompact.hangars, undefined, "compact station update carries no plural compatibility hangar");
  assert.ok(Array.isArray(alliedCompact.weaponAnglePairs), "compact station update carries sparse turret bearings");

  const fullStationBytes = encodeMessage(full.stations).length;
  const compactStationBytes = encodeMessage(compact.stations).length;
  const fullSnapshotBytes = encodeMessage(full).length;
  const compactSnapshotBytes = encodeMessage(compact).length;
  assert.ok(
    compactStationBytes < fullStationBytes * 0.35,
    `compact station payload stays below 35% of its baseline (${compactStationBytes}/${fullStationBytes})`
  );
  assert.ok(
    compactSnapshotBytes < 8 * 1024,
    `two-player station-plus-fog compact snapshot stays below 8 KiB (${compactSnapshotBytes})`
  );

  const authoritative = room.stationsById.get(alliedFull.id);
  authoritative.componentHp[0] = Math.max(0, authoritative.componentHp[0] - 10);
  authoritative.healthRevision += 1;
  authoritative.componentDamageRevision += 1;
  room._buildingSnapshotSeq = 3;
  room._buildingBaseSnapshotSeq = 2;
  const damaged = snapshotRoom(room, 1066, blue, false, null, client);
  const damagedAllied = damaged.stations.find((station) => station.id === alliedFull.id);
  assert.ok(damagedAllied.componentHp?.length, "changed station health sends a fresh authoritative component baseline");

  markWritten(client, damaged);
  client.knownConditionStationIds.delete(alliedFull.id);
  room._buildingSnapshotSeq = 4;
  room._buildingBaseSnapshotSeq = 3;
  const reacquired = snapshotRoom(room, 1099, blue, false, null, client);
  const reacquiredAllied = reacquired.stations.find((station) => station.id === alliedFull.id);
  assert.ok(reacquiredAllied.componentHp?.length, "condition reacquisition resends health even when its revision is unchanged");

  const merge = await import("./public/src/snapshotMerge.js");
  const fullMerged = merge.mergeFullSnapshot(full);
  assert.equal(fullMerged.ok, true);
  const compactMerged = merge.mergeCompactSnapshot(fullMerged.snapshot, compact);
  assert.equal(compactMerged.ok, true, compactMerged.reason);
  const mergedAllied = compactMerged.snapshot.stations.find((station) => station.id === alliedFull.id);
  assert.deepEqual(mergedAllied.design, alliedFull.design, "client retains full station geometry through compact updates");
  assert.deepEqual(mergedAllied.hangar, alliedFull.hangar, "client reconstructs central hangar geometry through compact updates");
  assert.equal(mergedAllied.launchBays, undefined, "client reconstructs no launch-bay array");
  assert.equal(mergedAllied.hangars, undefined, "merged station retains no multi-hangar field");
  assert.deepEqual(mergedAllied.componentHp, alliedFull.componentHp, "client retains unchanged component condition");
  assert.equal(mergedAllied.weaponAngles.length, alliedFull.weaponAngles.length, "client reconstructs the dense turret-angle API");

  delete room._buildingSnapshotSeq;
  delete room._buildingBaseSnapshotSeq;
  console.log(JSON.stringify({
    stations: full.stations.length,
    fullStationBytes,
    compactStationBytes,
    compactRatio: Math.round(compactStationBytes / fullStationBytes * 1000) / 1000,
    fullSnapshotBytes,
    compactSnapshotBytes
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
