"use strict";
// Section 7D-2 — activity-driven Power demand.
// Shared demand-rule coverage plus runtime activity signals, the batched
// single-solve-per-cycle update path, and the activity -> demand -> allocation
// -> sectionFlows -> cable-Heat chain. The corrected terminal attachment (§1)
// is verified in verify-power-flow.js.

const assert = require("assert");
const PD = require("./public/src/shared/powerDemandRules");
const PCT = require("./public/src/shared/powerCableThermalRules");
const WiringRules = require("./public/src/shared/wiringRules");
const WiringInfra = require("./public/src/shared/wiringInfrastructureRules");
const { PARTS } = require("./src/server/components");
const { BALANCE } = require("./src/server/balanceConfig");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { initShipHeat, updateShipHeat } = require("./src/server/heat");
const { rebuildShipWiringState, updateShipPowerDemand, getComponentPowerMultiplier } = require("./src/server/componentPower");

const STANDBY = BALANCE.powerDemand;
let passed = 0;
function check(label, fn) { fn(); passed += 1; console.log(`  ok  ${label}`); }
const close = (a, b, msg, eps = 1e-9) => assert(Math.abs(a - b) < eps, `${msg}: ${a} !== ${b}`);

// ---------------------------------------------------------------------------
// Shared demand rules
// ---------------------------------------------------------------------------
console.log("Shared demand rules");
check("standby fractions resolve per role (weapons 0.1, propulsion/shields/cooling 0.15, repair 0.1)", () => {
  close(PD.standbyFractionForPart(PARTS.blaster, STANDBY.standbyFractions), 0.1, "weapon standby");
  close(PD.standbyFractionForPart(PARTS.pointDefense, STANDBY.standbyFractions), 0.1, "point defence standby");
  close(PD.standbyFractionForPart(PARTS.engine, STANDBY.standbyFractions), 0.15, "propulsion standby");
  close(PD.standbyFractionForPart(PARTS.shield, STANDBY.standbyFractions), 0.15, "shields standby");
  close(PD.standbyFractionForPart(PARTS.fireControl, STANDBY.standbyFractions), 0.15, "cooling/support standby");
  close(PD.standbyFractionForPart(PARTS.repair, STANDBY.standbyFractions), 0.1, "repair standby");
});
check("requestedMw formula: standby at activity 0, nominal at activity 1, linear between", () => {
  const nominal = PARTS.blaster.powerUse; // 2.4, standby 0.1
  close(PD.requestedMwForComponent(PARTS.blaster, 0, STANDBY), nominal * 0.1, "idle -> standby");
  close(PD.requestedMwForComponent(PARTS.blaster, 1, STANDBY), nominal, "full -> nominal");
  close(PD.requestedMwForComponent(PARTS.blaster, 0.5, STANDBY), nominal * (0.1 + 0.5 * 0.9), "half activity");
});
check("activity and requested demand are clamped; no NaN/Infinity/-0", () => {
  close(PD.requestedMw(10, 5, 0.1), 10, "activity clamps to 1 -> nominal");
  close(PD.requestedMw(10, -3, 0.1), 1, "activity clamps to 0 -> standby");
  assert.strictEqual(PD.requestedMw(0, 1, 0.1), 0, "zero nominal -> zero");
  for (const bad of [NaN, Infinity, -Infinity, "x", null, undefined]) {
    const v = PD.requestedMw(10, bad, 0.1);
    assert.ok(Number.isFinite(v) && !Object.is(v, -0), `finite, no -0 for activity ${String(bad)}`);
  }
});
check("an unrecognised role falls back to always-on (never silently zero)", () => {
  close(PD.standbyFractionForPart({ powerUse: 5, powerCategory: "bogus" }, STANDBY.standbyFractions), 1, "unknown role -> 1.0");
});
check("inputs are never mutated", () => {
  const part = { powerUse: 2.4, powerCategory: "weapons" };
  const cfg = { standbyFractions: { ...STANDBY.standbyFractions } };
  const snap = JSON.stringify({ part, cfg });
  PD.requestedMwForComponent(part, 0.5, cfg);
  assert.strictEqual(JSON.stringify({ part, cfg }), snap, "no mutation");
});

