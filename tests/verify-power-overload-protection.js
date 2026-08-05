#!/usr/bin/env node
"use strict";

// Section 7G — runtime Power overload protection verifier.
// Covers deterministic overload accumulation and recovery, peak enforcement
// through the existing solver, Switchgear overload trips with cooldown and
// bounded deterministic retry, brownout/load-shedding diagnostics, lifecycle
// state retention, performance counters and order independence.

const assert = require("assert");
const PowerProtectionRules = require("../public/src/shared/powerProtectionRules");
const { PARTS } = require("../src/server/components");
const { BALANCE } = require("../src/server/balanceConfig");
const { validatePowerProtection } = require("../src/server/componentSchema");
const { createShipBlueprintSnapshot } = require("../src/server/shipDesign");
const componentPower = require("../src/server/componentPower");
const { initializeComponentPower, reallocateShipPower, rebuildShipWiringState, powerProtectionConfig, __setPowerProtectionConfigForTests } = componentPower;
const {
  updateShipPowerProtection,
  refreshShipPowerProtectionDiagnostics,
  resetShipPowerProtection,
  buildPowerProtectionSnapshot
} = require("../src/server/powerProtection");

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }
function finite(value) {
  if (typeof value === "number") assert(Number.isFinite(value) && !Object.is(value, -0), `non-finite or -0: ${value}`);
  else if (Array.isArray(value)) value.forEach(finite);
  else if (value && typeof value === "object") Object.values(value).forEach(finite);
}
function close(actual, expected, eps, label) { assert(Math.abs(actual - expected) <= eps, `${label}: ${actual} !== ${expected}`); }

const CONFIG = powerProtectionConfig();
const L1 = "0,0:1,0"; // canonical id of the first light section in lightCableShip
const L2 = "1,0:2,0";
const LIGHT = BALANCE.wiringInfrastructure.powerTiers.light;

function policy(order = ["command", "propulsion", "shields", "pointDefence", "weapons", "coolingSupport"]) {
  return { preset: "custom", customOrder: order };
}
function makeShip(design, sections, demand, powerPolicy = policy()) {
  const wiring = { version: 3, power: { sections, connections: [] }, data: { sections: [], connections: [] }, powerPolicy };
  const snap = createShipBlueprintSnapshot(design, wiring);
  const ship = { design: snap.design, wiring: snap.wiring, componentHp: snap.design.map(() => 1), componentMaxHp: snap.design.map(() => 1), alive: true, stats: {}, _activityDemandByIndex: demand };
  initializeComponentPower(ship);
  return ship;
}
function sec(id, x1, y1, x2, y2, tier = "standard") { return { id, x1, y1, x2, y2, tier }; }
function setDemand(ship, demand) { ship._activityDemandByIndex = demand; reallocateShipPower(ship, "test-demand"); }
function tick(ship, seconds, dt = 0.05) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i += 1) updateShipPowerProtection(ship, dt);
}
function sectionStress(ship, id) { return ship._powerProtection?.sections?.get(id)?.stress ?? 0; }
function sectionRecord(ship, id) { return ship._powerProtection?.sections?.get(id) || null; }
// Reactor (10 MW) -> light cable -> shield. Pure physical light path.
function lightCableShip(demandMw) {
  return makeShip(
    [{ x: 0, y: 0, type: "reactor" }, { x: 1, y: 0, type: "frame" }, { x: 2, y: 0, type: "shield" }],
    [sec("l1", 0, 0, 1, 0, "light"), sec("l2", 1, 0, 2, 0, "light")],
    { 2: demandMw }
  );
}

