"use strict";
const assert = require("assert");
const WiringRules = require("./public/src/shared/wiringRules");
const ShieldRules = require("./public/src/shared/shieldRules");
const HeatRules = require("./public/src/shared/heatRules");
const { PARTS } = require("./src/server/components");
const { initComponentState } = require("./src/server/componentHealth");
const { initShipHeat, distributeComponentHeatByWeight } = require("./src/server/heat");
const { computeStats } = require("./src/server/shipStats");
const { rebuildShipWiringState, effectiveShieldStats, effectiveShieldCapacityContributions } = require("./src/server/componentPower");
const at = (type, x, y) => ({ type, x, y, rotation: 0 });
function wiringFor(design, paths) { let wiring = WiringRules.emptyWiring(); for (const path of paths) wiring = WiringRules.addConnection(wiring, "power", path[0], path[1], path[2], design, PARTS); return wiring; }
function shipFor(design, paths = []) { const ship = { design, wiring: wiringFor(design, paths), stats: computeStats(design), shield: 0, alive: true }; initComponentState(ship); initShipHeat(ship); rebuildShipWiringState(ship, "test"); return ship; }
function close(a, b, msg) { assert(Math.abs(a - b) < 0.011, `${msg}: ${a} !== ${b}`); }
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
const contributions = effectiveShieldCapacityContributions(weak);
close(contributions.reduce((sum, contribution) => sum + contribution.capacity, 0), effectiveShieldStats(weak).capacity, "runtime contributions sum to effective capacity");
assert.deepStrictEqual(contributions.map((contribution) => contribution.index), [1], "destroyed shield contribution is excluded");
const mixedContributions = ShieldRules.calculateShieldCapacityContributions(
  [at("shield",0,0), at("aegisProjector",1,0), at("battery",2,0), at("capacitor",3,0), at("frame",4,0)],
  PARTS,
  { powerMultiplier: (index) => [1, 0.5, 1, 0, 1][index], isLive: (index) => index !== 4 }
);
assert.deepStrictEqual(mixedContributions.map((contribution) => contribution.index), [0, 1, 2], "only live powered shield-capacity contributors are listed");
close(mixedContributions.reduce((sum, contribution) => sum + contribution.capacity, 0), ShieldRules.calculateShieldStats(
  [at("shield",0,0), at("aegisProjector",1,0), at("battery",2,0), at("capacitor",3,0), at("frame",4,0)],
  PARTS,
  { powerMultiplier: (index) => [1, 0.5, 1, 0, 1][index], isLive: (index) => index !== 4 }
).capacity, "shared contributions sum to shared capacity");
const heatShip = { design: [at("shield",0,0), at("aegisProjector",1,0), at("battery",2,0)], componentHp: [1, 1, 0], componentHeatInput: [0, 0, 0] };
const queued = distributeComponentHeatByWeight(heatShip, [{ index: 0, capacity: 100 }, { index: 1, capacity: 50 }, { index: 1, capacity: 50 }, { index: 2, capacity: 100 }, { index: 99, capacity: 100 }, { index: 0, capacity: -1 }], 24);
close(queued, 24, "weighted heat allocator queues full amount");
close(heatShip.componentHeatInput[0], 12, "weighted heat allocator assigns proportional share");
close(heatShip.componentHeatInput[1], 12, "weighted heat allocator combines duplicate indexes");
close(heatShip.componentHeatInput[2], 0, "weighted heat allocator ignores destroyed indexes");
assert.strictEqual(heatShip.hasActiveHeat, true, "weighted heat allocator uses addComponentHeat side effects");
console.log("Shield rules verification passed.");