// ---------------------------------------------------------------------------
// Runtime activity signals and the batched update path
// ---------------------------------------------------------------------------
const mod = (type, x, y) => ({ type, x, y, rotation: 0 });
function wiringFor(design, powerPaths) { let w = WiringRules.emptyWiring(); for (const p of powerPaths) w = WiringRules.addPath(w, "power", p, design, PARTS); return w; }
function makeShip(design, powerPaths, extra = {}) {
  const s = { id: "s", ownerId: "p1", alive: true, x: 0, y: 0, vx: 0, vy: 0, angle: 0, radius: 30, arrived: true, shield: 0, maxShield: 0, turnActivity: 0, heatPressure: 0, stats: computeStats(design), design, wiring: wiringFor(design, powerPaths), ...extra };
  initComponentState(s); initShipHeat(s); rebuildShipWiringState(s, "test", { skipRuntimeStats: true }); return s;
}
function room() { return { effects: [], bullets: [], map: { asteroids: [] }, rules: { gameMode: "solo" }, players: new Map(), ships: new Map(), combatRandom: () => 0.5 }; }
function demand(s, i) { return s.componentPower.byComponentIndex[i].requestedMw; }

console.log("Runtime activity demand");
global.__mfaDataSupportPerf = {};

// A reactor (gen 10) amply feeds one weapon so activity is visible in demand.
let ship = makeShip([mod("reactor", 0, 0), mod("blaster", 2, 0)], [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]);
check("an idle weapon requests only standby demand", () => {
  updateShipPowerDemand(ship, room(), 1000);
  close(demand(ship, 1), PARTS.blaster.powerUse * 0.1, "idle weapon at 10% standby");
  assert.strictEqual(ship.componentPowerActivity[1], 0, "idle activity 0");
});
check("firing intent raises weapon demand to nominal", () => {
  ship.weaponFireTargetIds = [null, "enemy"];
  updateShipPowerDemand(ship, room(), 1100);
  close(demand(ship, 1), PARTS.blaster.powerUse, "firing weapon at full demand");
  assert.strictEqual(ship.componentPowerActivity[1], 1, "firing activity 1");
});
check("stopping returns to standby only after the deterministic hold", () => {
  ship.weaponFireTargetIds = [null, null]; // stop
  updateShipPowerDemand(ship, room(), 1300); // within 500ms hold of last intent (1100)
  close(demand(ship, 1), PARTS.blaster.powerUse, "held at full during hold window");
  updateShipPowerDemand(ship, room(), 1700); // past hold
  close(demand(ship, 1), PARTS.blaster.powerUse * 0.1, "returns to standby after hold");
});

// Propulsion.
let prop = makeShip([mod("reactor", 0, 0), mod("engine", 2, 0)], [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]);
check("propulsion demand scales with requested effort (idle vs moving vs turning)", () => {
  prop.arrived = true; prop.turnActivity = 0;
  updateShipPowerDemand(prop, room(), 2000);
  close(demand(prop, 1), PARTS.engine.powerUse * 0.15, "idle propulsion at standby");
  prop.arrived = false; // driving toward a move target
  updateShipPowerDemand(prop, room(), 2100);
  close(demand(prop, 1), PARTS.engine.powerUse, "moving propulsion at full");
  prop.arrived = true; prop.turnActivity = 0.5;
  updateShipPowerDemand(prop, room(), 2200);
  close(demand(prop, 1), PARTS.engine.powerUse * (0.15 + 0.5 * 0.85), "turning propulsion scales with effort");
});

// Shields.
let shielded = makeShip([mod("reactor", 0, 0), mod("shield", 2, 0)], [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]);
check("shield deficit activates recharge demand; a full shield returns to standby", () => {
  shielded.maxShield = 100; shielded.shield = 40; // deficit
  updateShipPowerDemand(shielded, room(), 3000);
  close(demand(shielded, 1), PARTS.shield.powerUse, "deficit -> full recharge demand");
  shielded.shield = 100; // full
  updateShipPowerDemand(shielded, room(), 3100);
  close(demand(shielded, 1), PARTS.shield.powerUse * 0.15, "full shield -> standby");
});

