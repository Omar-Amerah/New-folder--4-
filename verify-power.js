"use strict";
const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState, repairShipComponents } = require("./src/server/componentHealth");
const { initShipHeat, updateShipHeat, STATE } = require("./src/server/heat");
const HeatRules = require("./public/src/shared/heatRules");

function shipFor(design){ const ship={ id:"p", design, x:0,y:0,angle:0,alive:true, shield:0 }; ship.stats={...computeStats(design)}; ship.maxShield=ship.stats.maxShield||0; initComponentState(ship); initShipHeat(ship); return ship; }
function tick(ship, seconds=0.25){ ship.heatAccumulator=0; updateShipHeat(ship, seconds, { effects:[] }, 1000); }

// Nominal generation/use and finite static underpower efficiency are stat-level aggregates.
let base=shipFor([{x:7,y:7,type:"core"},{x:6,y:7,type:"reactor"},{x:8,y:7,type:"auxGenerator"},{x:7,y:6,type:"blaster"}]);
assert(base.stats.powerGeneration > 0, "nominal power generation is present");
assert(base.stats.powerUse > 0, "nominal power use is present");
assert(Number.isFinite(base.stats.efficiency), "static underpower efficiency remains finite");

// Several generators are weighted by nominal output; one overheated reactor is not hidden by an unweighted average.
let weighted=shipFor([{x:7,y:7,type:"core"},{x:6,y:7,type:"reactor"},{x:8,y:7,type:"auxGenerator"},{x:7,y:6,type:"blaster"}]);
const reactorIndex=1, auxIndex=2;
weighted.componentHeat[reactorIndex]=weighted.componentThermals[reactorIndex].capacity*1.05;
weighted.componentHeatState[reactorIndex]=STATE.OVERHEATED;
weighted.componentHeatState[auxIndex]=STATE.NORMAL;
tick(weighted);
const nominal = weighted.design.reduce((sum,m,i)=>sum+((weighted.componentHp[i]>0?require("./src/server/components").PARTS[m.type].powerGeneration:0)||0),0);
const parts = require("./src/server/components").PARTS;
const available = weighted.design.reduce((sum,m,i)=>sum+((weighted.componentHp[i]>0?(parts[m.type].powerGeneration||0):0)*HeatRules.activeOutputForState(weighted.componentHeatState[i])),0);
assert(Math.abs(weighted.thermalPowerFactor - available/nominal) < 1e-9, "thermalPowerFactor is nominal-generation weighted");
assert(weighted.thermalPowerFactor < 0.5, "overheated main reactor cannot be hidden by a small normal generator");

// Destroyed generator removal and repaired restoration.
const beforeGen=weighted.stats.powerGeneration;
weighted.componentHp[reactorIndex]=0;
require("./src/server/componentHealth").recalcEffectiveStats(weighted);
tick(weighted);
assert(weighted.stats.powerGeneration < beforeGen, "destroyed reactor is removed from nominal generation");
assert(weighted.thermalPowerFactor <= 1 && Number.isFinite(weighted.thermalPowerFactor), "available power remains finite after destruction");
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
thermalPower.componentHeat[1] = thermalPower.componentThermals[1].capacity * 1.1;
thermalPower.hasActiveHeat = true;
tick(thermalPower);
assert.strictEqual(reallocations, 1, "reactor thermal-state transition reallocates Power once");
tick(thermalPower);
assert.strictEqual(reallocations, 1, "repeating same thermal source state does not reallocate again");
powerModule.reallocateShipPower = originalReallocate;