async function verifyBlueprintRuntimeShieldParity() {
  if (typeof global.document === "undefined") global.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  if (typeof global.window === "undefined") global.window = global;
  const { computeStats: computeBlueprintStats } = await import("./public/src/design/componentStats.js");
  const full = shipFor([at("reactor",0,0), at("shield",1,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]);
  let bp = computeBlueprintStats(full.design, { wiring: full.wiring });
  close(bp.maxShield, Math.round(effectiveShieldStats(full).capacity), "real blueprint path fully powered capacity parity");
  close(bp.shieldRegen, effectiveShieldStats(full).recharge, "real blueprint path fully powered regen parity");

  const regenDesign = [at("reactor",0,0), at("reactor",0,1), at("shield",1,0), at("shield",1,1), at("shield",2,0), at("shield",2,1)];
  const regenPaths = [2,3,4,5].map(i => [i < 4 ? 0 : 1, i, [{x:i < 4 ? 0 : 0,y:i === 3 || i === 5 ? 1 : 0},{x:regenDesign[i].x,y:regenDesign[i].y}]]);
  const regen = shipFor(regenDesign, regenPaths);
  bp = computeBlueprintStats(regen.design, { wiring: regen.wiring });
  close(bp.shieldRegen, effectiveShieldStats(regen).recharge, "real blueprint path four-module diminished regen parity");

  const weakDesign = [at("auxGenerator",0,0), at("shield",1,0), at("shield",2,0)];
  const weakBoth = shipFor(weakDesign, [[0,1,[{x:0,y:0},{x:1,y:0}]], [0,2,[{x:0,y:0},{x:1,y:0},{x:2,y:0}]]]);
  bp = computeBlueprintStats(weakBoth.design, { wiring: weakBoth.wiring });
  close(bp.maxShield, Math.round(effectiveShieldStats(weakBoth).capacity), "real blueprint path shared insufficient capacity parity");
  close(bp.shieldRegen, effectiveShieldStats(weakBoth).recharge, "real blueprint path shared insufficient regen parity");
  assert(bp.maxShield < computeBlueprintStats(weakBoth.design).maxShield, "global full-power catalogue stats are not labelled as effective stats");

  const separateDesign = [at("auxGenerator",0,0), at("reactor",0,2), at("shield",1,0), at("shield",1,2)];
  const separate = shipFor(separateDesign, [[0,2,[{x:0,y:0},{x:1,y:0}]], [1,3,[{x:0,y:2},{x:1,y:2}]]]);
  bp = computeBlueprintStats(separate.design, { wiring: separate.wiring });
  close(bp.maxShield, Math.round(effectiveShieldStats(separate).capacity), "independent healthy shield network not reduced by unrelated underpowered network");

  const disconnected = shipFor([at("reactor",0,0), at("shield",2,0)], []);
  bp = computeBlueprintStats(disconnected.design, { wiring: disconnected.wiring });
  close(bp.maxShield, 0, "disconnected blueprint shield contributes zero capacity");
  close(bp.shieldRegen, 0, "disconnected blueprint shield contributes zero regen");

  const zeroGen = shipFor([at("battery",0,0), at("shield",1,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]);
  bp = computeBlueprintStats(zeroGen.design, { wiring: zeroGen.wiring });
  close(bp.maxShield, 0, "zero-generation blueprint network contributes zero capacity");

  const damaged = shipFor([at("reactor",0,0), at("shield",1,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]);
  damaged.componentHp[1] = 0;
  close(effectiveShieldStats(damaged).capacity, 0, "destroyed runtime shield is removed");
  for (const heatState of [HeatRules.STATE.HOT, HeatRules.STATE.OVERHEATED]) {
    const heated = shipFor([at("reactor",0,0), at("shield",1,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]);
    heated.componentHeatState[1] = heatState;
    close(effectiveShieldStats(heated).capacity, PARTS.shield.shield, "runtime shield capacity is Heat-independent");
    close(effectiveShieldStats(heated).recharge, PARTS.shield.shieldRegen * HeatRules.activeOutputForState(heatState), "runtime shield regen uses shared Heat multiplier");
  }
}

verifyBlueprintRuntimeShieldParity().then(() => console.log("Blueprint/runtime shield parity verification passed."));
