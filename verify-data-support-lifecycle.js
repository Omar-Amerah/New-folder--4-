#!/usr/bin/env node
"use strict";
const assert = require("assert");
const { PARTS } = require("./src/server/components");
const W = require("./public/src/shared/wiringRules");
const D = require("./public/src/shared/dataSupportRules");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState, repairShipComponents } = require("./src/server/componentHealth");
const { initShipHeat, STATE } = require("./src/server/heat");
const { rebuildShipWiringState, applyShipPowerAllocation } = require("./src/server/componentPower");
const Data = require("./src/server/componentData");
const { updateShipWeapons } = require("./src/server/combat");
const close = (a,b,m,e=1e-9)=>assert(Math.abs(a-b)<e, `${m}: ${a} !== ${b}`);
const mod=(type,x,y,rotation=0)=>({type,x,y,rotation});
const budget=(type)=>D.nominalSupportBudget(type, PARTS);
function wiring(design, dataPaths=[], powerPaths=[]) { let w=W.emptyWiring(); for (const p of dataPaths) w=W.addPath(w,"data",p,design,PARTS); for (const p of powerPaths) w=W.addPath(w,"power",p,design,PARTS); return w; }
function ship(design, dataPaths=[], powerPaths=[]) { const s={id:"s",ownerId:"p1",alive:true,x:0,y:0,vx:0,vy:0,angle:0,radius:30,stats:computeStats(design),design,wiring:wiring(design,dataPaths,powerPaths)}; initComponentState(s); initShipHeat(s); rebuildShipWiringState(s,"test",{skipRuntimeStats:true}); if (!powerPaths.length) { s.componentPower = { byComponentIndex: design.map(() => ({ state: "powered", operationalMultiplier: 1 })) }; Data.refreshShipDataAllocation(s,"test-default-power"); } s.weaponCooldowns=design.map(()=>0); s.weaponAngles=design.map(()=>0); return s; }
function destroy(s,i){s.componentHp[i]=0; rebuildShipWiringState(s,"test-destroy",{skipRuntimeStats:true});}
function revive(s,i){s.componentHp[i]=s.componentMaxHp[i]; rebuildShipWiringState(s,"test-repair",{skipRuntimeStats:true});}
function enemyAt(x){const e={id:"e",ownerId:"p2",alive:true,x,y:0,vx:0,vy:0,angle:Math.PI,radius:30,shield:0,maxShield:0,stats:computeStats([mod("frame",7,7)]),design:[mod("frame",7,7)]}; initComponentState(e); initShipHeat(e); return e;}

// Power, heat and combined source multiplier math.
let design=[mod("reactor",0,0),mod("fireControl",2,0),mod("railgun",3,0)];
let s=ship(design, [[{x:2,y:0},{x:3,y:0}]], [[{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:3,y:0}]]);
let a=Data.getSourceDataAllocation(s,1); close(a.powerMultiplier,1,"fully powered source"); close(a.thermalMultiplier,1,"normal thermal source"); close(a.effectiveBudget,budget("fireControl"),"nominal effective budget");
s.componentPower.byComponentIndex[1].operationalMultiplier=0.5; Data.refreshShipDataAllocation(s,"manual-half-power"); a=Data.getSourceDataAllocation(s,1); close(a.effectiveBudget,budget("fireControl")*0.5,"half powered budget"); close(Data.getWeaponDataSupport(s,2).fireRateBonus,budget("fireControl")*0.5,"half powered weapon share");
s.componentPower.byComponentIndex[1].operationalMultiplier=0; Data.refreshShipDataAllocation(s,"manual-unpowered"); a=Data.getSourceDataAllocation(s,1); close(a.effectiveBudget,0,"unpowered source budget"); assert.equal(a.status,"unpowered"); assert.deepEqual(a.connectedWeaponIndices,[2]); close(Data.getWeaponDataSupport(s,2).fireRateBonus,0,"unpowered weapon zero");
for (const [state,mul] of [[STATE.NORMAL,1],[STATE.WARM,1],[STATE.HOT,0.7],[STATE.CRITICAL,0.4],[STATE.OVERHEATED,0]]) { s.componentPower.byComponentIndex[1].operationalMultiplier=1; s.componentHeatState[1]=state; Data.refreshShipDataAllocation(s,"heat-tier"); a=Data.getSourceDataAllocation(s,1); close(a.thermalMultiplier,mul,"heat multiplier "+state); close(a.effectiveBudget,budget("fireControl")*mul,"heat budget "+state); }
s.componentPower.byComponentIndex[1].operationalMultiplier=0.5; s.componentHeatState[1]=STATE.HOT; Data.refreshShipDataAllocation(s,"combined"); close(Data.getSourceDataAllocation(s,1).effectiveBudget,budget("fireControl")*0.5*0.7,"combined power heat once");

