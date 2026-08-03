"use strict";

const assert = require("assert");
const HeatRules = require("./public/src/shared/heatRules");
const WiringRules = require("./public/src/shared/wiringRules");
const { PARTS } = require("./src/server/components");
const { getOccupiedCells } = require("./src/server/footprint");
const { computeStats } = require("./src/server/shipStats");
const { applyHullDamage, componentsAlongImpactRay, detonateComponent, initComponentState, repairShipComponents } = require("./src/server/componentHealth");
const { initializeComponentPower, reallocateShipPower } = require("./src/server/componentPower");
const Heat = require("./src/server/heat");
const { createImmutableShipTemplate } = require("./src/server/shipTemplates");
const { spawnShip } = require("./src/server/ships");
const MovementCapability = require("./src/server/movementCapability");
const Combat = require("./src/server/combat");
const Drones = require("./src/server/drones");

const EPSILON = 1e-8;
const m = (type, x, y, rotation = 0) => ({ type, x, y, rotation });
const clone = (value) => JSON.parse(JSON.stringify(value));
const close = (a, b, label, epsilon = EPSILON) => assert(Math.abs((Number(a) || 0) - (Number(b) || 0)) <= epsilon, `${label}: ${a} !== ${b}`);

function makeShip(design, wiring = WiringRules.emptyWiring()) {
  const nextDesign = clone(design);
  const ship = {
    id: "phase-6a", alive: true, design: nextDesign, wiring: clone(wiring),
    stats: computeStats(nextDesign, wiring), x: 0, y: 0, angle: 0,
    hp: 1000, coreDestroyed: false, dirtyComponents: new Set(), dirtyHeat: new Set()
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  Heat.initShipHeat(ship);
  return ship;
}

function pair(design, wiring = WiringRules.emptyWiring()) {
  return { canonical: makeShip(design, wiring), repeat: makeShip(design, wiring) };
}

function eachShip(target, callback) {
  callback(target.canonical);
  callback(target.repeat);
}

function synchronizeDerivedState(target) {
  eachShip(target, (ship) => {
    Heat.recalculateEffectiveThermalCapacities(ship);
    Heat.rebuildRuntimeExposure(ship);
    Heat.rebuildThermalNetworks(ship);
    Heat.refreshHeatRuntimeLists(ship);
    Heat.refreshHeatSourceSignatures(ship);
    reallocateShipPower(ship, "phase-6a-fixture");
  });
}

function compareArrays(left, right, label, epsilon = EPSILON) {
  assert.strictEqual(left.length, right.length, `${label} length`);
  for (let i = 0; i < left.length; i += 1) {
    if (typeof left[i] === "number" || typeof right[i] === "number") close(left[i], right[i], `${label}[${i}]`, epsilon);
    else assert.strictEqual(left[i], right[i], `${label}[${i}]`);
  }
}

function comparePair(target, label) {
  const canonical = target.canonical;
  const repeat = target.repeat;
  for (const field of [
    "componentHeat", "componentHeatState", "componentHeatInput", "componentHeatGenerated",
    "componentHeatReceived", "componentHeatRemoved", "componentHeatTransferredOut",
    "componentHeatCooled", "componentHeatSentThroughFrame", "componentHeatRadiated",
    "componentVentedOverflowHeatThisTick", "componentTotalVentedOverflowHeat",
    "componentPowerCableHeatRate", "componentPowerCableHeatGenerated", "componentMeltdown"
  ]) if (canonical[field] || repeat[field]) compareArrays(canonical[field] || [], repeat[field] || [], `${label} ${field}`);
  for (const field of ["currentHeat", "maxHeat", "heatPressure", "powerCableHeatGenerated", "totalVentedOverflowHeat"]) close(canonical[field], repeat[field], `${label} ${field}`, 2e-7);
  for (const field of [
    "heatAccumulator", "heatRevision", "heatStateRevision", "componentHeatRevision", "heatTelemetryRevision",
    "hotComponentCount", "overheatedComponentCount", "powerRevision", "wiringRevision"
  ]) assert.strictEqual(canonical[field] || 0, repeat[field] || 0, `${label} ${field}`);
  const canonicalData = canonical.runtimeDataSupport || {};
  const repeatData = repeat.runtimeDataSupport || {};
  for (const field of ["topologyRevision", "allocationRevision"]) assert.strictEqual(canonicalData[field] || 0, repeatData[field] || 0, `${label} data ${field}`);
  assert.deepStrictEqual([...canonical.dirtyHeat].sort((a, b) => a - b), [...repeat.dirtyHeat].sort((a, b) => a - b), `${label} dirtyHeat`);
  assert.deepStrictEqual(canonical.componentThermalNetworks, repeat.componentThermalNetworks, `${label} thermal networks`);
  assert(!Object.prototype.hasOwnProperty.call(repeat, "_heatScratch"), `${label} canonical runtime has no transfer scratch object`);
  assert.deepStrictEqual(repeat._thermalRuntime.heatBearingComponents, repeat._thermalRuntime.heatBearingComponents.slice().sort((a, b) => a - b), `${label} Heat list order`);
  assert.deepStrictEqual(repeat._thermalRuntime.hotComponents, repeat._thermalRuntime.hotComponents.slice().sort((a, b) => a - b), `${label} HOT list order`);
  for (const index of repeat._thermalRuntime.heatBearingComponents) assert(Number.isFinite(repeat.componentHeat[index]) && repeat.componentHeat[index] > 0, `${label} positive Heat membership`);
}

function boundary(target, dt, label, before = null) {
  if (before) { before(target.canonical); before(target.repeat); }
  Heat.updateShipHeat(target.canonical, dt, null, 0);
  Heat.updateShipHeat(target.repeat, dt, null, 0);
  comparePair(target, label);
}

function comparePairExact(target, label) {
  const canonical = target.canonical;
  const repeat = target.repeat;
  for (const field of [
    "componentHeat", "componentHeatState", "componentHeatInput", "componentHeatGenerated",
    "componentHeatReceived", "componentHeatRemoved", "componentHeatTransferredOut",
    "componentHeatCooled", "componentHeatSentThroughFrame", "componentHeatRadiated",
    "componentVentedOverflowHeatThisTick", "componentTotalVentedOverflowHeat",
    "componentPowerCableHeatRate", "componentPowerCableHeatGenerated", "componentMeltdown",
    "componentHeatCapacity"
  ]) {
    const left = canonical[field] || [];
    const right = repeat[field] || [];
    assert.strictEqual(left.length, right.length, `${label} ${field} length`);
    for (let index = 0; index < left.length; index += 1) {
      assert(Object.is(left[index], right[index]), `${label} ${field}[${index}]: ${left[index]} !== ${right[index]}`);
    }
  }
  for (const field of [
    "currentHeat", "maxHeat", "heatPressure", "powerCableHeatGenerated", "powerCableHeatTotal",
    "totalVentedOverflowHeat", "ventedOverflowHeatThisTick", "heatAccumulator", "lastHeatTickDelta"
  ]) {
    if (field === "currentHeat" || field === "heatPressure") close(canonical[field], repeat[field], `${label} ${field}`, 5e-12);
    else assert(Object.is(canonical[field], repeat[field]), `${label} ${field}: ${canonical[field]} !== ${repeat[field]}`);
  }
  for (const field of [
    "heatRevision", "heatStateRevision", "componentHeatRevision", "heatTelemetryRevision",
    "hotComponentCount", "overheatedComponentCount", "powerRevision", "wiringRevision",
    "componentAliveRevision", "componentDamageRevision", "hasActiveHeat", "hasPendingHeatInput"
  ]) assert(Object.is(canonical[field], repeat[field]), `${label} ${field}`);
  assert.deepStrictEqual([...canonical.dirtyHeat].sort((a, b) => a - b), [...repeat.dirtyHeat].sort((a, b) => a - b), `${label} dirtyHeat`);
  assert.deepStrictEqual(canonical.componentThermalNetworks, repeat.componentThermalNetworks, `${label} thermal networks`);
  assert.deepStrictEqual(canonical.frameCoolingDistance, repeat.frameCoolingDistance, `${label} cooling distances`);
  const expectedHeat = repeat.componentHeat
    .map((value, index) => Number.isFinite(value) && value > 0 ? index : -1)
    .filter((index) => index >= 0);
  const expectedHot = repeat.componentHeatState
    .map((state, index) => ((repeat.componentHp?.[index] ?? 1) > 0 && state >= HeatRules.STATE.HOT) ? index : -1)
    .filter((index) => index >= 0);
  const expectedPending = repeat.componentHeatInput
    .map((value, index) => Number(value) > 0 ? index : -1)
    .filter((index) => index >= 0);
  const expectedCable = repeat.componentPowerCableHeatRate
    .map((value, index) => Number(value) > 0 ? index : -1)
    .filter((index) => index >= 0);
  assert.deepStrictEqual(repeat._thermalRuntime.heatBearingComponents, expectedHeat, `${label} Heat list`);
  assert.deepStrictEqual(repeat._thermalRuntime.hotComponents, expectedHot, `${label} HOT list`);
  assert.deepStrictEqual(repeat._thermalRuntime.pendingInputComponents, expectedPending, `${label} pending list`);
  assert.deepStrictEqual(repeat._thermalRuntime.cableComponents, expectedCable, `${label} cable list`);
  const canonicalData = canonical.runtimeDataSupport || {};
  const repeatData = repeat.runtimeDataSupport || {};
  assert.deepStrictEqual(
    { topologyRevision: canonicalData.topologyRevision || 0, allocationRevision: canonicalData.allocationRevision || 0 },
    { topologyRevision: repeatData.topologyRevision || 0, allocationRevision: repeatData.allocationRevision || 0 },
    `${label} Data revisions`
  );
}

function boundaryExact(target, dt, label, before = null) {
  if (before) { before(target.canonical); before(target.repeat); }
  Heat.updateShipHeat(target.canonical, dt, null, 0);
  Heat.updateShipHeat(target.repeat, dt, null, 0);
  comparePairExact(target, label);
}

function makeRoomForShip(ship, ownerId = `phase-6a-${ship.id}`) {
  ship.ownerId = ownerId;
  ship.team = "blue";
  ship.vx = 0;
  ship.vy = 0;
  ship.destroyFinalizedAt = null;
  const player = {
    id: ownerId,
    team: "blue",
    ships: [ship],
    losses: 0,
    lostFleetCost: 0,
    fleetCost: 0
  };
  const room = {
    nextEntityId: 1,
    mapSeed: 1,
    world: { width: 4000, height: 3000 },
    map: { asteroids: [], safeZones: [] },
    players: new Map([[ownerId, player]]),
    ships: new Map([[ship.id, ship]]),
    drones: new Map(),
    effects: [],
    projectiles: [],
    stations: [],
    phase: "battle"
  };
  return room;
}

function randomDesign(seed, componentCount = 32) {
  let state = (seed >>> 0) || 1;
  const nextRandom = () => {
    state = Math.imul(state, 1664525) + 1013904223 >>> 0;
    return state >>> 0;
  };
  const design = [];
  const occupied = new Set();
  const types = [
    "frame", "heatPipe", "radiator", "heatSink", "reactor", "engine", "maneuverThruster",
    "gyroscope", "repairBeam", "droneBay", "blaster", "pointDefense", "fireControl", "armor"
  ];
  const tryPlace = (type, x, y, rotation) => {
    const part = PARTS[type] || PARTS.frame;
    const cells = getOccupiedCells(x, y, part.footprint || { width: 1, height: 1 }, rotation);
    if (cells.some((cell) => cell.x < 0 || cell.y < 0 || cell.x >= 15 || cell.y >= 15)) return false;
    if (cells.some((cell) => occupied.has(`${cell.x},${cell.y}`))) return false;
    design.push(m(type, x, y, rotation));
    for (const cell of cells) occupied.add(`${cell.x},${cell.y}`);
    return true;
  };
  tryPlace("core", 7, 7, 0);
  let attempts = 0;
  while (design.length < componentCount && attempts < componentCount * 500) {
    attempts += 1;
    const type = types[nextRandom() % types.length];
    const x = nextRandom() % 14;
    const y = nextRandom() % 14;
    const rotation = (nextRandom() % 4) * 90;
    tryPlace(type, x, y, rotation);
  }
  for (let y = 0; design.length < componentCount && y < 15; y += 1) {
    for (let x = 0; design.length < componentCount && x < 15; x += 1) tryPlace("frame", x, y, 0);
  }
  return design;
}

function randomBoundaryAction(seed, step, componentCount) {
  let state = (Math.imul(seed + 1, 1103515245) + step * 12345) >>> 0;
  const next = () => {
    state = Math.imul(state, 1664525) + 1013904223 >>> 0;
    return state >>> 0;
  };
  const operation = next() % 7;
  const index = next() % componentCount;
  const amount = 1 + (next() % 35);
  const secondaryIndex = next() % componentCount;
  const repairAmount = 18 + (next() % 30);
  return (ship) => {
    if (operation <= 2) {
      Heat.addComponentHeat(ship, index, amount);
      if (operation === 2) Heat.addComponentHeat(ship, secondaryIndex, 0.125);
      return;
    }
    if (operation === 3) {
      const rates = ship.design.map((_, componentIndex) => componentIndex === index ? 0.35 : (componentIndex % 5 === 0 ? 0.07 : 0));
      ship.componentPowerCableHeatRate = rates;
      ship.powerCableHeatRate = rates.reduce((sum, value) => sum + value, 0);
      ship.powerCableThermalAnalysis = { mode: "disabled", sections: [], components: [], summary: { totalPowerCableHeatPerSecond: ship.powerCableHeatRate, hottestSectionId: null } };
      ship._powerCableThermalFlowRevision = ship.powerFlowRevision || 0;
      Heat.refreshHeatRuntimeCableComponents(ship, rates, ship.powerCableHeatRate);
      return;
    }
    if (operation === 4) {
      const chain = componentsAlongImpactRay(ship, ship.x - 500, ship.y);
      const target = chain.find((candidate) => ship.design[candidate]?.type !== "core");
      if (Number.isInteger(target)) {
        const amount = (step % 3 === 0 ? 1.15 : 0.2) * Math.max(1, ship.componentHp[target]);
        applyHullDamage(null, ship, amount, step, ship.x - 500, ship.y, { armorInteractionSeconds: 1 });
      }
      return;
    }
    if (operation === 5) {
      repairShipComponents(null, ship, repairAmount, step);
      return;
    }
    ship.componentHeat[index] = Math.max(0, ship.componentHeat[index] + 0.000001);
    Heat.refreshHeatRuntimeLists(ship);
  };
}

function runRandomizedDifferentialSoak() {
  const dts = [0.03, 0.07, 0.11, 0.19, 0.2, 0.41, 0.09, 0.2];
  let boundaries = 0;
  for (let seed = 1; seed <= 8; seed += 1) {
    const design = randomDesign(seed, 32 + (seed % 3) * 4);
    const target = pair(design);
    synchronizeDerivedState(target);
    for (let step = 0; step < 80; step += 1) {
      boundaryExact(target, dts[step % dts.length], `random soak ${seed}/${step}`, randomBoundaryAction(seed, step, design.length));
      boundaries += 1;
    }
  }
  assert(boundaries >= 600, "randomized soak covered hundreds of thermal boundaries");
  return boundaries;
}

function compareLifecycleRooms(target, rooms, label) {
  comparePairExact(target, label);
  assert.deepStrictEqual(rooms.canonical.effects, rooms.repeat.effects, `${label} lifecycle effects`);
  for (const field of ["alive", "hp", "coreDestroyed", "componentAliveRevision", "componentDamageRevision"]) {
    if (typeof target.canonical[field] === "number") close(target.canonical[field], target.repeat[field], `${label} ${field}`, 1e-10);
    else assert.strictEqual(target.canonical[field], target.repeat[field], `${label} ${field}`);
  }
  assert.deepStrictEqual(target.canonical.componentHp, target.repeat.componentHp, `${label} component HP`);
}

function boundaryWithRooms(target, rooms, dt, label) {
  Heat.updateShipHeat(target.canonical, dt, rooms.canonical, dt);
  Heat.updateShipHeat(target.repeat, dt, rooms.repeat, dt);
  compareLifecycleRooms(target, rooms, label);
}

function runRealLifecycleParity() {
  const design = [
    m("core", 7, 7), m("armor", 6, 7), m("frame", 5, 7),
    m("heatSink", 7, 6), m("radiator", 7, 5)
  ];
  const target = pair(design);
  synchronizeDerivedState(target);
  const rooms = {
    canonical: makeRoomForShip(target.canonical, "phase-6a-lifecycle-canonical"),
    repeat: makeRoomForShip(target.repeat, "phase-6a-lifecycle-repeat")
  };
  const damage = (ship, room) => {
    const chain = componentsAlongImpactRay(ship, ship.x, ship.y - 500);
    const index = chain.find((candidate) => ship.design[candidate]?.type !== "core");
    assert(Number.isInteger(index), "real lifecycle fixture found a non-core impact target");
    applyHullDamage(room, ship, ship.componentHp[index] * 1.1, 1, ship.x, ship.y - 500, { armorInteractionSeconds: 1 });
  };
  damage(target.canonical, rooms.canonical);
  damage(target.repeat, rooms.repeat);
  assert.deepStrictEqual(target.canonical.componentHp, target.repeat.componentHp, "real damage path HP parity");
  assert.deepStrictEqual(rooms.canonical.effects, rooms.repeat.effects, "real damage path effects parity");
  boundaryWithRooms(target, rooms, 0.2, "real damage lifecycle");

  repairShipComponents(rooms.canonical, target.canonical, 1000, 2);
  repairShipComponents(rooms.repeat, target.repeat, 1000, 2);
  assert.deepStrictEqual(target.canonical.componentHp, target.repeat.componentHp, "real repair path HP parity");
  boundaryWithRooms(target, rooms, 0.2, "real repair lifecycle");
}

function runRealMeltdownParity() {
  const design = [
    m("core", 7, 7), m("reactor", 5, 7), m("frame", 4, 7),
    m("armor", 3, 7), m("radiator", 7, 6)
  ];
  const prepare = (target, rooms, forceShipDestruction) => {
    eachShip(target, (ship) => {
      ship.componentHeat[1] = ship.componentThermals[1].capacity * 1.24;
      ship.componentHeatState[1] = HeatRules.STATE.OVERHEATED;
      ship.componentMeltdown = ship.componentHeat.map(() => 0);
      ship.componentMeltdown[1] = HeatRules.REACTOR_MELTDOWN_SECONDS - 0.05;
      ship.hasActiveHeat = true;
      if (forceShipDestruction) ship.hp = 1;
      Heat.refreshHeatRuntimeLists(ship);
    });
    const reactorHp = target.canonical.componentHp[1];
    const neighbourHp = target.canonical.componentHp[2];
    boundaryWithRooms(target, rooms, 0.2, forceShipDestruction ? "real meltdown destruction" : "real meltdown blast");
    assert(rooms.canonical.effects.some((effect) => effect.type === "boom"), "real meltdown produced an explosion effect");
    assert.deepStrictEqual(rooms.canonical.effects, rooms.repeat.effects, "real meltdown effects parity");
    assert.strictEqual(target.canonical.componentHp[1], 0, "real meltdown destroyed reactor");
    if (!forceShipDestruction) {
      assert(target.canonical.componentHp[2] < neighbourHp, "real meltdown damaged a neighbouring component");
      assert(target.canonical.componentHp[1] <= reactorHp, "real meltdown reactor damage applied");
      assert.strictEqual(target.canonical.alive, true, "surviving real meltdown leaves ship alive");
    } else {
      assert.strictEqual(target.canonical.alive, false, "real meltdown can destroy the ship");
      assert.strictEqual(target.canonical.componentHp[0], 0, "ship destruction clears the core through lifecycle handling");
    }
  };

  const surviving = pair(design);
  synchronizeDerivedState(surviving);
  prepare(surviving, {
    canonical: makeRoomForShip(surviving.canonical, "phase-6a-meltdown-canonical"),
    repeat: makeRoomForShip(surviving.repeat, "phase-6a-meltdown-repeat")
  }, false);

  const destroyed = pair(design);
  synchronizeDerivedState(destroyed);
  prepare(destroyed, {
    canonical: makeRoomForShip(destroyed.canonical, "phase-6a-meltdown-death-canonical"),
    repeat: makeRoomForShip(destroyed.repeat, "phase-6a-meltdown-death-repeat")
  }, true);
}

function runRealProducerParity() {
  const movement = pair([
    m("core", 7, 7), m("engine", 7, 5), m("maneuverThruster", 6, 7), m("gyroscope", 8, 7)
  ]);
  synchronizeDerivedState(movement);
  eachShip(movement, (ship) => {
    MovementCapability.applyEngineHeat(ship, 0.75, 0.2);
    MovementCapability.applyTurnHeat(ship, 0.5, 0.2);
  });
  assert(movement.canonical.componentHeatInput.some((value, index) => index > 0 && value > 0), "real movement producers add Heat");
  assert.deepStrictEqual(movement.canonical.componentHeatInput, movement.repeat.componentHeatInput, "real movement producer parity");
  boundaryExact(movement, 0.2, "real movement producers");

  const repair = pair([m("core", 7, 7), m("repair", 6, 7), m("frame", 5, 7)]);
  synchronizeDerivedState(repair);
  const repairRooms = {
    canonical: makeRoomForShip(repair.canonical, "phase-6a-repair-canonical"),
    repeat: makeRoomForShip(repair.repeat, "phase-6a-repair-repeat")
  };
  eachShip(repair, (ship) => {
    const room = ship === repair.canonical ? repairRooms.canonical : repairRooms.repeat;
    applyHullDamage(room, ship, ship.componentHp[2] * 0.4, 0, ship.x, ship.y - 500, { armorInteractionSeconds: 1 });
  });
  Combat.updateShipSupport(repairRooms.canonical, [repair.canonical], 0.2, 1);
  Combat.updateShipSupport(repairRooms.repeat, [repair.repeat], 0.2, 1);
  assert(repair.canonical.componentHeatInput[1] > 0, "real repair producer adds Heat");
  assert.deepStrictEqual(repair.canonical.componentHeatInput, repair.repeat.componentHeatInput, "real repair producer parity");
  boundaryWithRooms(repair, repairRooms, 0.2, "real repair producer");

  const drones = pair([m("core", 7, 7), m("droneBay", 4, 5)]);
  synchronizeDerivedState(drones);
  const droneRooms = {
    canonical: makeRoomForShip(drones.canonical, "phase-6a-drone-canonical"),
    repeat: makeRoomForShip(drones.repeat, "phase-6a-drone-repeat")
  };
  Drones.initializeDroneBays(droneRooms.canonical, drones.canonical, 0);
  Drones.initializeDroneBays(droneRooms.repeat, drones.repeat, 0);
  Drones.updateDroneBays(droneRooms.canonical, [drones.canonical], 0.2, 0.2);
  Drones.updateDroneBays(droneRooms.repeat, [drones.repeat], 0.2, 0.2);
  assert(drones.canonical.componentHeatInput[1] > 0, "real drone-bay producer adds Heat");
  assert.deepStrictEqual(drones.canonical.componentHeatInput, drones.repeat.componentHeatInput, "real drone producer parity");
  boundaryWithRooms(drones, droneRooms, 0.2, "real drone producers");

  const impact = pair([m("core", 7, 7), m("armor", 6, 7), m("frame", 5, 7), m("radiator", 7, 6)]);
  synchronizeDerivedState(impact);
  const impactRooms = {
    canonical: makeRoomForShip(impact.canonical, "phase-6a-impact-canonical"),
    repeat: makeRoomForShip(impact.repeat, "phase-6a-impact-repeat")
  };
  eachShip(impact, (ship) => {
    const room = ship === impact.canonical ? impactRooms.canonical : impactRooms.repeat;
    const attackerId = `${ship.id}-attacker`;
    room.players.set(attackerId, { id: attackerId, team: "red", ships: [], losses: 0, lostFleetCost: 0 });
    const attacker = { id: attackerId, ownerId: attackerId, team: "red", x: -400, y: 0, angle: 0 };
    ship.x = 200;
    ship.y = 0;
    ship.shield = 0;
    Combat.damageBeamTargets(
      room, attacker, [ship], ship.x - 500, ship.y, ship.x + 500, ship.y, 0, 20, 1,
      { impactHeatPerDamage: 0.5, burnThroughCarryMultiplier: 0.25, armorInteractionSeconds: 1 }
    );
  });
  assert(impact.canonical.componentHeatInput.some((value) => value > 0), "real weapon/impact producer adds Heat");
  assert.deepStrictEqual(impact.canonical.componentHeatInput, impact.repeat.componentHeatInput, "real weapon/impact producer parity");
  boundaryWithRooms(impact, impactRooms, 0.2, "real weapon and impact producers");
}

function runScenario(name, design, wiring, actions, dts) {
  const target = pair(design, wiring);
  synchronizeDerivedState(target);
  for (let i = 0; i < dts.length; i += 1) boundary(target, dts[i], `${name} boundary ${i}`, actions[i] || null);
  return target;
}

const addHeatAt = (index, amount) => (ship) => Heat.addComponentHeat(ship, index, amount);
const setStoredHeat = (index, amount) => (ship) => {
  ship.componentHeat[index] = amount;
  ship.componentHeatState[index] = HeatRules.stateFor(amount / Math.max(1, ship.componentThermals[index].capacity), ship.componentHeatState[index]);
  Heat.refreshHeatRuntimeLists(ship);
};
const setCableRates = (rates) => (ship) => {
  const next = rates.slice();
  const total = next.reduce((sum, value) => sum + value, 0);
  ship.componentPowerCableHeatRate = next;
  ship.powerCableHeatRate = total;
  // WIRING_ENABLED is false in the current baseline, so the authoritative
  // disabled analysis must be retained while this fixture injects rates.
  ship.powerCableThermalAnalysis = { mode: "disabled", sections: [], components: [], summary: { totalPowerCableHeatPerSecond: total, hottestSectionId: null } };
  ship._powerCableThermalFlowRevision = ship.powerFlowRevision || 0;
  Heat.refreshHeatRuntimeCableComponents(ship, next, total);
};
const destroyOrRepair = (index, repair) => (ship) => {
  ship.componentHp[index] = repair ? ship.componentMaxHp[index] : 0;
  Heat.recalculateEffectiveThermalCapacities(ship);
  Heat.rebuildRuntimeExposure(ship);
  Heat.rebuildThermalNetworks(ship);
  Heat.refreshHeatRuntimeLists(ship);
};

// Cold cadence, accumulator phases, sparse large designs and disconnected hotspots.
runScenario("cold no-reactor", [m("frame", 0, 0)], undefined, [], [0.2, 0.2, 0.2]);
const coldReactor = [m("reactor", 0, 0)];
runScenario("cold unloaded reactor", coldReactor, WiringRules.emptyWiring(), [], [0.03, 0.17, 0.41, 0.19, 0.2]);
runScenario("input accumulator phases", [m("frame", 0, 0), m("frame", 1, 0)], undefined, [addHeatAt(0, 12), null, addHeatAt(1, 6), null, addHeatAt(0, 1)], [0.03, 0.07, 0.11, 0.09, 0.2]);
runScenario("ordinary adjacency", [m("frame", 0, 0), m("armor", 1, 0), m("heatSink", 2, 0)], undefined, [addHeatAt(0, 100), null, null, null], [0.2, 0.2, 0.2, 0.2]);
runScenario("disconnected hotspots", [m("frame", 0, 0), m("frame", 1, 0), m("frame", 5, 0), m("radiator", 6, 0)], undefined, [(ship) => { Heat.addComponentHeat(ship, 0, 80); Heat.addComponentHeat(ship, 2, 40); }, null, null], [0.2, 0.2, 0.2]);
const largeDesign = Array.from({ length: 75 }, (_, i) => m(i % 15 === 0 ? "heatSink" : "frame", i % 15, Math.floor(i / 15)));
runScenario("large sparse hotspot", largeDesign, undefined, [addHeatAt(0, 140), null, null, null], [0.2, 0.2, 0.2, 0.2]);

// Ordinary adjacency, frame/heat-pipe routes, radiators, destruction, repair and capacity.
const routedDesign = [m("blaster", 0, 0), m("frame", 1, 0), m("heatPipe", 2, 0), m("radiator", 3, 0), m("heatSink", 4, 0)];
const routed = runScenario("frame and heat-pipe routing", routedDesign, undefined, [addHeatAt(0, 140), null, null, null, null], [0.2, 0.2, 0.2, 0.2, 0.2]);
boundary(routed, 0.2, "destroyed route", destroyOrRepair(2, false));
boundary(routed, 0.2, "repair route", destroyOrRepair(2, true));
boundary(routed, 0.2, "heat-sink damage", (ship) => { ship.componentHp[4] = ship.componentMaxHp[4] * 0.35; Heat.recalculateEffectiveThermalCapacities(ship, 4); });
boundary(routed, 0.2, "retained capacity", setStoredHeat(4, routed.canonical.componentThermals[4].capacity * 0.9));

// Existing producers all enter through addComponentHeat; no source logic is duplicated here.
const producerDesign = [m("frame", 0, 0), m("engine", 1, 0), m("gyroscope", 2, 0), m("repairBeam", 3, 0), m("blaster", 4, 0), m("droneBay", 5, 0)];
runScenario("engine weapon repair drone impact", producerDesign, undefined, [(ship) => {
  Heat.addComponentHeat(ship, 1, 4); Heat.addComponentHeat(ship, 2, 3); Heat.addComponentHeat(ship, 3, 2);
  Heat.addComponentHeat(ship, 4, 8); Heat.addComponentHeat(ship, 5, 5); Heat.addComponentHeat(ship, 0, 11);
}, null, null], [0.2, 0.2, 0.2]);

// Reactor state refresh, Data/Power source transitions and meltdown timing.
const reactorDesign = [m("reactor", 0, 0), m("engine", 1, 0), m("fireControl", 2, 0), m("blaster", 3, 0)];
const reactorWiring = WiringRules.emptyWiring();
const reactor = runScenario("reactor source refresh", reactorDesign, reactorWiring, [setStoredHeat(0, 90), null, null, null], [0.2, 0.2, 0.2, 0.2]);
boundary(reactor, 0.2, "reactor recovery", (ship) => { ship.componentHeat[0] = ship.componentThermals[0].capacity * 0.7; ship.componentHeatState[0] = HeatRules.STATE.HOT; Heat.refreshHeatRuntimeLists(ship); });
const meltdown = pair(reactorDesign, reactorWiring);
synchronizeDerivedState(meltdown);
eachShip(meltdown, (ship) => {
  ship.componentHeat[0] = ship.componentThermals[0].capacity * 1.02;
  ship.componentHeatState[0] = HeatRules.STATE.OVERHEATED;
  ship.componentMeltdown = ship.componentHeat.map(() => 0);
  ship.componentMeltdown[0] = 2.6;
  Heat.refreshHeatRuntimeLists(ship);
});
for (let i = 0; i < 4; i += 1) boundary(meltdown, 0.2, `meltdown timing ${i}`);

// Catch-up, cable Heat start/change/stop and telemetry returning to zero.
const cableDesign = [m("reactor", 0, 0), m("engine", 1, 0), m("radiator", 2, 0)];
const cable = pair(cableDesign, WiringRules.emptyWiring());
synchronizeDerivedState(cable);
boundary(cable, 0.2, "cable starts", setCableRates([0.6, 0.3, 0]));
boundary(cable, 0.4, "cable changes", setCableRates([0.2, 0.8, 0.1]));
boundary(cable, 0.2, "cable stops", setCableRates([0, 0, 0]));
runScenario("catch-up telemetry", [m("frame", 0, 0)], undefined, [addHeatAt(0, 0.2), null, null], [0.03, 0.57, 0.2]);

const randomizedSoakBoundaries = runRandomizedDifferentialSoak();
runRealLifecycleParity();
runRealMeltdownParity();
runRealProducerParity();

// Template/direct construction and mutable-state isolation.
const templateDesign = [m("core", 0, 0), m("reactor", 1, 0), m("frame", 2, 0), m("radiator", 3, 0)];
const templateWiring = WiringRules.emptyWiring();
const template = createImmutableShipTemplate(templateDesign, templateWiring, computeStats(templateDesign, templateWiring));
const player = { id: "phase-6a-player", team: "blue", shipCap: 2, ships: [], design: templateDesign, wiring: templateWiring, stats: template.stats, rallyPoint: null };
const room = { nextEntityId: 1, mapSeed: 1, world: { width: 2000, height: 1600 }, map: { asteroids: [], safeZones: [] }, players: new Map([[player.id, player]]), ships: new Map(), effects: [] };
const templateShipA = spawnShip(room, player, 0, 0, { template });
const templateShipB = spawnShip(room, player, 0, 1, { template });
assert.strictEqual(templateShipA.thermalTopology, templateShipB.thermalTopology, "template ships share immutable topology");
assert.strictEqual(templateShipA.thermalTopology, template.thermalTopology, "template topology authority");
assert.notStrictEqual(templateShipA.componentHeat, templateShipB.componentHeat, "template Heat arrays are ship-local");
assert.notStrictEqual(templateShipA._thermalRuntime, templateShipB._thermalRuntime, "template Heat runtimes are ship-local");
assert(!Object.prototype.hasOwnProperty.call(templateShipA, "_componentAdjacencyValue"), "template ship does not materialize mutable adjacency");
assert(!Object.prototype.hasOwnProperty.call(templateShipB, "_componentAdjacencyValue"), "each template ship uses packed shared topology");
assert(Object.isFrozen(template.thermalTopology) && Object.isFrozen(template.thermalTopology.edgeA), "template topology guarded");
const templateTelemetryRoom = {};
Heat.updateShipHeat(templateShipA, 0.2, templateTelemetryRoom, 0);
Heat.updateShipHeat(templateShipB, 0.2, templateTelemetryRoom, 0);
assert((templateTelemetryRoom._roomTelemetry?.heatTopologySharedShips || 0) >= 2, "shared template topology is reported per ship");
assert((templateTelemetryRoom._roomTelemetry?.heatTopologyCacheHits || 0) >= 2, "template topology cache hits are reported");
assert.strictEqual(templateTelemetryRoom._roomTelemetry?.heatTransferObjectsAllocated || 0, 0, "canonical template solve allocates no transfer objects");

// Reach a stable boundary through the public cadence, then exercise wake-up
// through a real producer.  A stable runtime cannot simultaneously retain Heat;
// the old test forced that impossible internal state and therefore did not test
// a reachable gameplay sequence.
const radiatorWake = makeShip([m("reactor", 0, 0), m("frame", 2, 0), m("radiator", 3, 0)]);
// A destroyed reactor keeps the ship's passive-source cadence alive while its
// Power output is no longer loaded, making the no-retained-Heat sleep boundary
// reachable for a ship that still has a radiator component.
detonateComponent(null, radiatorWake, 0, 0, 0, 0);
Heat.addComponentHeat(radiatorWake, 2, 12);
for (let step = 0; step < 40 && !radiatorWake._thermalRuntime.stable; step += 1) {
  Heat.updateShipHeat(radiatorWake, 0.2, {}, step * 0.2);
}
assert.strictEqual(radiatorWake._thermalRuntime.stable, true, "radiator fixture reaches stable sleep through cadence");
assert.strictEqual(radiatorWake._thermalRuntime.heatBearingComponents.length, 0, "stable radiator fixture has no retained Heat");
radiatorWake.componentPower.byComponentIndex[2].operationalMultiplier = 0;
reallocateShipPower(radiatorWake, "phase-6a-radiator-power-wake");
assert.strictEqual(radiatorWake._thermalRuntime.stable, true, "radiator Power change does not fake-wake a cold stable ship");
Heat.addComponentHeat(radiatorWake, 1, 12);
assert.strictEqual(radiatorWake._thermalRuntime.stable, false, "radiator Heat input wakes a reachable sleeping ship");

console.log(`Phase 6A Heat runtime verifier passed: boundary parity, ${randomizedSoakBoundaries} randomized soak boundaries, real lifecycle/producers, routing, telemetry, meltdown, and topology sharing.`);
