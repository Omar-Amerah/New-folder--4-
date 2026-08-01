#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const Flags = require("./src/server/performanceFlags");
const RoomTelemetry = require("./src/server/roomTelemetry");
const Drones = require("./src/server/drones");
const { updateBullets } = require("./src/server/projectiles");
const { buildRoomSpatialIndex } = require("./src/server/spatialIndex");

function makeShip(id, ownerId, team, x, y, bayId = `${id}:bay`) {
  return {
    id,
    ownerId,
    team,
    alive: true,
    x,
    y,
    angle: 0,
    focusTargetId: null,
    commandState: "deployed",
    componentHp: [100],
    componentMaxHp: [100],
    componentPower: { byComponentIndex: [{ operationalMultiplier: 1 }] },
    componentHeatState: [0],
    design: [{ x: 5, y: 6, type: "droneBay", droneType: "fighter" }],
    droneBays: [{
      componentIndex: 0,
      componentId: bayId,
      droneType: "fighter",
      mode: "deployed",
      _modeRevision: 0,
      nextLaunchAt: Infinity,
      launchBlockedBySpawn: false,
      launchEdge: { centerX: 5.5, centerY: 5.25, dx: 0, dy: -1 },
      slots: [
        { slot: 0, state: "active", droneId: null, productionProgress: 1, pauseReason: null },
        { slot: 1, state: "active", droneId: null, productionProgress: 1, pauseReason: null }
      ]
    }]
  };
}

function makeDrone(id, parent, bayId, x, y, sequence) {
  return {
    id,
    ownerId: parent.ownerId,
    ownerPlayerId: parent.ownerId,
    teamId: parent.team,
    parentShipId: parent.id,
    bayComponentId: bayId,
    bayComponentIndex: 0,
    slot: sequence,
    squadIndex: sequence,
    type: "fighter",
    droneType: "fighter",
    x,
    y,
    vx: 0,
    vy: 0,
    angle: 0,
    radius: 10,
    hull: 45,
    maxHull: 45,
    state: "active",
    commandState: "deployed",
    fuelRemainingSeconds: 20,
    nextDecisionAt: 0,
    nextThinkAt: 0,
    nextActionAt: Infinity,
    targetId: null,
    authoritativeSequence: sequence,
    removed: false,
    destroyed: false
  };
}

function makeRoom() {
  const blue = { id: "blue", team: "a" };
  const red = { id: "red", team: "b" };
  const parent = makeShip("carrier", "blue", "a", 500, 500);
  const enemy = makeShip("enemy", "red", "b", 700, 500, "enemy:bay");
  enemy.droneBays = [];
  parent.focusTargetId = enemy.id;
  const bay = parent.droneBays[0];
  const first = makeDrone("d1", parent, bay.componentId, 530, 500, 1);
  const second = makeDrone("d2", parent, bay.componentId, 535, 505, 2);
  bay.slots[0].droneId = first.id;
  bay.slots[1].droneId = second.id;
  return {
    stateEpoch: 1,
    _simulationStep: 1,
    phase: "active",
    nextEntityId: 100,
    players: new Map([[blue.id, blue], [red.id, red]]),
    ships: new Map([[parent.id, parent], [enemy.id, enemy]]),
    drones: new Map([[first.id, first], [second.id, second]]),
    bullets: [],
    projectileById: new Map(),
    _projectileLookupInitialized: true,
    effects: [],
    stations: [],
    map: { asteroids: [], safeZones: [] },
    rules: { gameMode: "teams" },
    world: { width: 4000, height: 3000 }
  };
}

function makeProjectileRoom() {
  const room = {
    stateEpoch: 1,
    _simulationStep: 20,
    phase: "active",
    nextEntityId: 1,
    players: new Map([
      ["blue", { id: "blue", team: "a" }],
      ["red", { id: "red", team: "b" }]
    ]),
    ships: new Map(),
    drones: new Map(),
    bullets: [],
    projectileById: new Map(),
    _projectileLookupInitialized: true,
    effects: [],
    stations: [],
    map: { asteroids: [], safeZones: [] },
    rules: { gameMode: "teams" },
    world: { width: 4000, height: 3000 }
  };
  const drone = {
    id: "target-drone",
    ownerId: "red",
    x: 500,
    y: 400,
    vx: 0,
    vy: 0,
    radius: 10,
    hull: 50,
    maxHull: 50,
    destroyed: false,
    removed: false
  };
  room.drones.set(drone.id, drone);
  return { room, drone };
}

function addProjectile(room, id, x, y, vx, ownerId = "blue") {
  const projectile = { id, type: "bolt", ownerId, x, y, vx, vy: 0, damage: 10, life: 2 };
  room.bullets.push(projectile);
  room.projectileById.set(id, projectile);
  return projectile;
}

