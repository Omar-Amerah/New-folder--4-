#!/usr/bin/env node
"use strict";
const assert = require("assert");
const { PARTS } = require("./src/server/components");
const W = require("./public/src/shared/wiringRules");
const D = require("./public/src/shared/dataSupportRules");
const HeatRules = require("./public/src/shared/heatRules");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState, repairShipComponents, detonateComponent } = require("./src/server/componentHealth");
const { initShipHeat, updateShipHeat, addComponentHeat, STATE } = require("./src/server/heat");
const { rebuildShipWiringState, applyShipPowerAllocation } = require("./src/server/componentPower");
const Data = require("./src/server/componentData");
const { updateShipWeapons } = require("./src/server/combat");
const close = (a,b,m,e=1e-7)=>assert(Math.abs(a-b)<e, `${m}: ${a} !== ${b}`);
const mod=(type,x,y,rotation=0)=>({type,x,y,rotation});
const budget=(type)=>D.nominalSupportBudget(type, PARTS);
const snap=(v)=>JSON.stringify(v);
function wiring(design, dataPaths=[], powerPaths=[]) { let w=W.emptyWiring(); for (const p of dataPaths) w=W.addPath(w,"data",p,design,PARTS); for (const p of powerPaths) w=W.addPath(w,"power",p,design,PARTS); return w; }
function ship(design, dataPaths=[], powerPaths=[]) { const s={id:"s",ownerId:"p1",alive:true,x:0,y:0,vx:0,vy:0,angle:0,radius:30,stats:computeStats(design),design,wiring:wiring(design,dataPaths,powerPaths)}; initComponentState(s); initShipHeat(s); rebuildShipWiringState(s,"test",{skipRuntimeStats:true}); s.weaponCooldowns=design.map(()=>0); s.weaponAngles=design.map(()=>0); return s; }
function revisions(s){return [s.runtimeDataSupport.topologyRevision,s.runtimeDataSupport.allocationRevision];}
function room(){return {effects:[],bullets:[],map:{asteroids:[]},rules:{gameMode:"solo"},players:new Map([["p1",{id:"p1",team:"a"}],["p2",{id:"p2",team:"b"}]]),ships:new Map(),combatRandom:()=>0.5};}
function enemyAt(x){const e={id:"e",ownerId:"p2",alive:true,x,y:0,vx:0,vy:0,angle:Math.PI,radius:30,shield:0,maxShield:0,stats:computeStats([mod("frame",7,7)]),design:[mod("frame",7,7)]}; initComponentState(e); initShipHeat(e); return e;}
function destroy(s,i){const ok=detonateComponent(null,s,i,0,0,1000+i); assert(ok,`detonate ${i}`);}
function repairOne(s,i){repairShipComponents(null,s,(s.componentMaxHp[i]||1)+1,2000+i); assert(s.componentHp[i]>0,`repair ${i}`);}
function forcePowered(s){ s.componentPower={byComponentIndex:s.design.map(()=>({state:"powered",operationalMultiplier:1}))}; Data.refreshShipDataAllocation(s,"test-force-power"); return s; }
function heatTo(s,i,ratio){const cap=s.componentThermals[i].capacity; addComponentHeat(s,i,Math.max(0,cap*ratio-s.componentHeat[i])+5); updateShipHeat(s,0.2,room(),3000+i); return Data.getSourceDataAllocation(s,i);}
function coolBelow(s,i,stateLimit){for(let n=0;n<240 && s.componentHeatState[i]>stateLimit;n++) updateShipHeat(s,0.2,room(),4000+n); return Data.getSourceDataAllocation(s,i);}

// No Power wiring: Data topology remains diagnostic, but authoritative Power says zero.
let s=ship([mod("fireControl",0,0),mod("railgun",1,0)], [[{x:0,y:0},{x:1,y:0}]], []);
let a=Data.getSourceDataAllocation(s,0); assert.deepEqual(a.connectedWeaponIndices,[1]); close(a.powerMultiplier,0,"no-power source multiplier"); close(a.effectiveBudget,0,"no-power budget"); assert(["unpowered","disconnected"].includes(a.status),`precise no-power status ${a.status}`); close(Data.getWeaponDataSupport(s,1).fireRateBonus,0,"no-power weapon bonus"); close(Data.getEffectiveWeaponStats(s,1).fireRate,PARTS.railgun.weapon.fireRate,"no-power weapon base stats");

