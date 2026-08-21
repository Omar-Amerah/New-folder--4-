#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { BALANCE } = require("../src/server/balanceConfig");
const { PARTS } = require("../src/server/components");
const {
  CONFIG,
  initializeDroneBays,
  bayPowerRequest,
  bayWorldPose,
  buildBaySnapshots,
  updateDroneBays,
  _test: { advanceBayProduction, spawnDrone }
} = require("../src/server/drones");

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

for (const [power, label] of [[0.5, "50%"], [0.05, "5%"], [0.01, "1%"]]) {
  const positive = makeRoomAndShip();
  positive.ship.componentPower = { byComponentIndex: [{ operationalMultiplier: power }] };
  updateDroneBays(positive.room, [positive.ship], 0.05, 0);
  assert.equal(positive.room.drones.size, 1, `${label} Bay Power still permits launch`);
}

const destroyedLaunch = makeRoomAndShip();
destroyedLaunch.ship.componentHp[0] = 0;
assert.equal(
  spawnDrone(destroyedLaunch.room, destroyedLaunch.ship, destroyedLaunch.bay, destroyedLaunch.bay.slots[0], 0),
  null,
  "the authoritative spawn path rejects a destroyed Drone Bay"
);

const spawnCase = makeRoomAndShip();
spawnCase.room.map.safeZones = [{
  id: "spawn-blue",
  x: spawnCase.ship.x,
  y: spawnCase.ship.y,
  radius: 100,
  isSpawn: true,
  team: "blue"
}];
updateDroneBays(spawnCase.room, [spawnCase.ship], 0.05, 0);
assert.equal(spawnCase.room.drones.size, 0, "drones do not launch while their carrier is in its spawn zone");
spawnCase.ship.x += 200;
updateDroneBays(spawnCase.room, [spawnCase.ship], 0.05, 100);
assert.equal(spawnCase.room.drones.size, 1, "drones can launch after their carrier leaves spawn");
spawnCase.ship.x -= 200;
updateDroneBays(spawnCase.room, [spawnCase.ship], 0.05, 200);
assert.equal(spawnCase.room.drones.size, 0, "deployed drones are destroyed when their carrier re-enters spawn");
assert.equal(spawnCase.bay.slots[0].state, "destroyed", "spawn-zone destruction opens the bay slot for rebuilding");

const fuelCase = makeRoomAndShip();
updateDroneBays(fuelCase.room, [fuelCase.ship], 0.05, 0);
const fueledDrone = [...fuelCase.room.drones.values()][0];
fuelCase.bay.nextLaunchAt = Infinity;
fueledDrone.state = "active";
fuelCase.bay.slots[0].state = "active";
fueledDrone.fuelRemainingSeconds = 0.05;
updateDroneBays(fuelCase.room, [fuelCase.ship], 0.10, 100);
assert.equal(fueledDrone.state, "returning", "a drone returns to its carrier when its 15-second fuel supply expires");
assert.equal(fueledDrone.returnReason, "fuel");
const fuelPose = bayWorldPose(fuelCase.ship, fuelCase.bay);
fueledDrone.x = fuelPose.x;
fueledDrone.y = fuelPose.y;
updateDroneBays(fuelCase.room, [fuelCase.ship], 0.01, 200);
assert.equal(fueledDrone.state, "refueling", "a returned drone docks to refuel");
updateDroneBays(fuelCase.room, [fuelCase.ship], 1.99, 2199);
assert.equal(fueledDrone.state, "refueling", "the drone remains docked for the full two seconds");
updateDroneBays(fuelCase.room, [fuelCase.ship], 0.01, 2200);
assert.equal(fueledDrone.state, "launching", "the drone relaunches after two seconds of refueling");
assert.equal(fueledDrone.fuelRemainingSeconds, CONFIG.types.fighter.fuelSeconds, "refueling restores the selected drone type's full fuel supply");

