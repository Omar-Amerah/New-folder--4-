"use strict";
const assert = require("assert");
const HeatRules = require("./public/src/shared/heatRules");
const heat = require("./src/server/heat");
const health = require("./src/server/componentHealth");
const movement = require("./src/server/movement");
const combat = require("./src/server/combat");
const { computeStats } = require("./src/server/shipStats");

const S = HeatRules.STATE;
assert.strictEqual(HeatRules.activeOutputForState(S.WARM), 1, "Warm active output remains 1");
assert.strictEqual(HeatRules.activeOutputForState(S.HOT), 0.70, "Hot active output is 0.70");
assert.strictEqual(HeatRules.activeOutputForState(S.CRITICAL), 0.40, "Critical active output is 0.40");
assert.strictEqual(HeatRules.activeOutputForState(S.OVERHEATED), 0, "Overheated active output is 0");
assert.strictEqual(HeatRules.passiveProtectionForState(S.HOT), 0.85, "Hot passive protection is 0.85");
assert.strictEqual(HeatRules.activeCoolingForState(S.OVERHEATED), 0, "Overheated active cooling is 0");
assert.strictEqual(Number(HeatRules.structuralDamageMultiplierForState(S.OVERHEATED).toFixed(2)), 1.60, "Overheated structure takes x1.60");

function shipFor(design, id="s", ownerId="a") { const ship={ id, ownerId, design, x:500,y:500, angle:0, alive:true, shield:0, vx:0, vy:0, radius:30 }; ship.stats={...computeStats(design)}; ship.maxShield=ship.stats.maxShield||0; health.initComponentState(ship); heat.initShipHeat(ship); ship.weaponCooldowns=design.map(()=>0); ship.weaponAngles=design.map(()=>0); ship.weaponDesiredAngles=[]; ship.weaponAimTargetIds=[]; ship.weaponFireTargetIds=[]; ship.beamEffectsAt=[]; return ship; }
function roomFor(ships){ return { world:{width:2000,height:2000}, effects:[], bullets:[], missiles:[], players:new Map([["a",{id:"a",team:"a",ships:ships.filter(s=>s.ownerId==="a")}],["b",{id:"b",team:"b",ships:ships.filter(s=>s.ownerId==="b")}]]), rngState:1, safeZones:[], asteroids:[], rules:{} }; }

// Active output: overheated weapons cannot fire and generate no firing heat.
let shooter=shipFor([{x:7,y:7,type:"core"},{x:7,y:6,type:"blaster"}],"w","a"); let target=shipFor([{x:7,y:7,type:"core"},{x:7,y:6,type:"frame"}],"t","b"); target.x=700; shooter.componentHeatState[1]=S.OVERHEATED; combat.updateShipWeapons(roomFor([shooter,target]), shooter, [shooter,target], 1, 1000); assert.strictEqual(shooter.componentHeatInput[1],0,"overheated weapon adds no firing heat"); assert.strictEqual(shooter.weaponCooldowns[1],0,"overheated weapon consumes no cooldown");

// Projectile activity combines Power and local thermal performance once each.
const fullPower = shipFor([{x:7,y:7,type:"core"},{x:7,y:6,type:"blaster"}],"full","a");
const halfPower = shipFor([{x:7,y:7,type:"core"},{x:7,y:6,type:"blaster"}],"half","a");
for (const ship of [fullPower, halfPower]) ship.componentPower = { byComponentIndex: [{ operationalMultiplier: 1 }, { operationalMultiplier: ship === halfPower ? 0.5 : 1 }] };
const weaponTarget = shipFor([{x:7,y:7,type:"core"},{x:7,y:6,type:"frame"}],"weapon-target","b"); weaponTarget.x = 700;
combat.updateShipWeapons(roomFor([fullPower,weaponTarget]), fullPower, [fullPower,weaponTarget], 1, 1000);
combat.updateShipWeapons(roomFor([halfPower,weaponTarget]), halfPower, [halfPower,weaponTarget], 1, 1000);
assert(fullPower.weaponCooldowns[1] > 0, "powered cool projectile weapon fires");
assert(Math.abs(halfPower.weaponCooldowns[1] / fullPower.weaponCooldowns[1] - 2) < 0.01, "50% Power halves projectile activity rather than squaring Power");

// Active output: shield regeneration heat matches actual shield restored, not nominal overfill.
let shieldShip=shipFor([{x:7,y:7,type:"core"},{x:7,y:6,type:"shieldGenerator"}],"sg","a"); shieldShip.shield=shieldShip.maxShield-0.05; movement.updateShipMovement(roomFor([shieldShip]), shieldShip, [], 1); assert(shieldShip.componentHeatInput[1] <= 0.05*0.7 + 1e-9, "shield heat corresponds to actual regeneration");

// Utility bonuses use active output.
let utility={ design:[{type:"targetingComputer"},{type:"fireControl"},{type:"sensorArray"},{type:"captureModule"}], componentHp:[1,1,1,1], componentHeatState:[S.OVERHEATED,S.HOT,S.CRITICAL,S.NORMAL] };
assert.strictEqual(heat.effectiveComponentBonus(utility,"accuracyBonus"),0,"overheated targeting module removes its utility bonus");
assert(heat.effectiveComponentBonus(utility,"fireRateBonus") > 0, "hot fire-control utility bonus is partially active");

// Armour uses passive protection; frames/passive structure use structural damage effects.
let armor=shipFor([{x:7,y:7,type:"armor"},{x:7,y:9,type:"core"}],"ar","a"); armor.componentHeatState[0]=S.OVERHEATED; const hp0=armor.componentHp[0]; health.applyHullDamage(null, armor, 20, 0, 500, 0); assert(hp0-armor.componentHp[0] > 0, "overheated armour keeps partial protection but takes damage");
let frame=shipFor([{x:7,y:7,type:"frame"},{x:7,y:9,type:"core"}],"fr","a"); frame.componentHeatState[0]=S.OVERHEATED; const before=frame.componentHp[0]; health.applyHullDamage(null, frame, 10, 0, 500, 0); assert(Math.abs((before-frame.componentHp[0]) - 16) < 0.01, "frame structural damage multiplier applies once");

// Radiators use active cooling.
let rad=shipFor([{x:7,y:7,type:"radiator"}],"r","a"); rad.componentHeat[0]=60; rad.componentHeatState[0]=S.OVERHEATED; rad.hasActiveHeat=true; heat.updateShipHeat(rad,0.25,roomFor([rad]),1000); assert(rad.componentHeatRemoved[0] > 0 && rad.componentHeatRemoved[0] < 10, "overheated radiator falls back to passive floor cooling");

console.log("heat effects verification passed");
