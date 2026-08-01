"use strict";

const assert = require("assert");
const HeatRules = require("./public/src/shared/heatRules");
const WiringRules = require("./public/src/shared/wiringRules");
const { PARTS } = require("./src/server/components");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower, reallocateShipPower } = require("./src/server/componentPower");
const Heat = require("./src/server/heat");
const Flags = require("./src/server/performanceFlags");
const { createImmutableShipTemplate } = require("./src/server/shipTemplates");
const { spawnShip } = require("./src/server/ships");

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
  return { legacy: makeShip(design, wiring), optimized: makeShip(design, wiring) };
}

function eachShip(target, callback) {
  callback(target.legacy);
  callback(target.optimized);
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
  const legacy = target.legacy;
  const optimized = target.optimized;
  for (const field of [
    "componentHeat", "componentHeatState", "componentHeatInput", "componentHeatGenerated",
    "componentHeatReceived", "componentHeatRemoved", "componentHeatTransferredOut",
    "componentHeatCooled", "componentHeatSentThroughFrame", "componentHeatRadiated",
    "componentVentedOverflowHeatThisTick", "componentTotalVentedOverflowHeat",
    "componentPowerCableHeatRate", "componentPowerCableHeatGenerated", "componentMeltdown"
  ]) if (legacy[field] || optimized[field]) compareArrays(legacy[field] || [], optimized[field] || [], `${label} ${field}`);
  for (const field of ["currentHeat", "maxHeat", "heatPressure", "powerCableHeatGenerated", "totalVentedOverflowHeat"]) close(legacy[field], optimized[field], `${label} ${field}`, 2e-7);
  for (const field of [
    "heatAccumulator", "heatRevision", "heatStateRevision", "componentHeatRevision", "heatTelemetryRevision",
    "hotComponentCount", "overheatedComponentCount", "powerRevision", "wiringRevision"
  ]) assert.strictEqual(legacy[field] || 0, optimized[field] || 0, `${label} ${field}`);
  const legacyData = legacy.runtimeDataSupport || {};
  const optimizedData = optimized.runtimeDataSupport || {};
  for (const field of ["topologyRevision", "allocationRevision"]) assert.strictEqual(legacyData[field] || 0, optimizedData[field] || 0, `${label} data ${field}`);
  assert.deepStrictEqual([...legacy.dirtyHeat].sort((a, b) => a - b), [...optimized.dirtyHeat].sort((a, b) => a - b), `${label} dirtyHeat`);
  assert.deepStrictEqual(legacy.componentThermalNetworks, optimized.componentThermalNetworks, `${label} thermal networks`);
  assert.strictEqual(optimized._heatScratch.pendingTransfers.length, 0, `${label} optimized transfer objects`);
  assert.deepStrictEqual(optimized._thermalRuntime.heatBearingComponents, optimized._thermalRuntime.heatBearingComponents.slice().sort((a, b) => a - b), `${label} Heat list order`);
  assert.deepStrictEqual(optimized._thermalRuntime.hotComponents, optimized._thermalRuntime.hotComponents.slice().sort((a, b) => a - b), `${label} HOT list order`);
  for (const index of optimized._thermalRuntime.heatBearingComponents) assert(Number.isFinite(optimized.componentHeat[index]) && optimized.componentHeat[index] > 0, `${label} positive Heat membership`);
}

function boundary(target, dt, label, before = null) {
  if (before) { before(target.legacy); before(target.optimized); }
  Flags.__setOPTIMIZED_HEAT_RUNTIME(false);
  Heat.updateShipHeat(target.legacy, dt, null, 0);
  Flags.__setOPTIMIZED_HEAT_RUNTIME(true);
  Heat.updateShipHeat(target.optimized, dt, null, 0);
  comparePair(target, label);
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
boundary(routed, 0.2, "retained capacity", setStoredHeat(4, routed.legacy.componentThermals[4].capacity * 0.9));

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
assert(Object.isFrozen(template.thermalTopology) && Object.isFrozen(template.thermalTopology.edgeA), "template topology guarded");
const templateTelemetryRoom = {};
Flags.__setOPTIMIZED_HEAT_RUNTIME(true);
Heat.updateShipHeat(templateShipA, 0.2, templateTelemetryRoom, 0);
Heat.updateShipHeat(templateShipB, 0.2, templateTelemetryRoom, 0);
assert((templateTelemetryRoom._roomTelemetry?.heatTopologySharedShips || 0) >= 2, "shared template topology is reported per ship");
assert((templateTelemetryRoom._roomTelemetry?.heatTopologyCacheHits || 0) >= 2, "template topology cache hits are reported");
assert.strictEqual(templateTelemetryRoom._roomTelemetry?.heatTransferObjectsAllocated || 0, 0, "optimized template solve allocates no transfer objects");

Flags.__setOPTIMIZED_HEAT_RUNTIME(false);
console.log("Phase 6A Heat runtime verifier passed: boundary parity, lifecycle, routing, telemetry, meltdown, and topology sharing.");
