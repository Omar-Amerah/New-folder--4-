"use strict";
const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const health = require("./src/server/componentHealth");
const heat = require("./src/server/heat");
function shipFor(design){ const ship={ id:"c", design, x:0,y:0,angle:0,alive:true, shield:0 }; ship.stats={...computeStats(design)}; ship.maxShield=ship.stats.maxShield||0; health.initComponentState(ship); heat.initShipHeat(ship); ship.weaponCooldowns=design.map(()=>0); return ship; }
const design=[{x:7,y:7,type:"core"},{x:6,y:7,type:"frame"},{x:5,y:7,type:"heatPipe"},{x:4,y:7,type:"radiator"},{x:8,y:7,type:"heatSink"},{x:7,y:6,type:"reactor"},{x:7,y:8,type:"engine"},{x:6,y:8,type:"blaster"}];
const ship=shipFor(design);
for (let i=1;i<design.length;i++) {
  const genBefore=ship.stats.powerGeneration, thrustBefore=ship.stats.thrust, coolBuilds=ship.thermalNetworkBuilds;
  const heatBefore=ship.componentHeat[i]=42;
  ship.componentHp[i]=0; health.recalcEffectiveStats(ship); if (heat.isThermalRouteType(design[i].type)) heat.rebuildThermalNetworks(ship);
  assert.strictEqual(ship.componentHeat[i], heatBefore, "destroyed components retain stored heat policy");
  if (design[i].type==="reactor") assert(ship.stats.powerGeneration < genBefore, "destroyed reactor disables generation");
  if (design[i].type==="engine") assert(ship.stats.thrust < thrustBefore, "destroyed engine disables thrust");
  if (design[i].type==="radiator") assert((ship.componentHp[i]??0)<=0, "destroyed radiator disables active cooling through hp state");
  if (design[i].type==="heatPipe" || design[i].type==="frame") assert(ship.thermalNetworkBuilds>coolBuilds, "destroyed thermal route rebuilds networks");
  const cooldownBefore=ship.weaponCooldowns[7];
  health.repairShipComponents(null, ship, ship.componentMaxHp[i], 3000+i);
  assert(ship.componentHp[i]>0, `repaired ${design[i].type} is alive`);
  assert.strictEqual(ship.weaponCooldowns[7], cooldownBefore, "repair does not grant weapons an extra shot");
}
ship.alive=false;
const hpBefore=ship.componentHp[7];
health.repairShipComponents(null, ship, 99999, 9000);
assert.strictEqual(ship.alive, false, "repair does not resurrect a destroyed ship");
assert(ship.componentHp[7]>=hpBefore, "dead wreck hp can be repaired without flipping alive state");
console.log("component health verification passed");

// Runtime exposure rebuilds for every alive/destroyed boundary, batched once.
function coolingAfterOneTick(s, index) {
  s.heatAccumulator = 0;
  s.componentHeat.fill(0);
  s.componentHeat[index] = 100;
  s.componentHeatState.fill(heat.STATE.NORMAL);
  s.componentPower = { byComponentIndex: s.design.map(() => ({ operationalMultiplier: 1 })) };
  s.hasActiveHeat = true;
  heat.updateShipHeat(s, 0.2, { effects: [] }, 5000);
  return s.componentHeatRadiated[index];
}
const enclosedDesign = [
  {x:7,y:7,type:"radiator"},
  {x:6,y:7,type:"armor"},{x:8,y:7,type:"armor"},{x:7,y:6,type:"armor"},{x:7,y:8,type:"armor"}
];
const enclosedShip = shipFor(enclosedDesign);
assert.strictEqual(enclosedShip.componentThermals[0].exposedEdges, 0, "radiator starts enclosed by armour");
const enclosedCooling = coolingAfterOneTick(enclosedShip, 0);
health.beginComponentLifecycleBatch(enclosedShip);
enclosedShip.componentHp[1] = 0;
enclosedShip.dirtyComponents.add(1);
health.requestComponentLifecycleRefresh(enclosedShip, { exposure: true, thermalCapacity: true, wiringTopology: true });
health.endComponentLifecycleBatch(enclosedShip);
assert(enclosedShip.componentThermals[0].exposedEdges > 0, "destroying sealing armour exposes the radiator during flush");
const exposedCooling = coolingAfterOneTick(enclosedShip, 0);
assert(exposedCooling > enclosedCooling, `radiator uses exposed cooling immediately after armour destruction (${enclosedCooling} -> ${exposedCooling})`);
health.repairShipComponents(null, enclosedShip, enclosedShip.componentMaxHp[1], 6000);
assert.strictEqual(enclosedShip.componentThermals[0].exposedEdges, 0, "repairing sealing armour encloses the radiator during flush");
const repairedCooling = coolingAfterOneTick(enclosedShip, 0);
assert(repairedCooling < exposedCooling, "radiator returns to enclosed cooling after armour repair");

