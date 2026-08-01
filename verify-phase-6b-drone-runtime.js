#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const Flags = require("./src/server/performanceFlags");
const RoomTelemetry = require("./src/server/roomTelemetry");
const Drones = require("./src/server/drones");
const DroneDecisionContext = require("./src/server/droneDecisionContext");
const { updateBullets } = require("./src/server/projectiles");
const { buildRoomSpatialIndex } = require("./src/server/spatialIndex");
const HeatRules = require("./public/src/shared/heatRules");
const { repairShipComponents } = require("./src/server/componentHealth");

function makeShip(id, ownerId, team, x, y, bayId = `${id}:bay`, droneType = "fighter") {
  return {
    id,
    ownerId,
    team,
    alive: true,
    x,
    y,
    angle: 0,
    radius: 24,
    hp: 1000,
    maxHp: 1000,
    shield: 0,
    maxShield: 0,
    stats: { frontDamageReduction: 0 },
    focusTargetId: null,
    commandState: "deployed",
    componentHp: [100],
    componentMaxHp: [100],
    componentAliveRevision: 1,
    componentDamageRevision: 1,
    powerRevision: 1,
    heatStateRevision: 1,
    componentPower: { byComponentIndex: [{ operationalMultiplier: 1 }] },
    componentCellIndex: new Map(Array.from({ length: 15 * 15 }, (_, index) => [index, 0])),
    dirtyComponents: new Set(),
    componentHeatState: [0],
    design: [{ x: 5, y: 6, type: "droneBay", droneType }],
    droneBays: [{
      componentIndex: 0,
      componentId: bayId,
      droneType,
      mode: "deployed",
      _modeRevision: 0,
      nextLaunchAt: Infinity,
      launchBlockedBySpawn: false,
      launchEdge: { centerX: 5.5, centerY: 5.25, dx: 0, dy: -1 },
      slots: [
        { slot: 0, state: "active", droneId: null, productionProgress: 1, pauseReason: null },
        { slot: 1, state: "active", droneId: null, productionProgress: 1, pauseReason: null },
        { slot: 2, state: "active", droneId: null, productionProgress: 1, pauseReason: null },
        { slot: 3, state: "active", droneId: null, productionProgress: 1, pauseReason: null }
      ]
    }]
  };
}

