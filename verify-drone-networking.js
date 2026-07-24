#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { encodeMessage, decodeBinary } = require("./src/server/wsCodec");
const { validateClientMessage } = require("./src/server/clientSchemas");
const { getRoute } = require("./src/server/routeRegistry");
const { snapshotRoom } = require("./src/server/snapshots");
const {
  CONFIG,
  buildDroneSnapshots,
  buildBaySnapshots,
  setDroneBayMode
} = require("./src/server/drones");

const ship = {
  id: "carrier", ownerId: "owner", alive: true, x: 20, y: 30, angle: 0,
  design: [{ x: 5, y: 6, type: "droneBay", droneType: "fighter" }],
  componentHp: [100],
  droneBays: [{
    componentIndex: 0, componentId: "drone-bay:5,6", droneType: "fighter", mode: "deployed",
    launchEdge: { centerX: 5.5, centerY: 5.25, dx: 0, dy: -1 },
    slots: [
      { slot: 0, state: "active", droneId: "d1", productionProgress: 1, pauseReason: null },
      { slot: 1, state: "producing", droneId: null, productionProgress: 0.46, pauseReason: "insufficient-power" },
      { slot: 2, state: "ready", droneId: null, productionProgress: 1, pauseReason: null }
    ]
  }]
};
const drone = {
  id: "d1", ownerId: "owner", parentShipId: "carrier", bayComponentId: "drone-bay:5,6",
  type: "fighter", state: "active", x: 50.123, y: 60.456, vx: 1.2, vy: -3.4,
  angle: 0.5, hull: 41.2, maxHull: 45, targetId: "enemy"
};
const room = { ships: new Map([[ship.id, ship]]), drones: new Map([[drone.id, drone]]) };

const first = {
  type: "snapshot",
  ships: [{ id: ship.id, droneBays: buildBaySnapshots(ship) }],
  drones: buildDroneSnapshots(room, 1000)
};
const decoded = decodeBinary(encodeMessage(first));
assert.deepEqual(decoded, first, "Drone and bay state is MessagePack compatible");
assert.equal(decoded.drones[0].parentShipId, ship.id);
assert.equal(decoded.drones[0].bayComponentId, ship.droneBays[0].componentId);
assert.equal(decoded.ships[0].droneBays[0].productionProgress, 0.46);
assert.equal(decoded.ships[0].droneBays[0].productionPausedReason, "insufficient-power");
assert.equal(decoded.ships[0].droneBays[0].commandRange, CONFIG.types.fighter.commandRange, "bay snapshots expose the authoritative drone operating radius");
assert.ok(CONFIG.types.fighter.commandRange > CONFIG.types.repair.commandRange);
assert.ok(CONFIG.types.repair.commandRange > CONFIG.types.defence.commandRange);

const reconnect = decodeBinary(encodeMessage({
  type: "snapshot",
  ships: [{ id: ship.id, droneBays: buildBaySnapshots(ship) }],
  drones: buildDroneSnapshots(room, 1200)
}));
assert.equal(reconnect.drones.length, 1, "mid-match reconnect receives one existing entity");
assert.equal(reconnect.drones[0].id, decoded.drones[0].id, "reconnect keeps stable drone IDs");
assert.equal(reconnect.ships[0].droneBays[0].productionProgress, 0.46, "reconnect does not reset production");
assert.equal(room.drones.size, 1, "snapshot generation never spawns or duplicates drones");

const player = {
  id: "owner", name: "Owner", team: "blue", ships: [ship], connected: true,
  ready: true, shipCap: 3, score: 0, kills: 0, losses: 0, captures: 0,
  deployedFleetCost: 0, destroyedEnemyCost: 0, shipsBuilt: 1, lostFleetCost: 0
};
const networkRoom = {
  code: "DRONE", phase: "active", adminId: player.id,
  stateEpoch: 1, snapshotSeq: 1, staticRevision: 1, componentCatalogueRevision: 1,
  players: new Map([[player.id, player]]), ships: room.ships, rules: { gameMode: "teams" },
  points: [], winner: null, controlVictory: null
};
const shared = {
  ships: [{
    id: ship.id, ownerId: ship.ownerId, alive: true, designRevision: 1,
    droneBays: buildBaySnapshots(ship)
  }],
  drones: buildDroneSnapshots(room, 1300),
  bullets: [], points: [], effects: [], objectiveControl: { total: 0, neutral: 0, contested: 0, teams: {}, players: {} }
};
const finalPacket = snapshotRoom(networkRoom, 1300, null, false, shared, {
  knownShipDesignRevisions: new Map([[ship.id, 1]])
});
assert.equal(finalPacket.drones.length, 1, "the final authoritative state packet includes created drones");
assert.equal(finalPacket.drones[0].id, drone.id, "the final packet preserves the created drone identity");
assert.equal(finalPacket.ships[0].droneBays[0].productionProgress, 0.46, "the final packet includes live bay production progress");

assert.equal(validateClientMessage({
  type: "setDroneBayMode", shipId: ship.id, componentId: ship.droneBays[0].componentId, mode: "recalled"
}).ok, true);
assert.equal(getRoute("setDroneBayMode").phases.includes("active"), true);
assert.equal(validateClientMessage({ type: "spawnDrone", shipId: ship.id }).ok, false, "forged spawn messages are rejected");
assert.equal(validateClientMessage({
  type: "setDroneBayMode", shipId: ship.id, componentId: ship.droneBays[0].componentId, mode: "fighter"
}).ok, false, "combat cannot change a bay's fixed drone type");

assert.equal(setDroneBayMode(room, { id: "intruder" }, ship.id, ship.droneBays[0].componentId, "recalled"), false);
assert.equal(ship.droneBays[0].mode, "deployed");
assert.equal(setDroneBayMode(room, { id: "owner" }, ship.id, ship.droneBays[0].componentId, "recalled"), true);
assert.equal(ship.droneBays[0].mode, "recalled");
assert.equal(room.drones.size, 1, "permitted parent command never creates a client-authoritative drone");

console.log("Drone networking and reconnect verification passed");