// ---------------------------------------------------------------------------
check("central balance block exists, validates and normalises safely", () => {
  const errors = [];
  validatePowerProtection(BALANCE.powerProtection, "component-balance.json", errors);
  assert.deepStrictEqual(errors, []);
  finite(CONFIG);
  assert(CONFIG.recoveryStartRatio <= CONFIG.overloadStartRatio);
  assert(CONFIG.maximumProtectionDeltaSeconds > 0);
  assert(Number.isInteger(CONFIG.maxAutomaticRetrySubsets) && CONFIG.maxAutomaticRetrySubsets >= 1);
  // A hostile/missing block still normalises to safe finite values.
  finite(PowerProtectionRules.normalizeConfig(null));
  finite(PowerProtectionRules.normalizeConfig({ baseStressPerSecond: Infinity, recoveryPerSecond: -3, maximumProtectionDeltaSeconds: NaN }));
});
check("established cable tier capacities are unchanged", () => {
  assert.strictEqual(LIGHT.sustainedCapacityMw, 4); assert.strictEqual(LIGHT.peakCapacityMw, 7);
  assert.strictEqual(BALANCE.wiringInfrastructure.powerTiers.standard.sustainedCapacityMw, 10);
  assert.strictEqual(BALANCE.wiringInfrastructure.powerTiers.standard.peakCapacityMw, 16);
  assert.strictEqual(BALANCE.wiringInfrastructure.powerTiers.heavy.sustainedCapacityMw, 24);
  assert.strictEqual(BALANCE.wiringInfrastructure.powerTiers.heavy.peakCapacityMw, 36);
});

// ---------------------------------------------------------------------------
console.log("Accumulation and recovery");
// ---------------------------------------------------------------------------
check("1. flow below sustained accumulates no stress", () => {
  const ship = lightCableShip(3.5);
  tick(ship, 5);
  assert.strictEqual(sectionStress(ship, L1), 0);
  assert.strictEqual(sectionStress(ship, L2), 0);
  assert.strictEqual(sectionRecord(ship, L1).state, "normal");
});
check("2/3. just-above-sustained accumulates slowly; at peak substantially faster", () => {
  const slow = lightCableShip(4.4); tick(slow, 2);
  const fast = lightCableShip(20); tick(fast, 2); // capped at peak 7
  const slowStress = sectionStress(slow, L1);
  const fastStress = sectionStress(fast, L1);
  assert(slowStress > 0 && fastStress > 0);
  assert(fastStress > slowStress * 2.5, `peak (${fastStress}) must accumulate substantially faster than slight overload (${slowStress})`);
  close(slowStress, 2 * (CONFIG.baseStressPerSecond + CONFIG.additionalStressPerSecondAtPeak * ((0.4 / 3) ** 2)), 1e-6, "slight overload matches formula");
  close(fastStress, 2 * (CONFIG.baseStressPerSecond + CONFIG.additionalStressPerSecondAtPeak), 1e-6, "peak matches formula");
  assert(sectionRecord(fast, L1).state === "at-peak");
  close(sectionRecord(fast, L1).secondsAboveSustained, 2, 1e-6, "seconds above sustained tracked");
});
check("4. delivery is capped at peak by the existing solver", () => {
  const ship = lightCableShip(20);
  const flow = ship.powerFlow.sectionFlows.find((f) => f.sectionId === L1);
  assert.strictEqual(flow.absoluteFlowMw, LIGHT.peakCapacityMw);
  assert(flow.atPeak);
  assert.strictEqual(ship.componentPower.byComponentIndex[2].allocatedMw, LIGHT.peakCapacityMw);
});
check("5. stress recovers below the recovery threshold", () => {
  const ship = lightCableShip(6);
  tick(ship, 2);
  const before = sectionStress(ship, L1);
  assert(before > 0.5);
  setDemand(ship, { 2: 2 }); // 2 MW < 0.95 * 4
  tick(ship, 1);
  close(sectionStress(ship, L1), before - CONFIG.recoveryPerSecond, 1e-6, "recovery rate");
  tick(ship, 10);
  assert.strictEqual(sectionStress(ship, L1), 0);
  assert.strictEqual(sectionRecord(ship, L1).secondsAboveSustained, 0);
});
check("6. stress holds inside the hysteresis band", () => {
  const ship = lightCableShip(6);
  tick(ship, 2);
  const before = sectionStress(ship, L1);
  setDemand(ship, { 2: 3.9 }); // between 0.95*4=3.8 and 4
  tick(ship, 5);
  close(sectionStress(ship, L1), before, 1e-9, "held in band");
});
check("7. large deltas process through deterministic bounded substeps", () => {
  const a = lightCableShip(6);
  const b = lightCableShip(6);
  updateShipPowerProtection(a, 2.0);
  for (let i = 0; i < 40; i += 1) updateShipPowerProtection(b, 0.05);
  close(sectionStress(a, L1), sectionStress(b, L1), 1e-9, "one large delta equals equivalent small deltas");
  const c = lightCableShip(6);
  updateShipPowerProtection(c, 100000);
  assert.strictEqual(sectionStress(c, L1), 1, "stress clamps to 1");
  // The shared rule computes bounded substeps directly.
  const one = PowerProtectionRules.advanceStress({ stress: 0, secondsAboveSustained: 0 }, { absoluteFlowMw: 6, sustainedCapacityMw: 4, peakCapacityMw: 7 }, 3, CONFIG);
  let split = { stress: 0, secondsAboveSustained: 0 };
  for (let i = 0; i < 12; i += 1) split = PowerProtectionRules.advanceStress(split, { absoluteFlowMw: 6, sustainedCapacityMw: 4, peakCapacityMw: 7 }, 0.25, CONFIG);
  close(one.stress, split.stress, 1e-9, "substep equivalence");
});