function makeDrone(id, parent, bayId, x, y, sequence, type = "fighter") {
  return {
    id,
    ownerId: parent.ownerId,
    ownerPlayerId: parent.ownerId,
    teamId: parent.team,
    parentShipId: parent.id,
    bayComponentId: bayId,
    bayComponentIndex: 0,
    slot: Math.max(0, sequence - 1),
    squadIndex: sequence,
    type,
    droneType: type,
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
  const third = makeDrone("d3", parent, bay.componentId, 540, 510, 3);
  const fourth = makeDrone("d4", parent, bay.componentId, 545, 515, 4);
  bay.slots[0].droneId = first.id;
  bay.slots[1].droneId = second.id;
  bay.slots[2].droneId = third.id;
  bay.slots[3].droneId = fourth.id;
  return {
    stateEpoch: 1,
    _simulationStep: 1,
    phase: "active",
    nextEntityId: 100,
    players: new Map([[blue.id, blue], [red.id, red]]),
    ships: new Map([[parent.id, parent], [enemy.id, enemy]]),
    drones: new Map([[first.id, first], [second.id, second], [third.id, third], [fourth.id, fourth]]),
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

function prepareOptimizedRoom(room, now = 1000) {
  Flags.__setOPTIMIZED_DRONE_RUNTIME(true);
  Flags.__setINCREMENTAL_SPATIAL_INDEX(true);
  buildRoomSpatialIndex(room, [...room.ships.values()], now);
  return room;
}

function makeRoleRoom(type) {
  const room = makeRoom();
  const parent = room.ships.get("carrier");
  const enemy = room.ships.get("enemy");
  const bay = parent.droneBays[0];
  bay.droneType = type;
  parent.design[0].droneType = type;
  for (const drone of room.drones.values()) {
    drone.type = type;
    drone.droneType = type;
    drone.nextDecisionAt = 0;
    drone.nextThinkAt = 0;
    drone.nextActionAt = Infinity;
    drone._runtimeConfig = null;
  }
  if (type === "repair") {
    parent.componentHp[0] = 50;
    parent.componentMaxHp[0] = 100;
    parent.hp = 950;
    parent.maxHp = 1000;
    parent.focusTargetId = null;
  } else if (type === "defence") {
    parent.focusTargetId = null;
    const missile = {
      id: "hostile-missile",
      type: "missile",
      ownerId: enemy.ownerId,
      x: parent.x + 120,
      y: parent.y,
      vx: 0,
      vy: 0,
      life: 5,
      damage: 0,
      hp: 100,
      interceptable: true
    };
    room.bullets.push(missile);
    room.projectileById.set(missile.id, missile);
  } else {
    enemy.x = 700;
    enemy.y = 500;
    parent.focusTargetId = enemy.id;
  }
  return prepareOptimizedRoom(room);
}

function firstDrone(room) {
  return room.drones.get("d1");
}

function runOptimizedTick(room, now, dt = 1 / 30) {
  room._simulationStep = (Number(room._simulationStep) || 0) + 1;
  RoomTelemetry.resetRoomTelemetry(room);
  Drones.updateDroneBays(room, [...room.ships.values()], dt, now);
  return room._roomTelemetry;
}

function assertFiniteDrones(room, message) {
  for (const drone of room.drones.values()) {
    assert.ok([drone.x, drone.y, drone.vx, drone.vy, drone.hull, drone.fuelRemainingSeconds].every(Number.isFinite), `${message}: ${drone.id}`);
  }
}

assert.equal(Flags.OPTIMIZED_DRONE_RUNTIME(), false, "Phase 6B is disabled by default");
assert.deepEqual(Drones.DRONE_DECISION_INTERVALS_MS, { defence: 120, fighter: 180, repair: 250 });
Flags.__setINCREMENTAL_SPATIAL_INDEX(true);

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

  const oldLiveTarget = { ...oldTarget, alive: true, x: 710, y: 500 };
  room.ships.set(oldLiveTarget.id, oldLiveTarget);
  Drones._test.rememberDroneTarget(room, first, oldLiveTarget);
  const replacement = { ...oldLiveTarget, alive: true, x: 720, y: 500 };
  room.ships.set(replacement.id, replacement);
  room.stateEpoch = 2;
  assert.strictEqual(Drones._test.resolveCachedDroneTarget(room, first, 1030), replacement, "epoch changes cannot retain an old object reference");
  Flags.__setOPTIMIZED_DRONE_RUNTIME(false);
}

for (const [type, interval] of Object.entries(Drones.DRONE_DECISION_INTERVALS_MS)) {
  const room = makeRoleRoom(type);
  const first = firstDrone(room);
  first.nextDecisionAt = 1000;
  first.nextThinkAt = 1000;
  for (const drone of room.drones.values()) {
    if (drone !== first) {
      drone.nextDecisionAt = 1e9;
      drone.nextThinkAt = 1e9;
    }
  }
  const tickMs = 1000 / 30;
  const decisionTimes = [];
  const positions = [];
  const steps = Math.ceil(interval / tickMs) + 2;
  for (let step = 0; step < steps; step += 1) {
    const now = 1000 + step * tickMs;
    const beforeX = first.x;
    const beforeY = first.y;
    const telemetry = runOptimizedTick(room, now);
    if (telemetry.droneDecisionsRun > 0) decisionTimes.push(now);
    positions.push({ x: first.x, y: first.y });
    if (step === 1) {
      assert.equal(telemetry.droneDecisionsRun, 0, `${type} decision is deferred before its cadence boundary`);
      assert.ok(Math.hypot(first.x - beforeX, first.y - beforeY) > 0, `${type} still moves while its decision is deferred`);
    }
  }
  assert.equal(decisionTimes.length, 2, `${type} runs exactly two scheduled decisions in the cadence fixture`);
  assert.ok(decisionTimes[1] - decisionTimes[0] >= interval, `${type} decisions respect the ${interval}ms cadence`);
  assert.ok(positions.some((position, index) => index > 0 && position.x !== positions[index - 1].x), `${type} physical movement is continuous`);
  assertFiniteDrones(room, `${type} cadence fixture remains finite`);
}

{
  const room = makeRoleRoom("fighter");
  const first = firstDrone(room);
  for (const drone of room.drones.values()) if (drone !== first) drone.nextDecisionAt = 1e9;
  first.nextDecisionAt = 1000;
  first.nextActionAt = 1000;
  runOptimizedTick(room, 1000);
  const shotsBeforeDeferredTick = room.effects.filter((effect) => effect.type === "droneshot").length;
  first.nextActionAt = 1033;
  const deferredTelemetry = runOptimizedTick(room, 1033);
  const shotsAfterDeferredTick = room.effects.filter((effect) => effect.type === "droneshot").length;
  assert.equal(deferredTelemetry.droneDecisionsRun, 0, "fighter weapon action test keeps the decision deferred");
  assert.ok(shotsAfterDeferredTick > shotsBeforeDeferredTick, "fighter weapon actions still run on a deferred-decision tick");
}

{
  const room = makeRoleRoom("repair");
  const first = firstDrone(room);
  const parent = room.ships.get("carrier");
  // Damage a non-Bay component so repairing it does not change the Bay
  // revision on every action tick; the decision should remain deferred.
  parent.design.push({ x: 6, y: 6, type: "frame" });
  parent.componentHp[0] = 100;
  parent.componentMaxHp[0] = 100;
  parent.componentHp.push(50);
  parent.componentMaxHp.push(100);
  parent.componentPower.byComponentIndex.push({ operationalMultiplier: 1 });
  parent.hp = 950;
  parent.maxHp = 1000;
  for (const drone of room.drones.values()) if (drone !== first) drone.nextDecisionAt = 1e9;
  first.nextDecisionAt = 1000;
  first.nextActionAt = 1000;
  runOptimizedTick(room, 1000);
  const repairsBeforeDeferredTick = room.effects.filter((effect) => effect.type === "dronerepair").length;
  const repairedBeforeDeferredTick = parent.componentHp[1];
  first.nextActionAt = 1033;
  const deferredTelemetry = runOptimizedTick(room, 1033);
  const repairsAfterDeferredTick = room.effects.filter((effect) => effect.type === "dronerepair").length;
  assert.equal(deferredTelemetry.droneDecisionsRun, 0, "repair action test keeps the decision deferred");
  assert.ok(repairsAfterDeferredTick > repairsBeforeDeferredTick, "repair actions still run on a deferred-decision tick");
  assert.ok(parent.componentHp[1] > repairedBeforeDeferredTick, "repair action changes the damaged component on the deferred tick");
}

{
  const room = makeRoleRoom("fighter");
  const first = firstDrone(room);
  first.nextDecisionAt = 1000;
  first.fuelRemainingSeconds = 0.02;
  runOptimizedTick(room, 1000, 0.05);
  assert.ok(["returning", "docking"].includes(first.state), "fuel depletion enters return/docking state immediately");
  const bay = room.ships.get("carrier").droneBays[0];
  const state = Drones._test.buildBayFrameState(room, room.ships.get("carrier"), bay, 99, 1100, false);
  first.x = state.worldX;
  first.y = state.worldY;
  first.vx = 0;
  first.vy = 0;
  first.state = "returning";
  first.returnReason = "fuel";
  runOptimizedTick(room, 1100);
  assert.equal(first.state, "refueling", "fuel return docks into the Bay");
  runOptimizedTick(room, 3100);
  assert.equal(first.state, "launching", "refueling completes on the configured timer");
  assert.ok(first.fuelRemainingSeconds > 0, "refueling restores fuel");
}

{
  const room = makeRoleRoom("fighter");
  const parent = room.ships.get("carrier");
  const bay = parent.droneBays[0];
  const first = firstDrone(room);
  first.targetId = "enemy";
  assert.equal(Drones.setDroneBayMode(room, { id: "blue" }, parent.id, bay.componentId, "recalled", 1000), true);
  assert.equal(first.state, "returning", "recall transitions active drones to return");
  assert.equal(first.returnReason, "recall");
  assert.equal(first.targetId, null, "recall clears the target");
  assert.equal(Drones.setDroneBayMode(room, { id: "blue" }, parent.id, bay.componentId, "deployed", 1100), true);
  assert.equal(first.commandState, "deployed", "deploy restores the command state");
  assert.equal(first.state, "active", "deploy resumes a recalled drone");
  assert.ok(room._roomTelemetry.droneTargetsInvalidated >= 2, "recall/deploy invalidations are counted");
}

{
  const room = makeRoleRoom("fighter");
  const parent = room.ships.get("carrier");
  const first = firstDrone(room);
  runOptimizedTick(room, 1000);
  parent.componentHp[0] = 0;
  runOptimizedTick(room, 1033);
  assert.equal(first.state, "fallback", "Bay destruction puts a live drone in fallback");
  repairShipComponents(room, parent, 100, 1066);
  runOptimizedTick(room, 1066);
  assert.equal(first.state, "active", "repairing the destroyed Bay resumes the drone");
  parent.componentPower.byComponentIndex[0].operationalMultiplier = 0;
  runOptimizedTick(room, 1100);
  assert.equal(first.state, "fallback", "power loss keeps the Bay in fallback");
  parent.componentPower.byComponentIndex[0].operationalMultiplier = 1;
  runOptimizedTick(room, 1133);
  assert.equal(first.state, "active", "power restoration resumes the drone");
  assert.ok(first.decisionInvalidated === false, "power restoration is handled by the immediate decision");
}

{
  const room = makeRoleRoom("fighter");
  const parent = room.ships.get("carrier");
  const bay = parent.droneBays[0];
  const producing = bay.slots[0];
  producing.state = "producing";
  producing.productionProgress = 0.25;
  parent.componentHeatState[0] = HeatRules.STATE.OVERHEATED;
  runOptimizedTick(room, 1000);
  assert.equal(producing.pauseReason, "bay-overheated", "overheat pauses Bay production");
  const pausedProgress = producing.productionProgress;
  parent.componentHeatState[0] = HeatRules.STATE.NORMAL;
  runOptimizedTick(room, 1033);
  assert.ok(producing.productionProgress > pausedProgress, "normal heat resumes Bay production");
}

{
  const room = makeRoleRoom("defence");
  const first = firstDrone(room);
  const parent = room.ships.get("carrier");
  const config = Drones.CONFIG.types.defence;
  const target = Drones._test.chooseTarget(room, first, parent, config, 1000, null);
  assert.equal(target.id, "hostile-missile", "Defence scoring preserves missile-first targeting");
}

{
  const room = makeRoleRoom("repair");
  const parent = room.ships.get("carrier");
  parent.componentHp[0] = 100;
  parent.hp = 1000;
  parent.repairCacheRevision = (parent.repairCacheRevision || 0) + 1;
  const ally = makeShip("ally", "blue", "a", 650, 500, "ally:bay", "fighter");
  ally.componentHp[0] = 40;
  ally.componentMaxHp[0] = 100;
  ally.repairCacheRevision = 1;
  room.ships.set(ally.id, ally);
  room.spatialIndex.invalidateDynamic();
  buildRoomSpatialIndex(room, [...room.ships.values()], 1000);
  const first = firstDrone(room);
  const bay = parent.droneBays[0];
  const state = Drones._test.buildBayFrameState(room, parent, bay, 1, 1000, false);
  const runtimeConfig = Drones._test.buildDroneRuntimeConfig(first, Drones.CONFIG.types.repair, first.authoritativeSequence);
  const context = DroneDecisionContext.buildDroneDecisionContext(room, parent, bay, "repair", runtimeConfig, [...room.drones.values()], 1000, 1, state.revision);
  const indexed = room.spatialIndex;
  room.spatialIndex = null;
  const withoutContext = Drones._test.chooseTarget(room, first, parent, Drones.CONFIG.types.repair, 1000, null);
  room.spatialIndex = indexed;
  const withContext = Drones._test.chooseTarget(room, first, parent, Drones.CONFIG.types.repair, 1000, context);
  assert.equal(withoutContext.id, ally.id, "repair scoring selects the damaged ally without a context");
  assert.equal(withContext.id, withoutContext.id, "repair scoring remains equivalent with a shared context");
  assert.equal(room._roomTelemetry.droneContextShipQueries, 1, "repair scoring reuses the shared ship broad phase");
}

{
  const room = makeRoom();
  const parent = room.ships.get("carrier");
  const enemy = room.ships.get("enemy");
  const first = firstDrone(room);
  prepareOptimizedRoom(room);
  runOptimizedTick(room, 1000);
  parent.focusTargetId = null;
  first.nextDecisionAt = 1e9;
  const telemetry = runOptimizedTick(room, 1033);
  assert.ok(telemetry.droneTargetsInvalidated > 0, "focus changes invalidate retained targets");
  assert.ok(telemetry.droneImmediateDecisions > 0, "focus changes trigger an immediate decision");
  assert.ok(first.targetId === enemy.id || first.targetId === null, "focus changes leave a valid or empty target");
}

{
  const room = makeRoom();
  const first = firstDrone(room);
  const enemy = room.ships.get("enemy");
  room.rules.visibilityMode = "sensors";
  room.visibilityByTeam = new Map([[
    "a",
    {
      visibleEntityIds: new Set([enemy.id]),
      nextVisibleEntityIds: new Set(),
      remembered: new Map(),
      coverage: [],
      revision: 1,
      computedAt: 1000,
      computedGeneration: 1
    }
  ]]);
  room._visibilityGeneration = 1;
  Drones._test.rememberDroneTarget(room, first, enemy);
  assert.strictEqual(Drones._test.resolveCachedDroneTarget(room, first, 1000), enemy, "visible targets remain valid");
  const visibilityState = room.visibilityByTeam.get("a");
  visibilityState.visibleEntityIds = new Set();
  visibilityState.remembered = new Map([[enemy.id, { firstLostAt: 0, expiresAt: 0 }]]);
  enemy.x = 10000;
  room._visibilityGeneration = 2;
  assert.equal(Drones._test.resolveCachedDroneTarget(room, first, 1033), null, "visibility loss invalidates the retained target");
  assert.equal(first.targetId, null);
}

{
  const room = makeRoom();
  const first = firstDrone(room);
  prepareOptimizedRoom(room);
  runOptimizedTick(room, 1000);
  const record = room.spatialIndex.recordsByEntity.drones.get(first);
  assert.ok(record, "optimized runtime publishes drones into the spatial index");
  assert.ok(Math.abs(record.x - first.x) < 0.001 && Math.abs(record.y - first.y) < 0.001, "drone publication uses final post-separation coordinates");

  const fallbackRoom = makeRoom();
  prepareOptimizedRoom(fallbackRoom);
  fallbackRoom.spatialIndex.invalidateDynamic();
  RoomTelemetry.resetRoomTelemetry(fallbackRoom);
  runOptimizedTick(fallbackRoom, 1000);
  assert.ok(fallbackRoom._roomTelemetry.droneContextFallbacks > 0, "invalid spatial state uses and labels a context fallback");

  Drones.resetDroneRuntime(room);
  assert.equal(room._droneDecisionRuntime.contexts.size, 0, "room reset clears decision contexts");
  assert.equal(room._droneContextMemberScratch.size, 0, "room reset clears context member scratch");
  assert.equal(room._droneFrameId, 0, "room reset clears the drone frame marker");
}

{
  const room = makeRoom();
  const ships = [...room.ships.values()];
  const parent = room.ships.get("carrier");
  const enemy = room.ships.get("enemy");
  enemy.x = 3000;
  enemy.y = 500;
  for (const drone of room.drones.values()) {
    if (drone.id !== "d1") drone.nextDecisionAt = 1e9;
  }
  buildRoomSpatialIndex(room, ships, 1000);
  Flags.__setOPTIMIZED_DRONE_RUNTIME(true);
  let decisions = 0;
  let invalidations = 0;
  for (let step = 0; step < 6; step += 1) {
    const now = 1000 + step * (1000 / 30);
    room._simulationStep = 30 + step;
    RoomTelemetry.resetRoomTelemetry(room);
    Drones.updateDroneBays(room, ships, 1 / 30, now);
    const first = room.drones.get("d1");
    assert.equal(first._targetRuntime.entity, enemy, "focused Fighter retains a target beyond command range");
    decisions += room._roomTelemetry.droneDecisionsRun;
    invalidations += room._roomTelemetry.droneTargetsInvalidated;
  }
  assert.equal(decisions, 1, "focused target retention preserves the Fighter decision cadence");
  assert.equal(invalidations, 0, "focused target retention does not churn invalidation telemetry");
  assert.equal(room.drones.get("d1")._targetRuntime.entity, enemy);
  Flags.__setOPTIMIZED_DRONE_RUNTIME(false);
}

{
  const room = makeRoom();
  const ships = [...room.ships.values()];
  const staggered = [1000, 1066, 1100, 1133];
  for (const [index, drone] of [...room.drones.values()].entries()) {
    drone.nextDecisionAt = staggered[index];
    drone.nextThinkAt = staggered[index];
  }
  buildRoomSpatialIndex(room, ships, 1000);
  Flags.__setOPTIMIZED_DRONE_RUNTIME(true);
  RoomTelemetry.resetRoomTelemetry(room);
  for (const [step, now] of [1000, 1066, 1100, 1133].entries()) {
    room._simulationStep = 50 + step;
    Drones.updateDroneBays(room, ships, 1 / 30, now);
  }
  assert.ok(room._roomTelemetry.droneDecisionsRun >= 4, "staggered drones still make their scheduled decisions");
  assert.ok(room._roomTelemetry.droneContextsBuilt < 4, "staggered drones reuse a context across simulation frames");
  assert.ok(room._roomTelemetry.droneContextHits >= 3, "cross-frame context reuse is observable");
  assert.equal(room._roomTelemetry.droneContextShipQueries, room._roomTelemetry.droneContextsBuilt);
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

  const movingRoomData = makeProjectileRoom();
  buildRoomSpatialIndex(movingRoomData.room, [], 2000);
  movingRoomData.drone.x = 650;
  movingRoomData.drone.vx = 375;
  movingRoomData.room.spatialIndex.update("drones", movingRoomData.drone, movingRoomData.drone.radius);
  addProjectile(movingRoomData.room, "moving-crossing", 300, 400, 1000);
  updateBullets(movingRoomData.room, 0.4, 2000);
  assert.equal(movingRoomData.drone.hull, 40, "indexed projectile collision still catches a moved drone");

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
Flags.__setINCREMENTAL_SPATIAL_INDEX(false);
console.log("Phase 6B drone runtime verification passed");
