#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { BALANCE } = require("./src/server/balanceConfig");
const { PARTS } = require("./src/server/components");
const {
  CONFIG,
  initializeDroneBays,
  bayPowerRequest,
  updateDroneBays,
  _test: { advanceBayProduction }
} = require("./src/server/drones");

function makeRoomAndShip(type = "fighter") {
  const ship = {
    id: "carrier", ownerId: "owner", team: "blue", alive: true,
    x: 500, y: 400, vx: 0, vy: 0, angle: 0, focusTargetId: null,
    design: [{ x: 5, y: 6, type: "droneBay", rotation: 0, droneType: type }],
    componentHp: [PARTS.droneBay.hp], componentHeatState: [0], componentHeatInput: [0]
  };
  const room = {
    drones: new Map(), ships: new Map([["carrier", ship]]),
    players: new Map([["owner", { id: "owner", team: "blue" }]]),
    effects: [], bullets: [], map: { asteroids: [] }, rules: { gameMode: "teams" }, nextEntityId: 1
  };
  initializeDroneBays(room, ship, 0);
  return { room, ship, bay: ship.droneBays[0] };
}

assert.equal(CONFIG, BALANCE.drones, "production code reads the authoritative balance object");
const { room, ship, bay } = makeRoomAndShip();
assert.equal(bay.slots.length, 3);
assert.deepEqual(bay.slots.map((slot) => slot.state), ["ready", "ready", "ready"]);
bay.mode = "recalled";
assert.equal(bayPowerRequest(ship, 0), CONFIG.standbyPowerMw);
bay.mode = "deployed";
assert.equal(bayPowerRequest(ship, 0), CONFIG.activePowerMw, "an imminent launch reserves active Power before spawning");

updateDroneBays(room, [ship], 0.05, 0);
assert.equal(room.drones.size, 1, "first initial drone launches immediately");
assert.equal(bayPowerRequest(ship, 0), CONFIG.activePowerMw);
updateDroneBays(room, [ship], 0.30, 300);
assert.equal(room.drones.size, 1, "launch interval prevents same-frame squad spawning");
updateDroneBays(room, [ship], 0.40, 700);
assert.equal(room.drones.size, 2, "second drone launches after the authoritative interval");
updateDroneBays(room, [ship], 0.70, 1400);
assert.equal(room.drones.size, 3, "third drone launches sequentially");
updateDroneBays(room, [ship], 0.70, 2200);
assert.equal(room.drones.size, 3, "a bay never exceeds three drones");

const queue = makeRoomAndShip("fighter").bay;
queue.slots[0] = { slot: 0, state: "destroyed", droneId: null, productionProgress: 0, pauseReason: null };
queue.slots[1] = { slot: 1, state: "destroyed", droneId: null, productionProgress: 0, pauseReason: null };
assert.equal(bayPowerRequest({ componentHp: [1], droneBays: [queue] }, 0), CONFIG.productionPowerMw, "empty slot immediately requests production Power");
advanceBayProduction(queue, 3, 1, false);
assert.equal(queue.slots.filter((slot) => slot.state === "producing").length, 1, "only one slot produces at a time");
assert.equal(queue.slots[0].productionProgress, 3 / CONFIG.types.fighter.productionSeconds);
const savedProgress = queue.slots[0].productionProgress;
advanceBayProduction(queue, 2, 0.5, false);
assert.equal(queue.slots[0].pauseReason, "low-power");
const slowedProgress = savedProgress + 2 * 0.5 / CONFIG.types.fighter.productionSeconds;
assert.equal(queue.slots[0].productionProgress, slowedProgress, "underpowered bays build slowly instead of stalling");
advanceBayProduction(queue, 2, 0.01, false);
assert.equal(queue.slots[0].pauseReason, "insufficient-power", "an essentially unpowered bay still stalls");
assert.equal(queue.slots[0].productionProgress, slowedProgress, "no-power interruption retains progress");
advanceBayProduction(queue, 2, 1, true);
assert.equal(queue.slots[0].pauseReason, "bay-overheated");
assert.equal(queue.slots[0].productionProgress, slowedProgress, "overheat interruption retains progress");
advanceBayProduction(queue, 9, 1, false);
assert.equal(queue.slots[0].state, "ready", "production resumes to completion");
assert.equal(queue.slots[1].state, "destroyed", "second empty slot waits for a later production cycle");

const disabled = makeRoomAndShip().bay;
disabled.slots[0] = { slot: 0, state: "producing", droneId: null, productionProgress: 0.4, pauseReason: null };
advanceBayProduction(disabled, 10, 1, false, false);
assert.equal(disabled.slots[0].productionProgress, 0.4);
assert.equal(disabled.slots[0].pauseReason, "bay-destroyed");

const independentA = makeRoomAndShip("fighter").bay;
const independentB = makeRoomAndShip("repair").bay;
for (const independent of [independentA, independentB]) {
  independent.slots[0] = { slot: 0, state: "destroyed", droneId: null, productionProgress: 0, pauseReason: null };
}
advanceBayProduction(independentA, 1, 1, false);
advanceBayProduction(independentB, 2, 1, false);
assert.equal(independentA.slots[0].productionProgress, 1 / CONFIG.types.fighter.productionSeconds);
assert.equal(independentB.slots[0].productionProgress, 2 / CONFIG.types.repair.productionSeconds);

assert.equal(PARTS.droneBay.activityHeat, CONFIG.activeHeatPerSecond);
assert.equal(CONFIG.standbyHeatPerSecond, 0.5);
assert.equal(CONFIG.activeHeatPerSecond, 1.2);
assert.equal(CONFIG.productionHeatPerSecond, 3);
assert.equal(CONFIG.standbyPowerMw, 3);
assert.equal(CONFIG.activePowerMw, 7);
assert.equal(CONFIG.productionPowerMw, 11);

console.log("Drone production, Power, and Heat verification passed");