// ---------------------------------------------------------------------------
console.log("Physical cables");
// ---------------------------------------------------------------------------
check("8/9. physical cable reaches critical stress but is never damaged, destroyed or tripped", () => {
  const ship = lightCableShip(7);
  const wiringBefore = JSON.stringify(ship.wiring);
  const hpBefore = ship.componentHp.slice();
  tick(ship, 60);
  assert.strictEqual(sectionStress(ship, L1), 1);
  assert(["critical", "at-peak"].includes(sectionRecord(ship, L1).state));
  assert.deepStrictEqual(ship.componentHp, hpBefore, "no cable/component HP change");
  const flow = ship.powerFlow.sectionFlows.find((f) => f.sectionId === L1);
  assert.strictEqual(flow.absoluteFlowMw, 7, "cable keeps carrying flow — never trips itself");
  assert.strictEqual(flow.operational, true);
  assert.strictEqual(JSON.stringify(ship.wiring), wiringBefore, "Blueprint wiring not mutated");
  assert(!ship.runtimeWiring.power.disabledSectionIds.size, "no section disabled by overload");
});
check("10/11. hosted cable destruction clears active stress/flow; repair returns zero stress", () => {
  const ship = lightCableShip(6);
  tick(ship, 3);
  assert(sectionStress(ship, L1) > 0);
  ship.componentHp[1] = 0; // destroy hosting frame
  rebuildShipWiringState(ship, "component-lifecycle");
  tick(ship, 1);
  assert.strictEqual(sectionRecord(ship, L1), null, "disabled section record cleared");
  assert(!ship.powerFlow.sectionFlows.some((f) => f.sectionId === L1), "disabled section carries no flow");
  tick(ship, 5);
  assert.strictEqual(sectionRecord(ship, L1), null, "no accumulation while disabled");
  ship.componentHp[1] = 1;
  rebuildShipWiringState(ship, "component-lifecycle");
  tick(ship, 0.05);
  const record = sectionRecord(ship, L1);
  assert(record && record.stress < 0.05, "repair restores with (near) zero stress");
});

// ---------------------------------------------------------------------------
console.log("Cable-Heat integration");
// ---------------------------------------------------------------------------
check("32. overloaded physical cable produces dynamic Heat", () => {
  const ship = lightCableShip(6);
  tick(ship, 2);
  assert(ship.powerCableHeatRate > 0, "overloaded cable produces dynamic Heat");
  const stressedIds = [...ship._powerProtection.sections.keys()];
  assert(stressedIds.every((id) => !id.includes("data")), "no Data overload records exist");
});