// Missing runtime Power fails safely, then authoritative allocation restores output deterministically.
s=ship([mod("core",0,0),mod("fireControl",1,0),mod("railgun",2,0)], [[{x:1,y:0},{x:2,y:0}]], [[{x:0,y:0},{x:1,y:0},{x:2,y:0}]]);
delete s.componentPower; assert.doesNotThrow(()=>Data.refreshShipDataAllocation(s,"missing-power")); a=Data.getSourceDataAllocation(s,1); close(a.powerMultiplier,0,"missing power safe zero"); close(a.effectiveBudget,0,"missing power no full output"); const missingSnap=snap(a); Data.refreshShipDataAllocation(s,"missing-power-again"); assert.equal(snap(Data.getSourceDataAllocation(s,1)),missingSnap,"missing power deterministic"); applyShipPowerAllocation(s,{skipRuntimeStats:true}); a=Data.getSourceDataAllocation(s,1); close(a.powerMultiplier,s.componentPower.byComponentIndex[1].operationalMultiplier,"restored reads runtime power"); assert(a.effectiveBudget>0,"restored output resumes");

// Real partial Power allocation, allocation-only update, and no topology analysis on pure Power refresh.
s=ship([mod("auxGenerator",0,0),mod("fireControl",1,0),mod("railgun",2,0)], [[{x:1,y:0},{x:2,y:0}]], [[{x:0,y:0},{x:1,y:0},{x:2,y:0}]]);
const realPower=s.componentPower.byComponentIndex[1].operationalMultiplier; assert(realPower>0 && realPower<1,"constructed real underpower"); a=Data.getSourceDataAllocation(s,1); close(a.powerMultiplier,realPower,"source follows allocator"); close(a.effectiveBudget,budget("fireControl")*realPower,"budget follows allocator"); const topo=s.runtimeDataSupport.topologyRevision, alloc=s.runtimeDataSupport.allocationRevision; const analyzeBefore=s.wiringRevision; s.componentHeatState[0]=STATE.HOT; applyShipPowerAllocation(s,{skipRuntimeStats:true}); assert.equal(s.runtimeDataSupport.topologyRevision,topo,"power-only topology unchanged"); assert.equal(s.runtimeDataSupport.allocationRevision,alloc+1,"power-only allocation increments once"); assert.equal(s.wiringRevision,analyzeBefore,"power-only no wiring rebuild"); const alloc2=s.runtimeDataSupport.allocationRevision; Data.refreshShipDataAllocation(s,"noop"); assert.equal(s.runtimeDataSupport.allocationRevision,alloc2,"same topology/multiplier no allocation revision");

// Real Heat lifecycle: tier crossings refresh allocation without manual Data refresh; same-tier raw heat does not.
s=ship([mod("core",0,0),mod("fireControl",1,0),mod("railgun",2,0),mod("radiator",1,1)], [[{x:1,y:0},{x:2,y:0}]], [[{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:1,y:1}]]);
const heatTopo=s.runtimeDataSupport.topologyRevision; let prevAlloc=s.runtimeDataSupport.allocationRevision; for (const [ratio,state,mul,changesOutput] of [[0.5,STATE.WARM,1,false],[0.72,STATE.HOT,0.7,true],[0.9,STATE.CRITICAL,0.4,true],[1.08,STATE.OVERHEATED,0,true]]) { a=heatTo(s,1,ratio); assert.equal(s.componentHeatState[1],state,`heat tier ${state}`); close(a.thermalMultiplier,mul,`heat multiplier ${state}`); assert.equal(s.runtimeDataSupport.topologyRevision,heatTopo,"heat topology unchanged"); if (changesOutput) assert(s.runtimeDataSupport.allocationRevision>prevAlloc,`heat alloc changed ${state}`); prevAlloc=s.runtimeDataSupport.allocationRevision; }
const sameTierAlloc=s.runtimeDataSupport.allocationRevision; addComponentHeat(s,1,1); updateShipHeat(s,0.2,room(),3500); assert.equal(s.componentHeatState[1],STATE.OVERHEATED,"same tier retained"); assert.equal(s.runtimeDataSupport.allocationRevision,sameTierAlloc,"same heat tier no allocation refresh"); a=coolBelow(s,1,STATE.HOT); assert(s.componentHeatState[1]<=STATE.HOT,"cooled below overheated"); assert(s.runtimeDataSupport.allocationRevision>sameTierAlloc,"cooling tier refreshes allocation"); assert.equal(s.runtimeDataSupport.topologyRevision,heatTopo,"cooling topology unchanged");

