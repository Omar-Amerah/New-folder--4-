"use strict";
const assert = require("assert");
if (typeof globalThis.document === "undefined") globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
const WiringRules = require("../public/src/shared/wiringRules");
const PowerFlowRules = require("../public/src/shared/powerFlowRules");
const ShieldRules = require("../public/src/shared/shieldRules");
const HeatRules = require("../public/src/shared/heatRules");
globalThis.WiringRules = WiringRules; globalThis.PowerFlowRules = PowerFlowRules; globalThis.ShieldRules = ShieldRules; globalThis.HeatRules = HeatRules;
const { PARTS } = require("../src/server/components");
const { initComponentState } = require("../src/server/componentHealth");
const { initShipHeat, distributeComponentHeatByWeight } = require("../src/server/heat");
const { computeStats } = require("../src/server/shipStats");
const { rebuildShipWiringState, updateShipPowerDemand, effectiveShieldStats, effectiveShieldCapacityContributions } = require("../src/server/componentPower");
const { updateRuntimeShield, SHIELD_RESTART_DELAY_MS } = require("../src/server/runtimeShield");
const { tickRoom } = require("../src/server/simulation");
const at = (type, x, y) => ({ type, x, y, rotation: 0 });
function wiringFor(design, paths) { let wiring = WiringRules.emptyWiring(); for (const path of paths) wiring = WiringRules.addConnection(wiring, "power", path[0], path[1], path[2], design, PARTS); return wiring; }
function shipFor(design, paths = []) { const ship = { design, wiring: wiringFor(design, paths), stats: computeStats(design), shield: 0, alive: true }; initComponentState(ship); initShipHeat(ship); rebuildShipWiringState(ship, "test"); return ship; }
function close(a, b, msg) { assert(Math.abs(a - b) < 0.011, `${msg}: ${a} !== ${b}`); }
function shieldScale(design) { return ShieldRules.shipMassShieldScale(design, PARTS); }