// Source and weapon destruction/repair redistribution.
s=ship([mod("reactor",0,0),mod("fireControl",2,0),mod("railgun",3,0)], [[{x:2,y:0},{x:3,y:0}]], [[{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:3,y:0}]]); const blueprintSnap=JSON.stringify(s.wiring);
const top0=s.runtimeDataSupport.topologyRevision, alloc0=s.runtimeDataSupport.allocationRevision; destroy(s,1); a=Data.getSourceDataAllocation(s,1); assert.equal(a.status,"destroyed"); close(a.effectiveBudget,0,"destroyed source zero"); close(Data.getEffectiveWeaponStats(s,2).fireRate,PARTS.railgun.weapon.fireRate,"destroyed source base stats"); assert(s.runtimeDataSupport.topologyRevision>top0); assert(s.runtimeDataSupport.allocationRevision>alloc0); revive(s,1); close(Data.getWeaponDataSupport(s,2).fireRateBonus,budget("fireControl"),"repaired source resumes"); assert.equal(JSON.stringify(s.wiring),blueprintSnap,"blueprint wiring immutable");
s=ship([mod("fireControl",0,0),mod("frame",1,0),mod("railgun",2,0),mod("blaster",1,1),mod("beamEmitter",1,-1)], [[{x:0,y:0},{x:1,y:0},{x:2,y:0}], [{x:1,y:0},{x:1,y:1}], [{x:1,y:0},{x:1,y:-1}]]); close(Data.getSourceDataAllocation(s,0).bonusPerWeapon,budget("fireControl")/3,"initial thirds"); destroy(s,3); close(Data.getSourceDataAllocation(s,0).bonusPerWeapon,budget("fireControl")/2,"survivors halves"); close(Data.getWeaponDataSupport(s,3).fireRateBonus,0,"destroyed weapon no bonus"); revive(s,3); close(Data.getSourceDataAllocation(s,0).bonusPerWeapon,budget("fireControl")/3,"repair restores thirds");

// Cable-host split/merge and redundant routes.
s=ship([mod("fireControl",0,0),mod("frame",1,0),mod("railgun",2,0),mod("blaster",3,0)], [[{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:3,y:0}]]); destroy(s,1); close(Data.getWeaponDataSupport(s,2).fireRateBonus,0,"host destruction splits data"); revive(s,1); close(Data.getSourceDataAllocation(s,0).bonusPerWeapon,budget("fireControl")/2,"host repair merges data");
s=ship([mod("fireControl",0,0),mod("frame",1,0),mod("frame",0,1),mod("frame",1,1),mod("railgun",2,0)], [[{x:0,y:0},{x:1,y:0},{x:2,y:0}], [{x:0,y:0},{x:0,y:1},{x:1,y:1},{x:1,y:0},{x:2,y:0}]]); close(Data.getWeaponDataSupport(s,4).fireRateBonus,budget("fireControl"),"redundant initially supported"); destroy(s,2); close(Data.getWeaponDataSupport(s,4).fireRateBonus,budget("fireControl"),"one redundant route survives"); destroy(s,1); close(Data.getWeaponDataSupport(s,4).fireRateBonus,0,"both routes lost"); revive(s,1); close(Data.getWeaponDataSupport(s,4).fireRateBonus,budget("fireControl"),"one repaired route restores");

// Lightweight refresh revisions and multiple independent sources.
s=ship([mod("fireControl",0,0),mod("sensorArray",1,0),mod("targetingComputer",2,0),mod("railgun",3,0)], [[{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:3,y:0}]]); const t=s.runtimeDataSupport.topologyRevision; const ar=s.runtimeDataSupport.allocationRevision; s.componentPower.byComponentIndex[0].operationalMultiplier=0.5; s.componentHeatState[2]=STATE.OVERHEATED; Data.refreshShipDataAllocation(s,"lightweight"); assert.equal(s.runtimeDataSupport.topologyRevision,t,"topology unchanged on lightweight"); assert(s.runtimeDataSupport.allocationRevision>ar,"allocation revision changed"); close(Data.getWeaponDataSupport(s,3).fireRateBonus,budget("fireControl")*0.5,"independent half power"); close(Data.getWeaponDataSupport(s,3).rangeBonus,budget("sensorArray"),"independent full range"); close(Data.getWeaponDataSupport(s,3).accuracyBonus,0,"overheated targeting zero"); const ar2=s.runtimeDataSupport.allocationRevision; const serialized=JSON.stringify(s.runtimeDataSupport); Data.refreshShipDataAllocation(s,"noop"); assert.equal(s.runtimeDataSupport.allocationRevision,ar2,"noop no allocation revision"); assert.equal(JSON.stringify(s.runtimeDataSupport),serialized,"noop deterministic");
// unrelated passive component no data revision change
s=ship([mod("fireControl",0,0),mod("railgun",1,0),mod("armor",5,5)], [[{x:0,y:0},{x:1,y:0}]]); const sig=JSON.stringify([s.runtimeDataSupport.topologyRevision,s.runtimeDataSupport.allocationRevision]); destroy(s,2); assert.equal(JSON.stringify([s.runtimeDataSupport.topologyRevision,s.runtimeDataSupport.allocationRevision]),sig,"unrelated damage no data revision");
// combat response after multiplier change.
s=ship([mod("fireControl",7,6),mod("beamEmitter",7,7)], [[{x:7,y:6},{x:7,y:7}]]); let r={bullets:[],effects:[],map:{asteroids:[]},rules:{gameMode:"solo"},players:new Map([["p1",{id:"p1",team:"a"}],["p2",{id:"p2",team:"b"}]]),ships:new Map(),combatRandom:()=>0.5}; let e=enemyAt(220); r.ships.set(s.id,s); r.ships.set(e.id,e); const hpBefore=e.hp; updateShipWeapons(r,s,[s,e],0.5,1000); const supportedDamage=hpBefore-e.hp; assert(supportedDamage>0,"combat beam deals supported damage"); s.componentPower.byComponentIndex[0].operationalMultiplier=0; Data.refreshShipDataAllocation(s,"beam-support-lost"); e.hp=e.maxHp; const hpBeforeBase=e.hp; updateShipWeapons(r,s,[s,e],0.5,1500); const baseDamage=hpBeforeBase-e.hp; assert(baseDamage>0,"combat beam deals base damage"); assert(supportedDamage>baseDamage,"combat responds to updated source multiplier");
console.log("Data support lifecycle verification passed.");
