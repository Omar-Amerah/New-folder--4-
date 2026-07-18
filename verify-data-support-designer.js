"use strict";
const assert = require("assert");
globalThis.DataSupportRules = require("./public/src/shared/dataSupportRules.js");
globalThis.WiringRules = require("./public/src/shared/wiringRules.js");
globalThis.HeatRules = require("./public/src/shared/heatRules.js");
(async () => {
  const { PARTS: PART_STATS } = require("./src/server/components.js");
  const A = await import("./public/src/design/dataSupportAnalysis.js");
  const close = (a,b,m) => assert(Math.abs(a-b) < 1e-9, `${m}: ${a} !== ${b}`);
  const m = (type,x,y) => ({ type,x,y,rotation:0 });
  const path = (w, kind, cells, d) => globalThis.WiringRules.addPath(w, kind, cells, d, PART_STATS);
  const budget = (type) => globalThis.DataSupportRules.nominalSupportBudget(type, PART_STATS);
  const poweredPair = (sourceType="fireControl", weaponType="railgun") => {
    const d=[m("reactor",0,1),m(sourceType,0,0),m(weaponType,1,0)]; let w=globalThis.WiringRules.emptyWiring();
    w=path(w,"power",[{x:0,y:1},{x:0,y:0}],d); w=path(w,"data",[{x:0,y:0},{x:1,y:0}],d); return {d,w};
  };
  let {d,w}=poweredPair(); let r=A.analyzeDesignDataSupport(d,w,PART_STATS,{thermalLoadMode:"idle"});
  assert.equal(r.networks.length,1); assert.deepEqual(r.sources.map(s=>s.sourceIndex),[1]); assert.deepEqual(r.weapons.map(x=>x.weaponIndex),[2]);
  close(r.sources[0].nominalBudget,budget("fireControl"),"nominal catalogue budget"); close(r.sources[0].predictedPowerMultiplier,1,"power multiplier"); close(r.sources[0].predictedThermalMultiplier,1,"heat multiplier"); close(r.sources[0].effectiveBudget,budget("fireControl"),"effective budget"); close(r.sources[0].bonusPerWeapon,budget("fireControl"),"per weapon"); close(r.weapons[0].effectiveProfile.fireRate, PART_STATS.railgun.weapon.fireRate*(1+budget("fireControl")),"effective railgun fire rate");
  d=[m("reactor",1,2),m("fireControl",1,1),m("blaster",1,0),m("missile",0,1),m("pointDefense",2,1)]; w=globalThis.WiringRules.emptyWiring(); w=path(w,"power",[{x:1,y:2},{x:1,y:1}],d); w=path(w,"data",[{x:1,y:1},{x:1,y:0}],d); w=path(w,"data",[{x:1,y:1},{x:0,y:1}],d); w=path(w,"data",[{x:1,y:1},{x:2,y:1}],d); r=A.analyzeDesignDataSupport(d,w,PART_STATS,{thermalLoadMode:"idle"}); close(r.sources[0].bonusPerWeapon,budget("fireControl")/3,"third split"); assert(r.sources[0].recipientCount===3);
  d=[m("auxGenerator",0,1),m("fireControl",0,0),m("sensorArray",1,0),m("targetingComputer",2,0),m("railgun",3,0),m("auxGenerator",1,1),m("auxGenerator",2,1)]; w=globalThis.WiringRules.emptyWiring(); w=path(w,"power",[{x:0,y:1},{x:0,y:0}],d); w=path(w,"power",[{x:1,y:1},{x:1,y:0}],d); w=path(w,"power",[{x:2,y:1},{x:2,y:0}],d); w=path(w,"data",[{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:3,y:0}],d); r=A.analyzeDesignDataSupport(d,w,PART_STATS,{thermalLoadMode:"idle"}); const gun=r.weapons[0]; assert(gun.fireRateBonus > 0, "fire-rate contribution present"); assert(gun.rangeBonus > 0, "range contribution present"); assert(gun.accuracyBonus > 0, "accuracy contribution present");
  d=[m("reactor",0,1),m("fireControl",0,0),m("railgun",1,0),m("sensorArray",5,0),m("beamEmitter",6,0),m("reactor",5,1)]; w=globalThis.WiringRules.emptyWiring(); w=path(w,"power",[{x:0,y:1},{x:0,y:0}],d); w=path(w,"power",[{x:5,y:1},{x:5,y:0}],d); w=path(w,"data",[{x:0,y:0},{x:1,y:0}],d); w=path(w,"data",[{x:5,y:0},{x:6,y:0}],d); r=A.analyzeDesignDataSupport(d,w,PART_STATS,{thermalLoadMode:"idle"}); assert.equal(r.networks.length,2); assert(!r.weapons.find(x=>x.weaponIndex===2).sourceIndices.includes(3));
  d=[m("fireControl",0,0),m("railgun",1,0)]; w=globalThis.WiringRules.emptyWiring(); w=path(w,"data",[{x:0,y:0},{x:1,y:0}],d); r=A.analyzeDesignDataSupport(d,w,PART_STATS,{thermalLoadMode:"idle"}); assert.equal(r.sources[0].predictedPowerMultiplier,0); assert.equal(r.sources[0].effectiveBudget,0); assert.equal(r.sources[0].status,"unpowered"); close(r.weapons[0].effectiveProfile.fireRate,PART_STATS.railgun.weapon.fireRate,"base stats");
  d=[m("smallReactor",0,1),m("fireControl",0,0),m("heavyEngine",1,0),m("railgun",2,0)]; w=globalThis.WiringRules.emptyWiring(); w=path(w,"power",[{x:0,y:1},{x:0,y:0}],d); w=path(w,"power",[{x:0,y:1},{x:1,y:1},{x:1,y:0}],d); w=path(w,"data",[{x:0,y:0},{x:1,y:0},{x:2,y:0}],d); r=A.analyzeDesignDataSupport(d,w,PART_STATS,{thermalLoadMode:"idle"}); const p=globalThis.WiringRules.analyzeWiring(d,w,PART_STATS).power.networkByComponent.get(1).availableEfficiency; close(r.sources[0].predictedPowerMultiplier,p,"partial power matches shared analysis");
  const idle=A.analyzeDesignDataSupport(d,w,PART_STATS,{thermalLoadMode:"idle"}); const full=A.analyzeDesignDataSupport(d,w,PART_STATS,{thermalLoadMode:"full"}); assert(Number.isFinite(idle.sources[0].predictedThermalMultiplier)); assert(Number.isFinite(full.weapons[0].effectiveProfile.fireRate));
  const vul=A.analyzeDataVulnerabilities(...Object.values(poweredPair()),PART_STATS); assert(vul.some(v=>v.kind==="section"));
  console.log("Data-support designer analysis verification passed.");
})();