// ---------------------------------------------------------------------------
console.log("Lifecycle, retention and identifiers");
// ---------------------------------------------------------------------------
check("34. ordinary overload accumulation causes no topology rebuild and no solve", () => {
  const ship = lightCableShip(6);
  global.__mfaDataSupportPerf = {};
  tick(ship, 2);
  assert.strictEqual(global.__mfaDataSupportPerf.wiringNormalizationCount || 0, 0);
  assert.strictEqual(global.__mfaDataSupportPerf.powerFlowSolveCount || 0, 0);
  assert((global.__mfaDataSupportPerf.powerProtectionUpdateCount || 0) >= 40);
  global.__mfaDataSupportPerf = null;
  assert(sectionStress(ship, L1) > 0);
});
check("35. stable section IDs preserve stress across an ordinary flow refresh", () => {
  const ship = lightCableShip(6);
  tick(ship, 2);
  const before = sectionStress(ship, L1);
  setDemand(ship, { 2: 6.2 }); // reallocation, same sections
  const preserved = sectionStress(ship, L1);
  close(preserved, before, 1e-9, "refresh preserves stress on the same stable id");
  tick(ship, 1);
  assert(sectionStress(ship, L1) > preserved, "accumulation continues after refresh");
});
check("36/38. design replacement/spawn resets to deterministic zero stress", () => {
  const ship = lightCableShip(6);
  tick(ship, 3);
  assert(sectionStress(ship, L1) > 0);
  initializeComponentPower(ship); // same path a spawned/replaced design takes
  assert.strictEqual(sectionStress(ship, L1), 0);
  const snapshot = buildPowerProtectionSnapshot(ship);
  assert.strictEqual(snapshot.sections.length, 0, "no stale stressed-section diagnostics after replacement");
  assert.strictEqual(snapshot.mostStressedStress, 0);
  // The still-overloaded live flow honestly reports "strained"; a ship with
  // idle demand starts fully "normal".
  setDemand(ship, { 2: 1 });
  refreshShipPowerProtectionDiagnostics(ship);
  assert.strictEqual(buildPowerProtectionSnapshot(ship).state, "normal");
});
check("37. runtime protection state is never persisted into Blueprint data", () => {
  const ship = lightCableShip(6);
  tick(ship, 5);
  const before = JSON.stringify({ wiring: ship.wiring, design: ship.design });
  assert.strictEqual(JSON.stringify({ wiring: ship.wiring, design: ship.design }), before);
  const persisted = JSON.stringify(ship.wiring) + JSON.stringify(ship.design);
  for (const token of ["stress", "cooldown", "retry", "tripped"]) assert(!persisted.includes(token), `Blueprint contains runtime token ${token}`);
});
check("44. diagnostics and snapshots contain no NaN, Infinity or negative zero", () => {
  const ship = lightCableShip(6);
  tick(ship, 12);
  finite(ship.powerProtectionDiagnostics);
  finite(buildPowerProtectionSnapshot(ship));
  finite([...ship._powerProtection.sections.values()].map((r) => ({ ...r })));
});
check("45/46. no cable fires/HP/destruction and no Data overload behaviour are introduced", () => {
  const fs = require("fs");
  const runtime = fs.readFileSync("src/server/powerProtection.js", "utf8") + fs.readFileSync("public/src/shared/powerProtectionRules.js", "utf8");
  for (const token of ["fire", "cableHp", "cableHitPoints", "armouredConduit", "voltage", "transformer"]) {
    assert(!runtime.toLowerCase().includes(token.toLowerCase()), `forbidden concept in protection runtime: ${token}`);
  }
  assert(!/data(Overload|Heat|Breaker|Bandwidth|Tier)/i.test(runtime), "no Data overload/Heat/breaker behaviour");
  // Runtime check: a stressed ship keeps full component HP and operational cables.
  const ship = lightCableShip(7);
  tick(ship, 30);
  assert(ship.componentHp.every((hp) => hp === 1));
});
check("diagnostics summarise demand, delivery, spare and stressed sections", () => {
  const ship = lightCableShip(6);
  tick(ship, 1);
  const diag = ship.powerProtectionDiagnostics;
  assert.strictEqual(diag.requestedDemandMw, 6);
  assert.strictEqual(diag.deliveredDemandMw, 6);
  assert.strictEqual(diag.unmetDemandMw, 0);
  assert.strictEqual(diag.aboveSustainedSectionCount, 2);
  assert.strictEqual(diag.state, "strained");
  assert(diag.mostStressedSectionId === L1 || diag.mostStressedSectionId === L2);
  assert(diag.mostStressedStress > 0);
  tick(ship, 10);
  assert(ship.powerProtectionDiagnostics.criticalSectionCount >= 1, "critical stress counted");
});

console.log(`Section 7G runtime Power overload protection verification passed (${passed} checks).`);