const nonFrameExposure = shipFor([{x:7,y:7,type:"radiator"},{x:6,y:7,type:"armor"},{x:8,y:7,type:"armor"},{x:7,y:6,type:"armor"},{x:7,y:8,type:"armor"}]);
const buildsBeforeArmor = nonFrameExposure.heatExposureBuilds || 0;
nonFrameExposure.componentHp[1] = 0;
health.requestComponentLifecycleRefresh(nonFrameExposure, { exposure: true });
assert(nonFrameExposure.heatExposureBuilds > buildsBeforeArmor, "non-frame destruction requested an exposure rebuild");
assert(nonFrameExposure.componentThermals[0].exposedEdges > 0, "non-frame destruction can expose another component");

const originalExposureRebuild = heat.rebuildRuntimeExposure;
let exposureCalls = 0;
heat.rebuildRuntimeExposure = function countedExposureRebuild(s) { exposureCalls += 1; return originalExposureRebuild(s); };
const batchDeath = shipFor([{x:7,y:7,type:"radiator"},{x:6,y:7,type:"armor"},{x:8,y:7,type:"engine"},{x:7,y:6,type:"heatPipe"},{x:7,y:8,type:"frame"}]);
health.beginComponentLifecycleBatch(batchDeath);
for (const idx of [1,2,3]) { batchDeath.componentHp[idx] = 0; health.requestComponentLifecycleRefresh(batchDeath, { exposure: true, thermalRoutes: heat.isThermalRouteType(batchDeath.design[idx].type), wiringTopology: true }); }
health.endComponentLifecycleBatch(batchDeath);
assert.strictEqual(exposureCalls, 1, "batched component destruction performs one exposure rebuild");
exposureCalls = 0;
health.beginComponentLifecycleBatch(batchDeath);
for (const idx of [1,2,3]) { batchDeath.componentHp[idx] = batchDeath.componentMaxHp[idx]; health.requestComponentLifecycleRefresh(batchDeath, { exposure: true, thermalRoutes: heat.isThermalRouteType(batchDeath.design[idx].type), wiringTopology: true }); }
health.endComponentLifecycleBatch(batchDeath);
assert.strictEqual(exposureCalls, 1, "batched component repair performs one exposure rebuild");
exposureCalls = 0;
const pipeLifecycle = shipFor([{x:7,y:7,type:"radiator"},{x:6,y:7,type:"heatPipe"},{x:8,y:7,type:"armor"},{x:7,y:6,type:"armor"},{x:7,y:8,type:"armor"}]);
pipeLifecycle.componentHp[1] = 0;
health.requestComponentLifecycleRefresh(pipeLifecycle, { exposure: true, thermalRoutes: true });
pipeLifecycle.componentHp[1] = pipeLifecycle.componentMaxHp[1];
health.requestComponentLifecycleRefresh(pipeLifecycle, { exposure: true, thermalRoutes: true });
assert.strictEqual(exposureCalls, 2, "heat-pipe death and revival request exposure rebuilding");
heat.rebuildRuntimeExposure = originalExposureRebuild;
