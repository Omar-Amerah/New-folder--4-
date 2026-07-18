"use strict";
const assert = require("assert");
const WiringRules = require("./public/src/shared/wiringRules");
const ShieldRules = require("./public/src/shared/shieldRules");
const HeatRules = require("./public/src/shared/heatRules");
const { PARTS } = require("./src/server/components");
const { initComponentState } = require("./src/server/componentHealth");
const { initShipHeat } = require("./src/server/heat");
const { computeStats } = require("./src/server/shipStats");
const { rebuildShipWiringState, effectiveShieldStats } = require("./src/server/componentPower");
const at = (type, x, y) => ({ type, x, y, rotation: 0 });
function wiringFor(design, paths) { let wiring = WiringRules.emptyWiring(); for (const path of paths) wiring = WiringRules.addConnection(wiring, "power", path[0], path[1], path[2], design, PARTS); return wiring; }
function shipFor(design, paths = []) { const ship = { design, wiring: wiringFor(design, paths), stats: computeStats(design), shield: 0, alive: true }; initComponentState(ship); initShipHeat(ship); rebuildShipWiringState(ship, "test"); return ship; }
function close(a, b, msg) { assert(Math.abs(a - b) < 1e-9, `${msg}: ${a} !== ${b}`); }
const one = shipFor([at("reactor",0,0), at("shield",1,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]);
close(effectiveShieldStats(one).capacity, PARTS.shield.shield, "one shield capacity");
close(effectiveShieldStats(one).recharge, PARTS.shield.shieldRegen, "one shield regen");
const fourDesign = [at("reactor",0,0), at("reactor",0,1), at("shield",1,0), at("shield",2,0), at("shield",3,0), at("shield",4,0)];
const four = shipFor(fourDesign, [[0,2,[{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:3,y:0},{x:4,y:0}]], [1,2,[{x:0,y:1},{x:1,y:0},{x:2,y:0},{x:3,y:0},{x:4,y:0}]]]);
close(effectiveShieldStats(four).recharge, ShieldRules.effectiveStackedValue([2,3,4,5].map(i => PARTS.shield.shieldRegen * four.componentPower.byComponentIndex[i].operationalMultiplier)), "four module diminishing regen");
const weak = shipFor([at("auxGenerator",0,0), at("shield",1,0), at("shield",2,0)], [[0,1,[{x:0,y:0},{x:1,y:0},{x:2,y:0}]]]);
const mult = PARTS.auxGenerator.powerGeneration / (PARTS.shield.powerUse * 2);
close(effectiveShieldStats(weak).capacity, PARTS.shield.shield * mult * 2, "partially powered capacity");
weak.componentHeatState[1] = HeatRules.STATE.HOT;
close(effectiveShieldStats(weak).capacity, PARTS.shield.shield * mult * 2, "capacity ignores Heat state");
close(effectiveShieldStats(weak).recharge, ShieldRules.effectiveStackedValue([PARTS.shield.shieldRegen * mult * HeatRules.activeOutputForState(HeatRules.STATE.HOT), PARTS.shield.shieldRegen * mult]), "regen responds to Heat state");
weak.componentHp[2] = 0;
close(effectiveShieldStats(weak).capacity, PARTS.shield.shield * mult, "destroyed capacity removed");
const designer = ShieldRules.calculateShieldStats(weak.design, PARTS, { isLive: i => (weak.componentHp[i] ?? 1) > 0, powerMultiplier: i => weak.componentPower.byComponentIndex[i].operationalMultiplier, heatMultiplier: i => HeatRules.activeOutputForState(weak.componentHeatState[i] || 0) });
close(designer.capacity, effectiveShieldStats(weak).capacity, "designer/runtime capacity parity");
close(designer.recharge, effectiveShieldStats(weak).recharge, "designer/runtime regen parity");
console.log("Shield rules verification passed.");