const destroyedDock = makeRoomAndShip();
updateDroneBays(destroyedDock.room, [destroyedDock.ship], 0.05, 0);
const orphanedDrone = [...destroyedDock.room.drones.values()][0];
const destroyedPose = bayWorldPose(destroyedDock.ship, destroyedDock.bay);
destroyedDock.bay.nextLaunchAt = Infinity;
orphanedDrone.state = "returning";
orphanedDrone.returnReason = "fuel";
orphanedDrone.x = destroyedPose.x;
orphanedDrone.y = destroyedPose.y;
orphanedDrone.vx = 0;
orphanedDrone.vy = 0;
destroyedDock.bay.slots[0].state = "returning";
destroyedDock.ship.componentHp[0] = 0;
const orphanedAt = 1000;
updateDroneBays(destroyedDock.room, [destroyedDock.ship], 0.01, orphanedAt);
assert.equal(orphanedDrone.state, "orphaned", "destroying a Drone Bay orphans its deployed drones");
assert.equal(destroyedDock.bay.slots[0].state, "orphaned", "the destroyed Bay no longer presents the drone as dockable");
assert.equal(orphanedDrone.refuelStartedAt, null, "a returning drone touching a destroyed Bay cannot dock");
assert.equal(destroyedDock.room.drones.has(orphanedDrone.id), true, "the configured orphan lifetime is not skipped");
updateDroneBays(
  destroyedDock.room,
  [destroyedDock.ship],
  0.01,
  orphanedAt + CONFIG.orphanLifetimeSeconds * 1000 - 1
);
assert.equal(destroyedDock.room.drones.has(orphanedDrone.id), true, "an orphan survives until the configured lifetime elapses");
updateDroneBays(
  destroyedDock.room,
  [destroyedDock.ship],
  0.01,
  orphanedAt + CONFIG.orphanLifetimeSeconds * 1000
);
assert.equal(destroyedDock.room.drones.has(orphanedDrone.id), false, "a destroyed Bay's orphan dies at the configured lifetime");
assert.equal(destroyedDock.bay.slots[0].state, "destroyed", "the expired orphan leaves an empty replacement slot");

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
const tinyPowerProgress = slowedProgress + 2 * 0.01 / CONFIG.types.fighter.productionSeconds;
assert.equal(queue.slots[0].pauseReason, "low-power", "any positive Power remains operational");
assert.equal(queue.slots[0].productionProgress, tinyPowerProgress, "positive low Power advances production linearly");
advanceBayProduction(queue, 2, 0, false);
assert.equal(queue.slots[0].pauseReason, "insufficient-power", "exact zero Power pauses production");
assert.equal(queue.slots[0].productionProgress, tinyPowerProgress, "zero-Power interruption retains progress");
advanceBayProduction(queue, 2, 1, true);
assert.equal(queue.slots[0].pauseReason, "bay-overheated");
assert.equal(queue.slots[0].productionProgress, tinyPowerProgress, "overheat interruption retains progress");
advanceBayProduction(queue, 9, 1, false);
assert.equal(queue.slots[0].state, "ready", "production resumes to completion");
assert.equal(queue.slots[1].state, "destroyed", "second empty slot waits for a later production cycle");

const disabled = makeRoomAndShip();
disabled.bay.slots[0] = { slot: 0, state: "producing", droneId: null, productionProgress: 0.4, pauseReason: null };
disabled.ship.componentHp[0] = 0;
updateDroneBays(disabled.room, [disabled.ship], 10, 1000);
assert.equal(disabled.bay.slots[0].state, "destroyed", "Bay destruction cancels the active production state");
assert.equal(disabled.bay.slots[0].productionProgress, 0.4, "Bay destruction does not advance production");
assert.equal(disabled.bay.slots[0].pauseReason, "bay-destroyed");
const disabledSnapshot = buildBaySnapshots(disabled.ship)[0];
assert.equal(disabledSnapshot.producingSlot, null, "a destroyed Bay snapshot exposes no production job");
assert.equal(disabledSnapshot.productionProgress, null, "a destroyed Bay snapshot exposes no production progress bar");
assert.equal(disabledSnapshot.slots.some((slot) => slot.state === "producing"), false);

const independentA = makeRoomAndShip("fighter").bay;
const independentB = makeRoomAndShip("repair").bay;
for (const independent of [independentA, independentB]) {
  independent.slots[0] = { slot: 0, state: "destroyed", droneId: null, productionProgress: 0, pauseReason: null };
}
advanceBayProduction(independentA, 1, 1, false);
advanceBayProduction(independentB, 2, 1, false);
assert.equal(independentA.slots[0].productionProgress, 1 / CONFIG.types.fighter.productionSeconds);
assert.equal(independentB.slots[0].productionProgress, 2 / CONFIG.types.repair.productionSeconds);

assert.equal(PARTS.droneBay.activityHeat, 1.2, "Drone Bay Heat uses the authored component activityHeat");
assert.equal(Object.hasOwn(CONFIG, "standbyHeatPerSecond"), false, "standby Heat is not a separate Drone Bay balance mode");
assert.equal(Object.hasOwn(CONFIG, "activeHeatPerSecond"), false, "active Heat is not a separate Drone Bay balance mode");
assert.equal(Object.hasOwn(CONFIG, "productionHeatPerSecond"), false, "production Heat is not a separate Drone Bay balance mode");

const idle = makeRoomAndShip();
idle.bay.mode = "recalled";
updateDroneBays(idle.room, [idle.ship], 1, 0);
assert.equal(idle.ship.componentHeatInput[0], 0, "a merely idle Drone Bay generates no Heat");

const active = makeRoomAndShip();
active.bay.mode = "recalled";
active.bay.slots[0].state = "active";
active.bay.slots[0].productionProgress = 1;
active.ship.componentPower = { byComponentIndex: [{ operationalMultiplier: 0.5 }] };
updateDroneBays(active.room, [active.ship], 2, 0);
assert.equal(active.ship.componentHeatInput[0], PARTS.droneBay.activityHeat * 0.5 * 2,
  "active Drone Bay Heat uses authored activityHeat and delivered Power");

const producing = makeRoomAndShip();
producing.bay.slots[0] = { slot: 0, state: "destroyed", droneId: null, productionProgress: 0, pauseReason: null };
producing.ship.componentPower = { byComponentIndex: [{ operationalMultiplier: 0.25 }] };
updateDroneBays(producing.room, [producing.ship], 2, 0);
assert.equal(producing.ship.componentHeatInput[0], PARTS.droneBay.activityHeat * 0.25 * 2,
  "production Drone Bay Heat uses the same authored activityHeat rate");
assert.equal(CONFIG.fuelSeconds, 15);
assert.equal(CONFIG.refuelSeconds, 2);
assert.equal(CONFIG.standbyPowerMw, 3);
assert.equal(CONFIG.activePowerMw, 7);
assert.equal(CONFIG.productionPowerMw, 11);

console.log("Drone production, Power, and Heat verification passed");