// Repair only when requested.
let repairer = makeShip([mod("reactor", 0, 0), mod("repair", 2, 0)], [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]);
check("repair raises demand only when a repair action is requested", () => {
  updateShipPowerDemand(repairer, room(), 4000);
  close(demand(repairer, 1), PARTS.repair.powerUse * 0.1, "no repair target -> standby");
  repairer._repairIntentAt = 4100; // a repair system acted this cycle
  updateShipPowerDemand(repairer, room(), 4100);
  close(demand(repairer, 1), PARTS.repair.powerUse, "active repair -> full demand");
});

// Active cooling only when requested.
let cooled = makeShip([mod("reactor", 0, 0), mod("radiator", 2, 0)], [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]);
check("active cooling raises demand only above the passive floor (heat pressure)", () => {
  cooled.heatPressure = 0;
  updateShipPowerDemand(cooled, room(), 5000);
  close(demand(cooled, 1), PARTS.radiator.powerUse * 0.15, "no heat -> standby cooling");
  cooled.heatPressure = 1;
  updateShipPowerDemand(cooled, room(), 5100);
  close(demand(cooled, 1), PARTS.radiator.powerUse, "high heat -> full cooling demand");
});

// Always-on Data/support.
let support = makeShip([mod("reactor", 0, 0), mod("fireControl", 2, 0)], [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]);
check("always-on support consumers request full demand regardless of activity", () => {
  updateShipPowerDemand(support, room(), 6000);
  close(demand(support, 1), PARTS.fireControl.powerUse, "support always at nominal");
  assert.strictEqual(support.componentPowerActivity[1], 1, "always-on activity 1");
});

// Batched: one solve per cycle, none when unchanged.
check("a demand change performs exactly one reallocation; an unchanged cycle performs none", () => {
  const s = makeShip([mod("reactor", 0, 0), mod("blaster", 2, 0)], [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]);
  global.__mfaDataSupportPerf = {};
  updateShipPowerDemand(s, room(), 7000); // first activity solve
  const refresh1 = global.__mfaDataSupportPerf.powerDemandRefreshCount;
  const solve1 = global.__mfaDataSupportPerf.powerDemandSolveCount;
  updateShipPowerDemand(s, room(), 7100); // unchanged
  assert.strictEqual(global.__mfaDataSupportPerf.powerDemandRefreshCount, refresh1 + 1, "refresh attempted again");
  assert.strictEqual(global.__mfaDataSupportPerf.powerDemandSolveCount, solve1, "no solve when demand unchanged");
  assert.strictEqual(s.powerDemandDirty, false, "unchanged demand is not dirty");
  s.weaponFireTargetIds = [null, "enemy"]; // change
  updateShipPowerDemand(s, room(), 7200);
  assert.strictEqual(global.__mfaDataSupportPerf.powerDemandSolveCount, solve1 + 1, "exactly one solve on change");
  assert.strictEqual(s.powerDemandDirty, true, "changed demand is dirty");
});

// Priorities and fairness still hold under activity demand.
check("named priorities still control shortages under activity demand", () => {
  // aux(3.2) feeds shield(shields) and blaster(weapons); Defensive powers shields first.
  const s = makeShip([mod("auxGenerator", 0, 0), mod("shield", 1, 0), mod("blaster", 0, 1)], [[{ x: 0, y: 0 }, { x: 1, y: 0 }], [{ x: 0, y: 0 }, { x: 0, y: 1 }]]);
  s.wiring.powerPolicy = WiringRules.PowerPolicyRules.normalizePolicy({ preset: "defensive" });
  rebuildShipWiringState(s, "policy", { skipRuntimeStats: true });
  s.maxShield = 100; s.shield = 0; // shield wants recharge
  s.weaponFireTargetIds = [null, null, "enemy"]; // blaster firing
  updateShipPowerDemand(s, room(), 8000);
  assert.ok(getComponentPowerMultiplier(s, 1) > getComponentPowerMultiplier(s, 2), "shields prioritised over weapons");
});
check("tied consumers remain fairly (proportionally) allocated under activity demand", () => {
  // Balanced ties shields + point defence; both fully active, scarce generation.
  const s = makeShip([mod("auxGenerator", 0, 0), mod("shield", 1, 0), mod("pointDefense", 0, 1)], [[{ x: 0, y: 0 }, { x: 1, y: 0 }], [{ x: 0, y: 0 }, { x: 0, y: 1 }]]);
  s.maxShield = 100; s.shield = 0;
  s.weaponFireTargetIds = [null, null, "enemy"]; // point defence active
  updateShipPowerDemand(s, room(), 8100);
  const m1 = getComponentPowerMultiplier(s, 1); const m2 = getComponentPowerMultiplier(s, 2);
  assert.ok(m1 > 0 && m2 > 0 && Math.abs(m1 - m2) < 2e-3, "tied consumers share proportionally");
});