const one = shipFor([at("reactor",0,0), at("shield",1,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]);
close(effectiveShieldStats(one).capacity, PARTS.shield.shield * shieldScale(one.design), "one shield capacity");
close(effectiveShieldStats(one).recharge, PARTS.shield.shieldRegen, "one shield regen");
const fourDesign = [at("reactor",0,0), at("reactor",0,1), at("shield",1,0), at("shield",2,0), at("shield",3,0), at("shield",4,0)];
const four = shipFor(fourDesign, [[0,2,[{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:3,y:0},{x:4,y:0}]], [1,2,[{x:0,y:1},{x:1,y:0},{x:2,y:0},{x:3,y:0},{x:4,y:0}]]]);
close(effectiveShieldStats(four).recharge, ShieldRules.effectiveStackedValue([2,3,4,5].map(i => PARTS.shield.shieldRegen * four.componentPower.byComponentIndex[i].operationalMultiplier)), "four module diminishing regen");
const weak = shipFor([at("auxGenerator",0,0), at("shield",1,0), at("shield",2,0)], [[0,1,[{x:0,y:0},{x:1,y:0},{x:2,y:0}]]]);
const mult = PARTS.auxGenerator.powerGeneration / (PARTS.shield.powerUse * 2);
close(effectiveShieldStats(weak).capacity, PARTS.shield.shield * 2 * shieldScale(weak.design), "standby allocation maintains full shield capacity");
weak.componentHeatState[1] = HeatRules.STATE.HOT;
weak.heatStateRevision = (weak.heatStateRevision || 0) + 1;
close(effectiveShieldStats(weak).capacity, PARTS.shield.shield * 2 * shieldScale(weak.design), "capacity ignores Heat state");
close(effectiveShieldStats(weak).recharge, ShieldRules.effectiveStackedValue([PARTS.shield.shieldRegen * mult * HeatRules.activeOutputForState(HeatRules.STATE.HOT), PARTS.shield.shieldRegen * mult]), "regen responds to Heat state");
weak.componentHp[2] = 0;
weak.componentAliveRevision = (weak.componentAliveRevision || 0) + 1;
close(effectiveShieldStats(weak).capacity, PARTS.shield.shield * shieldScale(weak.design), "destroyed capacity removed");
const designer = ShieldRules.calculateShieldStats(weak.design, PARTS, { isLive: i => (weak.componentHp[i] ?? 1) > 0, powerMultiplier: i => weak.componentPower.byComponentIndex[i].operationalMultiplier, capacityPowerMultiplier: i => i === 1 ? 1 : 0, heatMultiplier: i => HeatRules.activeOutputForState(weak.componentHeatState[i] || 0) });
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
assert.deepStrictEqual(mixedContributions.map((contribution) => contribution.index), [0, 1], "only live powered shield-capacity contributors are listed");
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

const stable = shipFor([at("auxGenerator",0,0), at("shield",1,0), at("shield",2,0)], [[0,1,[{x:0,y:0},{x:1,y:0},{x:2,y:0}]]]);
stable.maxShield = effectiveShieldStats(stable).capacity;
stable.shield = stable.maxShield * 0.5;
const stableCaps = [];
const stableDemands = [];
for (let tick = 0; tick < 12; tick += 1) {
  updateShipPowerDemand(stable, null, 1000 + tick * 100);
  const effective = effectiveShieldStats(stable);
  stable.maxShield = effective.capacity;
  stable.shield = Math.min(stable.maxShield, stable.shield + effective.recharge * 0.1);
  stableCaps.push(stable.maxShield);
  stableDemands.push(stable.componentPowerActivity[1]);
}
assert(stableCaps.every((capacity) => Math.abs(capacity - stableCaps[0]) < 0.011), "recharge demand must not alternate maxShield");
assert(stableDemands.every((activity) => activity === 1), "a real shield deficit must remain active while power-starved");

// Exercise the exact runtime stage called by simulation.tickRoom().
const runtime = shipFor([at("reactor",0,0), at("shield",1,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]);
runtime.id = "runtime-shield";
runtime.maxShield = effectiveShieldStats(runtime).capacity;
runtime.shield = runtime.maxShield;
updateRuntimeShield(runtime, 0.1, 1000);
assert(Number.isFinite(runtime.shield) && Number.isFinite(runtime.maxShield), "first production Shield stage keeps values finite");
const full = runtime.shield;
runtime.shield = full * 0.5;
updateRuntimeShield(runtime, 0.1, 1100);
assert(runtime.shield > full * 0.5, "damaged Shield heals through the production runtime stage");
runtime.shield = 0;
updateRuntimeShield(runtime, 0.1, 1200);
updateRuntimeShield(runtime, 0.1, 1200 + SHIELD_RESTART_DELAY_MS - 1);
assert.strictEqual(runtime.shield, 0, "depleted Shield respects restart delay");
updateRuntimeShield(runtime, 0.1, 1200 + SHIELD_RESTART_DELAY_MS);
assert(runtime.shield > 0, "depleted Shield heals after restart delay");
runtime.shield = NaN;
global.__mfaRuntimeDiagnostics = {};
updateRuntimeShield(runtime, 0.1, 5000);
assert.strictEqual(global.__mfaRuntimeDiagnostics.invalidShieldStateCount, 1, "invalid Shield state is diagnosed exactly once");
assert(Number.isFinite(runtime.shield), "invalid Shield state is repaired to a finite runtime value");
delete global.__mfaRuntimeDiagnostics;
runtime.ownerId = "runtime-player";
runtime.x = 500; runtime.y = 500; runtime.vx = 0; runtime.vy = 0; runtime.angle = 0;
runtime.targetX = 500; runtime.targetY = 500; runtime.arrived = true; runtime.radius = 30;
runtime.hp = runtime.maxHp = runtime.stats.maxHp;
runtime.weaponAngles = []; runtime.weaponCooldowns = []; runtime.desiredAngles = [];
runtime.aimTargetIds = []; runtime.componentTargetIds = []; runtime.beamContacts = [];
runtime.shield = runtime.maxShield * 0.5;
const beforeProductionTick = runtime.shield;
const runtimeRoom = {
  phase: "active", players: new Map(), ships: new Map([[runtime.id, runtime]]),
  drones: new Map(), bullets: [], effects: [], points: [],
  world: { width: 2000, height: 1600 }, map: { asteroids: [], points: [], safeZones: [] },
  spatialIndex: null
};
tickRoom(runtimeRoom, 0.1, 6000);
assert(Number.isFinite(runtime.shield) && Number.isFinite(runtime.maxShield), "simulation.tickRoom snapshot source remains finite");
assert(runtime.shield > beforeProductionTick, "simulation.tickRoom heals damaged Shield through the production path");
console.log("Shield rules verification passed.");

async function verifyBlueprintRuntimeShieldParity() {
  const { computeStats: computeBlueprintStats } = await import("../public/src/design/componentStats.js");
  const weakBoth = shipFor([at("auxGenerator",0,0), at("shield",1,0), at("shield",2,0)], [[0,1,[{x:0,y:0},{x:1,y:0},{x:2,y:0}]]]);
  let bp = computeBlueprintStats(weakBoth.design, { wiring: weakBoth.wiring });
  close(bp.maxShield, Math.round(effectiveShieldStats(weakBoth).capacity), "wired blueprint preview matches runtime partial power capacity");
  close(bp.shieldRegen, effectiveShieldStats(weakBoth).recharge, "wired blueprint preview matches runtime partial power regen");
  close(bp.maxShield, computeBlueprintStats(weakBoth.design).maxShield, "standby Power preserves full shield capacity in the blueprint");

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
  close(bp.maxShield, Math.round(effectiveShieldStats(zeroGen).capacity), "zero-generation blueprint preview matches passive battery buffer and unpowered generator");

  const damaged = shipFor([at("reactor",0,0), at("shield",1,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]);
  damaged.componentHp[1] = 0;
damaged.componentAliveRevision = (damaged.componentAliveRevision || 0) + 1;
  close(effectiveShieldStats(damaged).capacity, 0, "destroyed runtime shield is removed");
  for (const heatState of [HeatRules.STATE.HOT, HeatRules.STATE.OVERHEATED]) {
    const heated = shipFor([at("reactor",0,0), at("shield",1,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]);
    heated.componentHeatState[1] = heatState;
    heated.heatStateRevision = (heated.heatStateRevision || 0) + 1;
    close(effectiveShieldStats(heated).capacity, PARTS.shield.shield * shieldScale(heated.design), "runtime shield capacity is Heat-independent");
    close(effectiveShieldStats(heated).recharge, PARTS.shield.shieldRegen * HeatRules.activeOutputForState(heatState), "runtime shield regen uses shared Heat multiplier");
  }
}

verifyBlueprintRuntimeShieldParity().then(() => console.log("Blueprint/runtime shield parity verification passed."));