assert.equal(Flags.OPTIMIZED_DRONE_RUNTIME(), false, "Phase 6B is disabled by default");
assert.deepEqual(Drones.DRONE_DECISION_INTERVALS_MS, { defence: 120, fighter: 180, repair: 250 });

{
  const room = makeRoom();
  const parent = room.ships.get("carrier");
  const bay = parent.droneBays[0];
  RoomTelemetry.resetRoomTelemetry(room);
  const first = Drones._test.buildBayFrameState(room, parent, bay, 12, 1000, false);
  const second = Drones._test.buildBayFrameState(room, parent, bay, 12, 1000, false);
  assert.strictEqual(first, second, "Bay frame state is reused within one simulation frame");
  assert.equal(room._roomTelemetry.droneBayFrameBuilds, 1);
  assert.equal(room._roomTelemetry.droneBayFrameHits, 1);
  assert.ok(Number.isFinite(first.worldX) && Number.isFinite(first.normalY));
}

{
  const room = makeRoom();
  const ships = [...room.ships.values()];
  buildRoomSpatialIndex(room, ships, 1000);
  RoomTelemetry.resetRoomTelemetry(room);
  Flags.__setOPTIMIZED_DRONE_RUNTIME(true);
  Drones.updateDroneBays(room, ships, 1 / 30, 1000);
  const runtime = room._droneDecisionRuntime;
  assert.ok(runtime && runtime.contexts.size === 1, "two drones from one Bay share one decision context");
  assert.ok(room._roomTelemetry.droneContextsBuilt >= 1);
  assert.ok(room._roomTelemetry.droneContextHits >= 1);
  assert.equal(room._roomTelemetry.droneContextShipQueries, 1);
  assert.equal(room._roomTelemetry.droneContextDroneQueries, 1);
  assert.equal(room._roomTelemetry.droneContextProjectileQueries, 1);
  const first = room.drones.get("d1");
  assert.equal(first._targetRuntime.entity.id, "enemy", "context candidates preserve per-drone focus selection");
  const retained = first._targetRuntime.entity;
  room._simulationStep = 2;
  Drones.updateDroneBays(room, ships, 1 / 30, 1010);
  assert.strictEqual(first._targetRuntime.entity, retained, "valid target references are retained between decisions");
  assert.ok(room._roomTelemetry.droneTargetReferenceHits > 0);

  const oldTarget = first._targetRuntime.entity;
  room.ships.delete(oldTarget.id);
  oldTarget.alive = false;
  room._simulationStep = 3;
  Drones.updateDroneBays(room, ships, 1 / 30, 1020);
  assert.equal(first.targetId, null, "destroyed targets trigger immediate reacquisition");
  assert.ok(first.decisionInvalidated === false, "immediate reacquisition completes in the same authoritative update");

  const replacement = { ...oldTarget, alive: true, x: 710, y: 500 };
  room.ships.set(replacement.id, replacement);
  room.stateEpoch = 2;
  Drones._test.rememberDroneTarget(room, first, oldTarget);
  Drones._test.rememberDroneTarget(room, first, replacement);
  assert.strictEqual(Drones._test.resolveCachedDroneTarget(room, first, 1030), replacement, "epoch changes cannot retain an old object reference");
  Flags.__setOPTIMIZED_DRONE_RUNTIME(false);
}

{
  const { room, drone } = makeProjectileRoom();
  buildRoomSpatialIndex(room, [], 2000);
  RoomTelemetry.resetRoomTelemetry(room);
  addProjectile(room, "fast-crossing", 300, 400, 1200);
  updateBullets(room, 0.4, 2000);
  assert.equal(drone.hull, 40, "indexed high-speed projectile crossing still hits a drone");
  assert.equal(room._roomTelemetry.projectileDroneFullScanFallbacks, 0, "normal indexed projectile processing performs no full drone scans");
  assert.ok(room._roomTelemetry.projectileDroneQueries > 0);

  room.spatialIndex.invalidateDynamic();
  room._simulationStep = 21;
  addProjectile(room, "recovery-shot", 300, 700, 20);
  updateBullets(room, 0.01, 2010);
  const recoveries = room._roomTelemetry.projectileDroneIndexRecoveryBuilds;
  updateBullets(room, 0.01, 2010);
  assert.equal(room._roomTelemetry.projectileDroneIndexRecoveryBuilds, recoveries, "one invalid-index recovery is allowed per authoritative step");

  room.disableSpatialIndex = true;
  addProjectile(room, "diagnostic-no-index", 300, 700, 20);
  updateBullets(room, 0.01, 2020);
  assert.ok(room._roomTelemetry.projectileDroneFullScanFallbacks > 0, "explicit no-index fixture is labelled as a diagnostic fallback");
}

Flags.__setOPTIMIZED_DRONE_RUNTIME(false);
console.log("Phase 6B drone runtime verification passed");
