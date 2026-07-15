"use strict";
const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const health = require("./src/server/componentHealth");
const heat = require("./src/server/heat");
const HeatRules = require("./public/src/shared/heatRules");
function shipFor(design){ const ship={ id:"m", ownerId:"a", design, x:0,y:0,angle:0,alive:true, shield:0, radius:30 }; ship.stats={...computeStats(design)}; ship.maxShield=ship.stats.maxShield||0; health.initComponentState(ship); heat.initShipHeat(ship); return ship; }
function overheat(ship,i){ ship.componentHeat[i]=ship.componentThermals[i].capacity*1.1; ship.componentHeatState[i]=HeatRules.STATE.OVERHEATED; }
function tick(room, ship, dt=0.25, now=1000){ ship.heatAccumulator=0; heat.updateShipHeat(ship, dt, room, now); }
function sustain(room, ship, indices, seconds, startNow=1000){ for(let t=0;t<seconds;t+=0.25){ for (const i of indices) overheat(ship,i); tick(room,ship,0.25,startNow+t*1000); } }
let non=shipFor([{x:7,y:7,type:"core"},{x:6,y:7,type:"blaster"}]); overheat(non,1); sustain({effects:[]}, non, [1], HeatRules.REACTOR_MELTDOWN_SECONDS+1); assert(non.componentHp[1]>0,"only generators are meltdown eligible");
let s=shipFor([{x:7,y:7,type:"core"},{x:6,y:7,type:"reactor"},{x:8,y:7,type:"reactor"},{x:6,y:8,type:"frame"}]); let room={effects:[], players:[]}; sustain(room,s,[1],HeatRules.REACTOR_MELTDOWN_SECONDS-0.5,1000); assert(s.componentHp[1]>0,"reactor must remain overheated for full delay"); s.componentHeat[1]=0; s.componentHeatState[1]=HeatRules.STATE.NORMAL; tick(room,s,0.25,2000); assert(s.componentMeltdown[1] < HeatRules.REACTOR_MELTDOWN_SECONDS-0.5,"recovery reduces timer");
sustain(room,s,[1,2],HeatRules.REACTOR_MELTDOWN_SECONDS+0.25,3000); assert.strictEqual(s.componentHp[1],0,"first reactor detonates and is destroyed"); assert.strictEqual(s.componentHp[2],0,"same-tick second reactor detonates deterministically"); const booms=room.effects.filter(e=>e.type==="boom").length; assert.strictEqual(booms,2,"one effect per detonation"); sustain(room,s,[1,2],HeatRules.REACTOR_MELTDOWN_SECONDS+0.25,4000); assert.strictEqual(room.effects.filter(e=>e.type==="boom").length,booms,"destroyed reactors cannot tick or detonate twice");
health.repairShipComponents(null,s,s.componentMaxHp[1],5000); assert(s.componentHp[1]>0,"repaired reactor restores hp"); assert.strictEqual(s.componentMeltdown[1],0,"repaired reactors follow reset timer policy after detonation");
console.log("meltdown verification passed");
