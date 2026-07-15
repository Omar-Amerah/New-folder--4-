"use strict";
const assert = require("assert");
const HeatRules = require("./public/src/shared/heatRules");
const { initShipHeat, updateShipHeat } = require("./src/server/heat");
const { PARTS } = require("./src/server/components");
function shipFor(design){ const hp=design.map(m=>PARTS[m.type]?.hp||40); const ship={alive:true,design,componentHp:hp.slice(),componentMaxHp:hp.slice(),stats:{powerUse:0,powerGeneration:1},dirtyComponents:new Set()}; initShipHeat(ship); return ship; }
function coolOnce(s,i,heat,state=HeatRules.STATE.NORMAL){ s.componentHeat[i]=heat; s.componentHeatState[i]=state; s.hasActiveHeat=true; updateShipHeat(s,0.2); return s.componentHeatRemoved[i]; }
let tiny=shipFor([{x:0,y:0,type:"radiator"}]); assert(coolOnce(tiny,0,0.01)<=0.01+1e-9,"cooling never removes more heat than exists");
let normal=shipFor([{x:0,y:0,type:"blaster"}]); const low=coolOnce(normal,0,20); const high=coolOnce(normal,0,70); assert(high>low,"passive cooling follows temperature-factor rule");
let exposed=shipFor([{x:0,y:0,type:"blaster"}]); let enclosed=shipFor([{x:0,y:0,type:"blaster"},...[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]].map(([x,y])=>({x,y,type:"frame"}))]); assert.strictEqual(enclosed.componentThermals[0].exposedEdges,0,"sealed component has no exterior exposure"); enclosed.componentAdjacency[0].forEach(e=>e.conductivity=0); assert(coolOnce(exposed,0,50)>coolOnce(enclosed,0,50),"exposed normal components get bonus");
let rad=shipFor([{x:0,y:0,type:"radiator"}]); let box=shipFor([{x:0,y:0,type:"radiator"},...[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]].map(([x,y])=>({x,y,type:"frame"}))]); box.componentAdjacency[0].forEach(e=>e.conductivity=0); assert(coolOnce(rad,0,80)>coolOnce(box,0,80)*2,"exposed radiators use higher effectiveness than enclosed penalty");
let over=shipFor([{x:0,y:0,type:"radiator"}]); assert(coolOnce(over,0,80,HeatRules.STATE.OVERHEATED) < coolOnce(rad,0,80,HeatRules.STATE.NORMAL),"overheated radiators retain only passive floor");
let dead=shipFor([{x:0,y:0,type:"radiator"}]); dead.componentHp[0]=0; const removed=coolOnce(dead,0,80); assert(removed>0 && removed < coolOnce(rad,0,80),"destroyed radiators do not provide active cooling");
for(const [ratio,prev,expected] of [[0.419,0,0],[0.42,0,1],[0.68,0,2],[0.86,0,3],[1,0,4],[0.62,4,4],[0.619,4,1]]) assert.strictEqual(HeatRules.stateFor(ratio,prev),expected,`state boundary ${ratio}`);
let cap=shipFor([{x:0,y:0,type:"repairBeam"},{x:0,y:1,type:"heatSink"},{x:1,y:0,type:"heatSink"}]); const expected=HeatRules.profile("repairBeam",PARTS.repairBeam).capacity+HeatRules.profile("heatSink",PARTS.heatSink).capacity*2+70; assert.strictEqual(cap.maxHeat,expected,"capacities counted once with unique adjacent sink bonuses"); cap.componentHp[1]=0; cap.componentHeat[1]=50; cap.hasActiveHeat=true; updateShipHeat(cap,0.2); assert(cap.maxHeat < expected && cap.componentHeat[1]>0,"destroyed components are excluded from aggregate capacity but retain stored heat");
let net=shipFor([{x:0,y:0,type:"frame"},{x:1,y:0,type:"radiator"},{x:0,y:1,type:"heatSink"}]); net.componentHeat=[80,80,80]; net.hasActiveHeat=true; updateShipHeat(net,0.2); const n=net.thermalNetworks[0]; assert(n.totalCooling <= net.componentHeatRemoved[1]+net.componentHeatRemoved[2]+1e-9,"network summaries do not count cooling twice");
console.log("Heat cooling verification passed");
