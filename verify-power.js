"use strict";
const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState, repairShipComponents } = require("./src/server/componentHealth");
const { initShipHeat, updateShipHeat, STATE } = require("./src/server/heat");
const WiringRules = require("./public/src/shared/wiringRules");
const { PARTS } = require("./src/server/components");

function wiringFor(design, paths) {
  let wiring = WiringRules.emptyWiring();
  for (const [source, target, cells] of paths) wiring = WiringRules.addConnection(wiring, "power", source, target, cells, design, PARTS);
  return wiring;
}
function shipFor(design, wiring = WiringRules.emptyWiring()){ const ship={ id:"p", design, wiring, x:0,y:0,angle:0,alive:true, shield:0 }; ship.stats={...computeStats(design)}; ship.maxShield=ship.stats.maxShield||0; initComponentState(ship); initShipHeat(ship); return ship; }
function tick(ship, seconds=0.25){ ship.heatAccumulator=0; updateShipHeat(ship, seconds, { effects:[] }, 1000); }

// Nominal generation/use and finite static underpower efficiency are stat-level aggregates.
let base=shipFor([{x:7,y:7,type:"core"},{x:6,y:7,type:"reactor"},{x:8,y:7,type:"auxGenerator"},{x:7,y:6,type:"blaster"}]);
assert(base.stats.powerGeneration > 0, "nominal power generation is present");
assert(base.stats.powerUse > 0, "nominal power use is present");
assert(Number.isFinite(base.stats.efficiency), "static underpower efficiency remains finite");

// Generator Heat states below OVERHEATED do not derate network generation.
const poweredDesign = [{x:7,y:7,type:"core"},{x:6,y:7,type:"reactor"},{x:8,y:7,type:"auxGenerator"},{x:7,y:6,type:"blaster"}];
let weighted=shipFor(poweredDesign, wiringFor(poweredDesign, [[1, 3, [{x:6,y:7},{x:7,y:7},{x:7,y:6}]], [2, 3, [{x:8,y:7},{x:7,y:7},{x:7,y:6}]]]));
const reactorIndex=1;
require("./src/server/componentPower").rebuildShipWiringState(weighted, "test");
const network = weighted.runtimeWiring.powerNetworks[0];
const nominalGeneration = network.availableGenerationMw;
for (const state of [STATE.WARM, STATE.HOT, STATE.CRITICAL]) {
  weighted.componentHeatState[reactorIndex] = state;
  require("./src/server/componentPower").reallocateShipPower(weighted, "test");
  assert.strictEqual(network.availableGenerationMw, nominalGeneration, "reactor generation remains nominal below OVERHEATED");
}
// Destroyed generator removal and repaired restoration.
const beforeGen=weighted.stats.powerGeneration;
weighted.componentHp[reactorIndex]=0;
require("./src/server/componentHealth").recalcEffectiveStats(weighted);
tick(weighted);
assert(weighted.stats.powerGeneration < beforeGen, "destroyed reactor is removed from nominal generation");
assert(Number.isFinite(weighted.runtimeWiring.powerNetworks[0].availableGenerationMw), "available power remains finite after destruction");
repairShipComponents(null, weighted, weighted.componentMaxHp[reactorIndex], 2000);
assert(weighted.componentHp[reactorIndex] > 0, "reactor repair restores component hp");
assert(weighted.stats.powerGeneration >= beforeGen - 1e-9, "repaired reactor restores nominal generation");

console.log("power verification passed");

// Heat setup snapshots source thermal tiers so the first unchanged thermal tick does not reallocate Power.
const powerModule = require("./src/server/componentPower");
const originalReallocate = powerModule.reallocateShipPower;
let reallocations = 0;
powerModule.reallocateShipPower = function countedReallocate(ship, reason) { reallocations += 1; return originalReallocate(ship, reason); };
let thermalPower = shipFor([{x:7,y:7,type:"core"},{x:6,y:7,type:"reactor"},{x:8,y:7,type:"engine"}]);
tick(thermalPower);
assert.strictEqual(reallocations, 0, "first unchanged Heat tick does not reallocate Power");
thermalPower.componentHeat[1] = thermalPower.componentThermals[1].capacity * 1.24;
thermalPower.hasActiveHeat = true;
tick(thermalPower);
assert.strictEqual(reallocations, 1, "reactor OVERHEATED transition reallocates Power once");
tick(thermalPower);
assert.strictEqual(reallocations, 1, "repeating same thermal source state does not reallocate again");
powerModule.reallocateShipPower = originalReallocate;