// Activity changes sectionFlows and cable Heat; peak enforced.
check("activity changes alter sectionFlows and cable Heat", () => {
  const s = makeShip([mod("reactor", 0, 0), mod("frame", 1, 0), mod("blaster", 2, 0)], [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]);
  updateShipPowerDemand(s, room(), 9000);
  const idleFlow = s.powerFlow.sectionFlows.find((f) => f.sectionId === "1,0:2,0").absoluteFlowMw;
  const idleCable = s.powerCableHeatRate;
  s.weaponFireTargetIds = [null, null, "enemy"];
  updateShipPowerDemand(s, room(), 9100);
  const firingFlow = s.powerFlow.sectionFlows.find((f) => f.sectionId === "1,0:2,0").absoluteFlowMw;
  assert.ok(firingFlow > idleFlow, "firing raises the delivered section flow");
  assert.ok(s.powerCableHeatRate > idleCable, "firing raises cable Heat");
});
check("cable peak capacity remains enforced under high activity demand", () => {
  // beamEmitter (nominal 7.5) on a light cable (peak 7). Firing demands 7.5 but
  // the section is capped at the light peak.
  const s = makeShip([mod("reactor", 0, 0), mod("frame", 1, 0), mod("beamEmitter", 2, 0)], [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]);
  // force the trunk to light tier
  s.wiring.power.sections.forEach((sec) => { sec.tier = "light"; });
  rebuildShipWiringState(s, "tier", { skipRuntimeStats: true });
  s.weaponFireTargetIds = [null, null, "enemy"];
  updateShipPowerDemand(s, room(), 9200);
  for (const f of s.powerFlow.sectionFlows) assert.ok(f.absoluteFlowMw <= f.peakCapacityMw + 1e-9, `${f.sectionId} within light peak`);
});

// 7D-1 cable caching stays correct with activity demand.
check("cable-thermal analysis rebuilds only when section flow changes", () => {
  const s = makeShip([mod("reactor", 0, 0), mod("frame", 1, 0), mod("blaster", 2, 0)], [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]);
  global.__mfaDataSupportPerf = {};
  updateShipPowerDemand(s, room(), 10000);
  const c1 = global.__mfaDataSupportPerf.powerCableThermalAnalysisCount;
  updateShipPowerDemand(s, room(), 10100); // unchanged demand/flow
  for (let n = 0; n < 3; n += 1) updateShipHeat(s, 0.2, room(), 10200 + n * 200);
  assert.strictEqual(global.__mfaDataSupportPerf.powerCableThermalAnalysisCount, c1, "no rebuild without a flow change");
  s.weaponFireTargetIds = [null, null, "enemy"];
  updateShipPowerDemand(s, room(), 11000); // flow change
  assert.strictEqual(global.__mfaDataSupportPerf.powerCableThermalAnalysisCount, c1 + 1, "one rebuild on flow change");
});
check("direct shared demand analysis matches the runtime section flow (no non-finite output)", () => {
  const s = makeShip([mod("reactor", 0, 0), mod("frame", 1, 0), mod("blaster", 2, 0)], [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]);
  s.weaponFireTargetIds = [null, null, "enemy"];
  updateShipPowerDemand(s, room(), 12000);
  const direct = PCT.analyzePowerCableHeat({ sectionFlows: s.powerFlow.sectionFlows, powerTiers: BALANCE.wiringInfrastructure.powerTiers, hostMap: WiringInfra.mapHostedCells(s.design, s.wiring, PARTS).power });
  assert.strictEqual(JSON.stringify(direct), JSON.stringify(s.powerCableThermalAnalysis), "runtime matches direct analysis");
  for (const entry of s.componentPower.byComponentIndex) {
    assert.ok(Number.isFinite(entry.requestedMw) && Number.isFinite(entry.allocatedMw) && Number.isFinite(entry.operationalMultiplier), "finite diagnostics");
  }
});

console.log(`\nSection 7D-2 activity-driven Power demand verification passed (${passed} checks)`);