// Real destruction and repair: source, weapon, and cable host lifecycle hooks.
s=ship([mod("core",0,0),mod("fireControl",1,0),mod("railgun",2,0)], [[{x:1,y:0},{x:2,y:0}]], [[{x:0,y:0},{x:1,y:0},{x:2,y:0}]]); const saved=snap(s.wiring), designSnap=snap(s.design), partsSnap=snap(PARTS), weaponSnap=snap(PARTS.railgun.weapon); let [t0,r0]=revisions(s); destroy(s,1); a=Data.getSourceDataAllocation(s,1); assert.equal(a.status,"destroyed"); close(a.effectiveBudget,0,"destroyed source zero"); assert(revisions(s)[0]>t0 && revisions(s)[1]>r0,"source destroy revisions"); repairOne(s,1); a=Data.getSourceDataAllocation(s,1); close(a.operationalMultiplier,1,"source repaired alive"); close(a.powerMultiplier,s.componentPower.byComponentIndex[1].operationalMultiplier,"source repair rereads power"); close(a.thermalMultiplier,HeatRules.activeOutputForState(s.componentHeatState[1]),"source repair rereads heat"); assert(Data.getWeaponDataSupport(s,2).fireRateBonus>0,"recipient regained support"); assert.equal(snap(s.wiring),saved,"saved wiring immutable"); assert.equal(snap(s.design),designSnap,"ship design immutable"); assert.equal(snap(PARTS),partsSnap,"catalogue immutable"); assert.equal(snap(PARTS.railgun.weapon),weaponSnap,"weapon profile immutable");
s=forcePowered(ship([mod("fireControl",0,0),mod("frame",1,0),mod("railgun",2,0),mod("blaster",1,1),mod("beamEmitter",1,-1)], [[{x:0,y:0},{x:1,y:0},{x:2,y:0}], [{x:1,y:0},{x:1,y:1}], [{x:1,y:0},{x:1,y:-1}]])); close(Data.getSourceDataAllocation(s,0).bonusPerWeapon,budget("fireControl")/3,"initial thirds"); destroy(s,3); assert.equal(Data.getWeaponDataSupport(s,3).status,"destroyed"); forcePowered(s); close(Data.getSourceDataAllocation(s,0).bonusPerWeapon,budget("fireControl")/2,"survivors redistributed"); repairOne(s,3); forcePowered(s); close(Data.getSourceDataAllocation(s,0).bonusPerWeapon,budget("fireControl")/3,"weapon repair split restored");
s=forcePowered(ship([mod("fireControl",0,0),mod("frame",1,0),mod("railgun",2,0),mod("blaster",3,0)], [[{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:3,y:0}]])); t0=revisions(s)[0]; destroy(s,1); close(Data.getWeaponDataSupport(s,2).fireRateBonus,0,"host destruction splits data"); assert(revisions(s)[0]>t0,"host split topology revision"); repairOne(s,1); forcePowered(s); close(Data.getSourceDataAllocation(s,0).bonusPerWeapon,budget("fireControl")/2,"host repair reconnects");

// Revision correctness and unrelated passive damage.
s=ship([mod("fireControl",0,0),mod("railgun",1,0),mod("core",0,1),mod("armor",5,5)], [[{x:0,y:0},{x:1,y:0}]], [[{x:0,y:1},{x:0,y:0},{x:1,y:0}]]); const rev=snap(revisions(s)); destroy(s,3); assert.equal(snap(revisions(s)),rev,"unrelated passive component no data revision");

// Determinism: repeat the same lifecycle sequence twice and compare derived outputs.
function sequence(){ const q=ship([mod("core",0,0),mod("fireControl",1,0),mod("frame",2,0),mod("railgun",3,0)], [[{x:1,y:0},{x:2,y:0},{x:3,y:0}]], [[{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:3,y:0}]]); const rs=[]; rs.push(revisions(q)); heatTo(q,1,0.72); rs.push(revisions(q)); destroy(q,2); rs.push(revisions(q)); repairOne(q,2); rs.push(revisions(q)); return snap({rs,src:q.runtimeDataSupport.sourceAllocations,wep:q.runtimeDataSupport.weaponBonuses,status:Data.getSourceDataAllocation(q,1).status,profile:Data.getEffectiveWeaponStats(q,3)}); }
assert.equal(sequence(),sequence(),"full lifecycle sequence deterministic");

// Combat consumes updated allocation.
s=forcePowered(ship([mod("fireControl",7,6),mod("beamEmitter",7,7)], [[{x:7,y:6},{x:7,y:7}]])); const r=room(); const e=enemyAt(220); r.ships.set(s.id,s); r.ships.set(e.id,e); const hpBefore=e.hp; updateShipWeapons(r,s,[s,e],0.5,1000); const supportedDamage=hpBefore-e.hp; assert(supportedDamage>0,"combat beam deals supported damage"); s.componentPower.byComponentIndex[0].operationalMultiplier=0; Data.refreshShipDataAllocation(s,"beam-support-lost"); e.hp=e.maxHp; const hpBeforeBase=e.hp; updateShipWeapons(r,s,[s,e],0.5,1500); const baseDamage=hpBeforeBase-e.hp; assert(baseDamage>0,"combat beam deals base damage"); assert(supportedDamage>baseDamage,"combat responds to updated source multiplier");
console.log("Data support lifecycle verification passed.");