// OVERHEATED source shutdown changes allocation only; wiring topology is stable.
let reactorShutdown = shipFor(poweredDesign, wiringFor(poweredDesign, [[1, 3, [{x:6,y:7},{x:7,y:7},{x:7,y:6}]], [2, 3, [{x:8,y:7},{x:7,y:7},{x:7,y:6}]]]));
require("./src/server/componentPower").rebuildShipWiringState(reactorShutdown, "test");
const shutdownNet = reactorShutdown.runtimeWiring.powerNetworks[0];
const reactorMw = PARTS.reactor.powerGeneration;
const auxMw = PARTS.auxGenerator.powerGeneration;
assert.strictEqual(shutdownNet.availableGenerationMw, reactorMw + auxMw, "multi-source network starts with all nominal generation");
const wiringRevisionBeforeHeat = reactorShutdown.wiringRevision;
const topologySignatureBeforeHeat = JSON.stringify(reactorShutdown.runtimeWiring.power);
for (const state of [STATE.WARM, STATE.HOT, STATE.CRITICAL]) {
  reactorShutdown.componentHeatState[1] = state;
  require("./src/server/componentPower").reallocateShipPower(reactorShutdown, "test");
  assert.strictEqual(shutdownNet.availableGenerationMw, reactorMw + auxMw, "WARM/HOT/CRITICAL source generation is nominal");
}
reactorShutdown.componentHeat[1] = reactorShutdown.componentThermals[1].capacity * 1.24;
reactorShutdown.componentHeatState[1] = STATE.CRITICAL;
reactorShutdown._heatPowerSourceStates = reactorShutdown.componentHeatState.slice();
let boundaryReallocations = 0;
powerModule.reallocateShipPower = function countedBoundary(ship, reason) { boundaryReallocations += 1; return originalReallocate(ship, reason); };
reactorShutdown.hasActiveHeat = true;
tick(reactorShutdown);
assert.strictEqual(boundaryReallocations, 1, "entering OVERHEATED reallocates Power exactly once");
assert.strictEqual(shutdownNet.availableGenerationMw, auxMw, "only the overheated source contribution is removed");
assert.strictEqual(reactorShutdown.wiringRevision, wiringRevisionBeforeHeat, "Heat-only shutdown does not bump wiringRevision");
assert.strictEqual(JSON.stringify(reactorShutdown.runtimeWiring.power), topologySignatureBeforeHeat, "Heat-only shutdown does not rebuild wiring topology");
const revisionAfterOverheat = reactorShutdown.powerRevision;
tick(reactorShutdown);
assert.strictEqual(boundaryReallocations, 1, "repeated OVERHEATED ticks do not churn allocations");
assert.strictEqual(reactorShutdown.powerRevision, revisionAfterOverheat, "repeated OVERHEATED ticks do not bump powerRevision");
reactorShutdown.componentHeat[1] = reactorShutdown.componentThermals[1].capacity * 0.5;
reactorShutdown.hasActiveHeat = true;
tick(reactorShutdown);
assert.strictEqual(boundaryReallocations, 2, "cooling below recovery reallocates Power exactly once");
assert.strictEqual(shutdownNet.availableGenerationMw, reactorMw + auxMw, "cooling below recovery restores nominal generation");
assert.strictEqual(reactorShutdown.wiringRevision, wiringRevisionBeforeHeat, "Heat-only recovery does not bump wiringRevision");
powerModule.reallocateShipPower = originalReallocate;

let noOtherSource = shipFor([{x:7,y:7,type:"core"},{x:6,y:7,type:"reactor"},{x:7,y:6,type:"shield"}], wiringFor([{x:7,y:7,type:"core"},{x:6,y:7,type:"reactor"},{x:7,y:6,type:"shield"}], [[1, 2, [{x:6,y:7},{x:7,y:7},{x:7,y:6}]]]));
require("./src/server/componentPower").rebuildShipWiringState(noOtherSource, "test");
noOtherSource.componentHeatState[1] = STATE.OVERHEATED;
require("./src/server/componentPower").reallocateShipPower(noOtherSource, "test");
assert.strictEqual(noOtherSource.runtimeWiring.powerNetworks[0].availableGenerationMw, 0, "all-overheated source network has zero generation");
assert.strictEqual(noOtherSource.componentPower.byComponentIndex[2].operationalMultiplier, 0, "connected consumer receives multiplier 0 with no live generation");
