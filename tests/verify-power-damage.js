"use strict";

const assert = require("assert");
const WiringRules = require("./public/src/shared/wiringRules");
const { PARTS } = require("./src/server/components");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState, repairShipComponents } = require("./src/server/componentHealth");
const { initializeComponentPower, rebuildShipWiringState, getComponentPowerMultiplier } = require("./src/server/componentPower");

const at = (type, x, y) => ({ type, x, y, rotation: 0 });
function wire(design, routes, kind = "power") {
  let wiring = WiringRules.emptyWiring();
  for (const [source, target, cells] of routes) wiring = WiringRules.addConnection(wiring, kind, source, target, cells, design, PARTS);
  return wiring;
}
function shipFor(design, wiring) {
  const ship = { id: "damage-test", alive: true, design, wiring, stats: { ...computeStats(design) }, shield: 0 };
  initComponentState(ship); initializeComponentPower(ship); return ship;
}

// A passive transit component owns the two adjacent cable sections it hosts.
const transitDesign = [at("reactor", 0, 0), at("armor", 2, 0), at("frame", 3, 0), at("engine", 4, 0)];
const transitWiring = wire(transitDesign, [[0, 3, [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }]]]);
const transit = shipFor(transitDesign, transitWiring);
const blueprint = JSON.stringify(transit.wiring);
assert.equal(getComponentPowerMultiplier(transit, 3), 1);
transit.componentHp[1] = 0;
rebuildShipWiringState(transit, "test-destroy");
assert.equal(getComponentPowerMultiplier(transit, 3), 0, "destroyed passive transit breaks downstream Power");
assert.equal(transit.runtimeWiring.power.disabledSectionIds.size, 2);
assert.equal(transit.runtimeWiring.power.brokenConnectionIds.size, 1);
assert.equal(JSON.stringify(transit.wiring), blueprint, "damage never mutates blueprint wiring");
repairShipComponents(null, transit, transit.componentMaxHp[1], 1);
assert.equal(getComponentPowerMultiplier(transit, 3), 1, "positive repaired HP restores the original route");
assert.equal(transit.runtimeWiring.power.brokenConnectionIds.size, 0);

// Removing a consumer removes its demand and lets its surviving peer reach full output.
const demandDesign = [at("auxGenerator", 0, 0), at("engine", 1, 0), at("gyroscope", 0, 1)];
const demandWiring = wire(demandDesign, [
  [0, 1, [{ x: 0, y: 0 }, { x: 1, y: 0 }]],
  [0, 2, [{ x: 0, y: 0 }, { x: 0, y: 1 }]]
]);
const demand = shipFor(demandDesign, demandWiring);
assert(getComponentPowerMultiplier(demand, 1) < 1);
demand.componentHp[2] = 0;
rebuildShipWiringState(demand, "test-consumer-destroy");
assert.equal(getComponentPowerMultiplier(demand, 1), 1);
assert.equal(demand.powerAnalysis.networks[0].demandMw, PARTS.engine.powerUse);

// Independent explicit routes are evaluated independently.
const redundantDesign = [at("reactor", 0, 0), at("armor", 2, 0), at("frame", 2, 1), at("engine", 3, 0), at("frame", 1, 1), at("frame", 3, 1)];
const redundantWiring = wire(redundantDesign, [
  [0, 3, [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]],
  [0, 3, [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 0 }]]
]);
const redundant = shipFor(redundantDesign, redundantWiring);
redundant.componentHp[1] = 0;
rebuildShipWiringState(redundant, "test-redundancy");
assert.equal(redundant.runtimeWiring.power.brokenConnectionIds.size, 1);
assert.equal(redundant.runtimeWiring.power.operationalConnectionIds.size, 1);
assert.equal(getComponentPowerMultiplier(redundant, 3), 1, "one surviving route keeps consumer powered");

// Data uses the same hosting health model without interacting with Power.
const dataDesign = [at("fireControl", 0, 0), at("frame", 1, 0), at("blaster", 2, 0)];
const data = shipFor(dataDesign, wire(dataDesign, [[0, 2, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]], "data"));
data.componentHp[1] = 0;
rebuildShipWiringState(data, "test-data-destroy");
assert.equal(data.runtimeWiring.data.disabledSectionIds.size, 2);
assert.equal(data.runtimeWiring.data.brokenConnectionIds.size, 1);
assert.equal(data.runtimeWiring.dataNetworks.length, 0);

console.log("Damage-aware Power/Data wiring verification passed.");
