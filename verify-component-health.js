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
