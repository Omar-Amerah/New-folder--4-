"use strict";

// Relay ownership is a live station transition, not a home-station destruction
// alias. This verifier exercises the authoritative transfer, component pools,
// recovery gating, recapture, snapshots and the client-facing state labels.

const assert = require("assert");

globalThis.document = globalThis.document || {
  getElementById: () => ({
    textContent: "",
    innerHTML: "",
    hidden: false,
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} },
    replaceChildren() {},
    addEventListener() {},
    removeEventListener() {}
  }),
  querySelector: () => null,
  querySelectorAll: () => [],
  body: null,
  addEventListener() {},
  removeEventListener() {},
  activeElement: null,
  visibilityState: "visible"
};
globalThis.window = globalThis.window || { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = globalThis.localStorage || { getItem() { return null; }, setItem() {}, removeItem() {} };
const { createRoom, sanitizeRoomRules } = require("./src/server/rooms");
const { createStationsForRoom, updateStations } = require("./src/server/stations");
const {
  damageStation,
  transferRelayControl,
  updateStationWeapons
} = require("./src/server/stationCombat");
const { snapshotRoom } = require("./src/server/snapshots");
const {
  buildEntityDeltaSnapshot,
  buildStateFromSnapshot
} = require("./src/server/snapshotEntityDelta");
const { INFRASTRUCTURE } = require("./src/server/config");
const { effectiveSensorRange } = require("./src/server/sensorCapability");

function player(id, team, removed = false) {
  return {
    id,
    name: id,
    team,
    removed,
    ready: true,
    connected: true,
    ships: [],
    money: 0,
    maxMoney: 99999,
    earned: 0,
    captures: 0,
    spent: 0,
    purchaseRequests: new Map(),
    design: [{ x: 7, y: 7, type: "core", rotation: 0 }],
    stats: { unitCost: 1 }
  };
}

function componentSum(station) {
  return (station.componentHp || []).reduce((sum, hp) => sum + (Number(hp) || 0), 0);
}

function makeRoom(id = "RELAY-TRANSFER") {
  const room = createRoom(id);
  room.rules = sanitizeRoomRules({
    ...room.rules,
    gameMode: "teams",
    infrastructureMode: "stations",
    visibilityMode: "none"
  }, 2);
  room.phase = "active";
  room.stateEpoch = 1;
  room.players.set("blue-1", player("blue-1", "blue"));
  room.players.set("blue-2", player("blue-2", "blue"));
  room.players.set("red-1", player("red-1", "red"));
  room.players.set("red-2", player("red-2", "red"));
  createStationsForRoom(room, 0);
  room.map.asteroids = [];
  const relay = room.stations.find((station) => station.stationType === "relay");
  relay.team = "blue";
  relay.ownerId = "blue-1";
  relay.state = "operational";
  relay.alive = true;
  return { room, relay };
}

function run() {
  console.log("verify-relay-transfer-recovery");
  const { room, relay } = makeRoom();
  const cfg = INFRASTRUCTURE.relayStation;
  const restoreRatio = Number(cfg.captureRestoreHpRatio);
  const recoveryRatio = Number(cfg.recoveryOperationalHpRatio);

  assert.strictEqual(relay.team, "blue", "blue owns an operational relay");
  assert.strictEqual(relay.state, "operational", "relay starts operational");
  assert.strictEqual(transferRelayControl(room, relay, "missing", 1), false, "missing attackers cannot transfer a relay");
  room.players.get("red-2").removed = true;
  assert.strictEqual(transferRelayControl(room, relay, "red-2", 2), false, "removed attackers cannot transfer a relay");
  assert.strictEqual(transferRelayControl(room, relay, "blue-1", 3), false, "same-team attackers cannot transfer a relay");
  room.players.get("red-2").removed = false;
  room.players.set("unassigned", player("unassigned", null));
  assert.strictEqual(transferRelayControl(room, relay, "unassigned", 4), false, "unassigned attackers cannot transfer a team relay");
  room.players.set("neutral", player("neutral", "neutral"));
  assert.strictEqual(transferRelayControl(room, relay, "neutral", 5), false, "neutral attackers cannot transfer a relay");

  const beforeShield = relay.shield;
  damageStation(room, relay, 50, "red-1", 10, relay.x + 500, relay.y);
  assert(relay.shield < beforeShield || beforeShield === 0, "red damage reduces the relay shield when one exists");
  assert(Math.abs(relay.hp - componentSum(relay)) < 0.001, "ordinary damage keeps aggregate and component hull equal");

  const beforeTransfer = snapshotRoom(room, 20, null, true);
  const beforeState = buildStateFromSnapshot(beforeTransfer, beforeTransfer.stateEpoch);
  relay.shield = 0;
  const redCapturesBefore = room.players.get("red-1").captures;
  damageStation(room, relay, relay.maxHp * 3, "red-1", 30, relay.x + 500, relay.y);

  assert.strictEqual(relay.ownerId, "red-1", "zero-hull relay transfers to the attacking player");
  assert.strictEqual(relay.team, "red", "zero-hull relay transfers to the attacking team");
  assert.strictEqual(relay.state, "recovering", "transferred relay enters recovery");
  assert.strictEqual(relay.alive, true, "transferred relay remains alive");
  assert.strictEqual(relay.shield, 0, "transferred relay shield is down");
  assert.strictEqual(relay.captureProgress, 0, "transfer clears capture progress");
  assert.strictEqual(relay.captureTeam, null, "transfer clears capture ownership progress");
  assert.strictEqual(relay.lastCapturedBy, "red-1", "transfer records the captor");
  assert.strictEqual(relay.lastCapturedAt, 30, "transfer records the capture time");
  assert(Math.abs(relay.hp - relay.maxHp * restoreRatio) < 0.001, "transfer restores the configured hull ratio");
  assert(Math.abs(relay.hp - componentSum(relay)) < 0.001, "transfer restores component and aggregate HP equally");
  assert(relay.componentHp.some((hp) => hp > 0), "transfer restores at least one component");
  assert.strictEqual(room.winner, null, "relay transfer does not finalize match victory");
  assert.strictEqual(room.phase, "active", "relay transfer does not end the match");
  assert.strictEqual(room.players.get("red-1").captures, redCapturesBefore + 1, "relay transfer awards one capture");
  assert.strictEqual(room.players.get("red-1").money, Number(require("./src/server/config").ECONOMY.captureBonus) || 0, "relay transfer awards the configured capture reward");

  const staleAimState = new Array(relay.design.length).fill("stale-target");
  relay.weaponAimTargetIds = staleAimState.slice();
  updateStationWeapons(room, [relay], [], 1, 35);
  assert.deepStrictEqual(relay.weaponAimTargetIds, staleAimState, "recovering relays do not run weapon or point-defence acquisition");
  assert.strictEqual(effectiveSensorRange(relay, room), 0, "recovering relays do not contribute sensors");

  const transferFull = snapshotRoom(room, 31, null, true);
  const transferCompact = snapshotRoom(room, 31, null, false);
  const fullRelay = transferFull.stations.find((station) => station.id === relay.id);
  const compactRelay = transferCompact.stations.find((station) => station.id === relay.id);
  assert.strictEqual(fullRelay.ownerId, "red-1", "full snapshots publish the new relay owner");
  assert.strictEqual(fullRelay.team, "red", "full snapshots publish the new relay team");
  assert.strictEqual(fullRelay.state, "recovering", "full snapshots publish recovery state");
  assert.strictEqual(fullRelay.shield, 0, "full snapshots publish the recovery shield state");
  assert.strictEqual(fullRelay.healthRevision, relay.healthRevision, "full snapshots publish health revision");
  assert.strictEqual(fullRelay.stateRevision, relay.stateRevision, "full snapshots publish state revision");
  assert.strictEqual(fullRelay.captureRevision, relay.captureRevision, "full snapshots publish capture revision");
  assert.strictEqual(fullRelay.componentDamageRevision, relay.componentDamageRevision, "full snapshots publish component damage revision");
  assert.strictEqual(compactRelay.ownerId, "red-1", "compact snapshots publish the new relay owner");
  assert.strictEqual(compactRelay.team, "red", "compact snapshots publish the new relay team");
  assert.strictEqual(compactRelay.state, "recovering", "compact snapshots publish recovery state");
  assert.strictEqual(compactRelay.shield, 0, "compact snapshots publish the recovery shield state");
  assert.strictEqual(compactRelay.healthRevision, relay.healthRevision, "compact snapshots publish health revision");
  assert.strictEqual(compactRelay.stateRevision, relay.stateRevision, "compact snapshots publish state revision");
  assert.strictEqual(compactRelay.captureRevision, relay.captureRevision, "compact snapshots publish capture revision");
  assert.strictEqual(compactRelay.componentDamageRevision, relay.componentDamageRevision, "compact snapshots publish component damage revision");
  const delta = buildEntityDeltaSnapshot(transferCompact, beforeState).snapshot;
  const deltaState = delta.stationsPatch.dynamic.find((station) => station.id === relay.id);
  assert(deltaState, "entity-delta snapshots carry the relay transfer state");
  assert.strictEqual(deltaState.ownerId, "red-1", "entity delta carries the new owner");
  assert.strictEqual(deltaState.team, "red", "entity delta carries the new team");
  assert.strictEqual(deltaState.state, "recovering", "entity delta carries recovery state");
  assert.strictEqual(deltaState.captureRevision, relay.captureRevision, "entity delta carries capture revision");
  assert.strictEqual(deltaState.componentDamageRevision, relay.componentDamageRevision, "entity delta carries component damage revision");

  const redRecoveryHp = relay.hp;
  damageStation(room, relay, 25, "blue-1", 40, relay.x + 500, relay.y);
  assert(relay.hp < redRecoveryHp, "the former owner can damage a recovering relay");
  assert.strictEqual(relay.state, "recovering", "damage during recovery does not reactivate the relay");

  const blueCapturesBefore = room.players.get("blue-1").captures;
  damageStation(room, relay, relay.hp * 3, "blue-1", 50, relay.x - 500, relay.y);
  assert.strictEqual(relay.ownerId, "blue-1", "a hostile recapture during recovery transfers to the new attacker");
  assert.strictEqual(relay.team, "blue", "a hostile recapture during recovery transfers team");
  assert.strictEqual(relay.state, "recovering", "recapture restarts recovery");
  assert.strictEqual(relay.alive, true, "recapture keeps the relay alive");
  assert(Math.abs(relay.hp - relay.maxHp * restoreRatio) < 0.001, "recapture restores the configured hull ratio");
  assert(Math.abs(relay.hp - componentSum(relay)) < 0.001, "recapture keeps aggregate and component HP equal");
  assert.strictEqual(room.players.get("blue-1").captures, blueCapturesBefore + 1, "recapture awards one capture");

  const sameTeamHp = relay.hp;
  damageStation(room, relay, 10, "blue-2", 60, relay.x + 500, relay.y);
  assert(relay.hp < sameTeamHp, "same-team damage can affect the relay hull");
  assert.strictEqual(relay.ownerId, "blue-1", "same-team damage does not change ownership");
  assert.strictEqual(relay.state, "recovering", "same-team damage does not reset recovery");

  const recoveryDamage = relay.maxHp * 0.2;
  damageStation(room, relay, recoveryDamage, "blue-2", 70, relay.x + 500, relay.y);
  const damagedComponents = relay.componentHp.slice();
  const revisionBeforeRepair = relay.healthRevision;
  updateStations(room, 1, 1000);
  assert(
    relay.componentHp.some((hp, index) => hp > damagedComponents[index]),
    "recovery repairs component HP in stable index order"
  );
  assert(Math.abs(relay.hp - componentSum(relay)) < 0.001, "component repair keeps aggregate HP exact");
  assert(relay.healthRevision > revisionBeforeRepair, "component repair advances health revision");
  assert(relay.state === "recovering" || relay.state === "operational", "recovery remains a valid relay state while healing");

  for (let tick = 0; relay.state === "recovering" && tick < 300; tick += 1) {
    updateStations(room, 1, 1001 + tick * 1000);
  }
  assert.strictEqual(relay.state, "operational", `relay becomes operational at the configured ${recoveryRatio} recovery threshold`);
  assert(relay.hp >= relay.maxHp * recoveryRatio, "operational recovery meets the configured threshold");
  assert(effectiveSensorRange(relay, room) > 0, "operational relays restore their sensor contribution");

  const homeRoom = makeRoom("HOME-DESTRUCTION").room;
  const home = homeRoom.stations.find((station) => station.stationType === "home" && station.team === "blue");
  home.shield = 0;
  damageStation(homeRoom, home, home.maxHp * 3, "red-1", 2000, home.x + 500, home.y);
  assert.strictEqual(home.state, "destroyed", "zero-hull home stations remain destroyed");
  assert.strictEqual(home.alive, false, "zero-hull home stations become non-live");
  assert.strictEqual(home.team, "blue", "home stations retain their original team");
  assert.strictEqual(home.ownerId, null, "home stations do not transfer player ownership");
  assert.strictEqual(homeRoom.phase, "ended", "home-station destruction ends the match");
  assert.strictEqual(homeRoom.winner.team, "red", "home-station destruction awards victory to the opposing team");
  assert.strictEqual(homeRoom.winner.reason, "home-base-destroyed", "home destruction uses the existing victory reason");

  return import("./public/src/game/pixi/pixiStations.js").then(({ stationStateLabel, stationColor }) => {
    assert.strictEqual(stationStateLabel({ stationType: "relay", state: "recovering" }), "RECOVERING", "client displays RECOVERING");
    assert.strictEqual(stationColor({ stationType: "relay", state: "recovering", team: "red", ownerId: "red-1" }, new Map()), "#ff5f7e", "client changes relay colour immediately");
    console.log("  relay transfer, recovery, recapture, snapshots and home destruction checks passed");
  });
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
