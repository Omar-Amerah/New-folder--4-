#!/usr/bin/env node
"use strict";

// Section 7G — runtime Power overload protection verifier.
// Covers deterministic overload accumulation and recovery, peak enforcement
// through the existing solver, Switchgear overload trips with cooldown and
// bounded deterministic retry, brownout/load-shedding diagnostics, lifecycle
// state retention, performance counters and order independence.

const assert = require("assert");
const PowerProtectionRules = require("./public/src/shared/powerProtectionRules");
const SwitchgearRules = require("./public/src/shared/switchgearRules");
const { PARTS } = require("./src/server/components");
const { BALANCE } = require("./src/server/balanceConfig");
const { validatePowerProtection } = require("./src/server/componentSchema");
const { createShipBlueprintSnapshot } = require("./src/server/shipDesign");
const componentPower = require("./src/server/componentPower");
const { initializeComponentPower, reallocateShipPower, rebuildShipWiringState, powerProtectionConfig, __setPowerProtectionConfigForTests } = componentPower;
const {
  updateShipPowerProtection,
  refreshShipPowerProtectionDiagnostics,
  resetShipPowerProtection,
  buildPowerProtectionSnapshot,
  switchgearProtectionFields
} = require("./src/server/powerProtection");

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
function sgRecord(ship) { return ship.runtimeSwitchgear[ship.runtimeSwitchgear.length - 1]; }

// Reactor (10 MW) -> light cable -> shield. Pure physical light path.
function lightCableShip(demandMw) {
  return makeShip(
    [{ x: 0, y: 0, type: "reactor" }, { x: 1, y: 0, type: "frame" }, { x: 2, y: 0, type: "shield" }],
    [sec("l1", 0, 0, 1, 0, "light"), sec("l2", 1, 0, 2, 0, "light")],
    { 2: demandMw }
  );
}
// Reactor -> standard cable -> [switchgear rating] -> standard cable -> shield.
function switchgearShip(mode, rating, demandMw, externalTier = "standard") {
  return makeShip(
    [{ x: 0, y: 0, type: "reactor" }, { x: 3, y: 0, type: "shield" }, { x: 1, y: 0, type: "switchgear", rotation: 0, switchgearMode: mode, switchgearRatingTier: rating }],
    [sec("a1", 0, 0, 1, 0, externalTier), sec("b1", 2, 0, 3, 0, externalTier)],
    { 1: demandMw }
  );
}
// Reactor feeding two shields, each through its own light Closed switchgear.
function twoSwitchgearShip(order = "normal", mode = "closed", demandEach = 5) {
  const parts = {
    reactor: { x: 0, y: 0, type: "reactor" },
    r1: { x: 3, y: 0, type: "shield" },
    r2: { x: 0, y: 3, type: "shield" },
    sw1: { x: 1, y: 0, type: "switchgear", rotation: 0, switchgearMode: mode, switchgearRatingTier: "light" },
    sw2: { x: 0, y: 1, type: "switchgear", rotation: 90, switchgearMode: mode, switchgearRatingTier: "light" }
  };
  const design = order === "swapped"
    ? [parts.reactor, parts.r1, parts.r2, parts.sw2, parts.sw1]
    : [parts.reactor, parts.r1, parts.r2, parts.sw1, parts.sw2];
  const sections = [sec("s1", 0, 0, 1, 0), sec("s2", 2, 0, 3, 0), sec("s3", 0, 0, 0, 1), sec("s4", 0, 2, 0, 3)];
  const demand = {};
  design.forEach((part, index) => { if (part.type === "shield") demand[index] = demandEach; });
  return makeShip(design, sections, demand);
}
function switchStateByKey(ship) {
  const out = {};
  for (const record of ship.runtimeSwitchgear) out[SwitchgearRules.terminalPairKey(ship.design[record.componentIndex])] = { state: record.state, conducting: record.conducts };
  return out;
}
// Key-order-independent serialisation for physical-equivalence comparisons.
function stableSwitchStateString(ship) {
  const byKey = switchStateByKey(ship);
  return Object.keys(byKey).sort().map((key) => `${key}=${byKey[key].state}/${byKey[key].conducting}`).join(";");
}

// ---------------------------------------------------------------------------
console.log("Configuration");
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
console.log("Switchgear trips");
// ---------------------------------------------------------------------------
check("12. Closed Switchgear trips at the threshold with a concise runtime reason", () => {
  const ship = switchgearShip("closed", "light", 6);
  const before = JSON.stringify(ship.wiring);
  let trippedAt = null; let t = 0;
  while (trippedAt === null && t < 20) { updateShipPowerProtection(ship, 0.05); t += 0.05; if (sgRecord(ship).state === "tripped") trippedAt = t; }
  // 6 MW on light: rate = 0.12 + 0.38*(2/3)^2 = 0.28889 -> threshold 1 at ~3.46s
  assert(trippedAt !== null && Math.abs(trippedAt - 3.5) < 0.2, `trip near 3.46s, got ${trippedAt}`);
  const record = sgRecord(ship);
  assert.strictEqual(record.state, "tripped");
  assert.strictEqual(record.signedTransferMw, 0, "transfer zero after trip");
  assert(/overload trip/.test(record.trippedReason));
  const fields = switchgearProtectionFields(ship, record.componentIndex);
  assert.strictEqual(fields.lastTripFlowMw, 6);
  assert(fields.lastTripUtilisation > 0.8);
  close(fields.cooldownRemaining, CONFIG.tripCooldownSeconds, 1e-6, "cooldown started");
  assert.strictEqual(ship.design[record.componentIndex].switchgearMode, "closed", "saved mode not mutated");
  assert.strictEqual(JSON.stringify(ship.wiring), before, "Blueprint wiring not mutated by trip");
  assert.strictEqual(sectionStress(ship, record.internalEdgeId), 0, "internal edge stress reset at trip");
});
check("13. conducting Automatic Switchgear trips at the threshold", () => {
  const ship = switchgearShip("automatic", "light", 6);
  assert.strictEqual(sgRecord(ship).automaticClosed, true, "automatic conducts before trip");
  tick(ship, 5);
  assert.strictEqual(sgRecord(ship).state, "tripped");
});
check("14. Open Switchgear never trips", () => {
  const ship = switchgearShip("open", "light", 6);
  tick(ship, 30);
  assert.strictEqual(sgRecord(ship).state, "open");
  assert.strictEqual(switchgearProtectionFields(ship, sgRecord(ship).componentIndex).lastTripReason, null);
});
check("15. Destroyed Switchgear never retries; repair restores zero-stress saved mode", () => {
  const ship = switchgearShip("closed", "light", 6);
  tick(ship, 5);
  assert.strictEqual(sgRecord(ship).state, "tripped");
  const index = sgRecord(ship).componentIndex;
  ship.componentHp[index] = 0;
  rebuildShipWiringState(ship, "component-lifecycle");
  tick(ship, 30);
  assert.strictEqual(sgRecord(ship).state, "destroyed", "destroyed remains destroyed through retry intervals");
  ship.componentHp[index] = 1;
  rebuildShipWiringState(ship, "component-lifecycle");
  tick(ship, 0.05);
  assert.strictEqual(sgRecord(ship).state, "closed", "repair restores saved Closed mode");
  const fields = switchgearProtectionFields(ship, index);
  assert.strictEqual(fields.retryCount, 0, "repair starts with reset runtime protection state");
  assert.strictEqual(fields.lastTripReason, null);
});
check("16. several simultaneous trips are applied as one lifecycle batch", () => {
  const ship = twoSwitchgearShip("normal", "closed", 5);
  tick(ship, 6.0); // just before the ~6.16s trip point
  assert(ship.runtimeSwitchgear.every((r) => r.state === "closed"));
  global.__mfaDataSupportPerf = {};
  tick(ship, 0.4);
  assert(ship.runtimeSwitchgear.every((r) => r.state === "tripped"), "both trip in the same window");
  assert.strictEqual(global.__mfaDataSupportPerf.wiringNormalizationCount, 1, "one topology rebuild for the batch");
  assert.strictEqual(global.__mfaDataSupportPerf.powerFlowSolveCount, 1, "one final allocation refresh");
  assert.strictEqual(global.__mfaDataSupportPerf.powerProtectionTripBatchCount, 1);
  global.__mfaDataSupportPerf = null;
});
check("17. cooldown-only ticks perform no Power solve and no topology rebuild", () => {
  const ship = switchgearShip("closed", "light", 6);
  tick(ship, 5);
  assert.strictEqual(sgRecord(ship).state, "tripped");
  tick(ship, 1.0); // let post-trip physical stress settle to zero
  const revBefore = ship.powerRevision;
  global.__mfaDataSupportPerf = {};
  tick(ship, 1.0); // inside cooldown
  assert.strictEqual(global.__mfaDataSupportPerf.powerFlowSolveCount || 0, 0, "no solve to decrement cooldown");
  assert.strictEqual(global.__mfaDataSupportPerf.wiringNormalizationCount || 0, 0, "no topology rebuild");
  assert.strictEqual(ship.powerRevision, revBefore, "Power revision unchanged by cooldown ticks");
  global.__mfaDataSupportPerf = null;
});

// ---------------------------------------------------------------------------
console.log("Retry");
// ---------------------------------------------------------------------------
check("18/19. Automatic retry goes through the 7F policy and never stays labelled Tripped", () => {
  const ship = switchgearShip("automatic", "light", 6);
  tick(ship, 5);
  assert.strictEqual(sgRecord(ship).state, "tripped");
  // Make the transfer useless during cooldown: receiver demand drops to zero.
  setDemand(ship, { 1: 0 });
  tick(ship, CONFIG.tripCooldownSeconds + 0.2);
  const record = sgRecord(ship);
  assert.strictEqual(record.state, "automatic", "left Tripped after cooldown + retry evaluation");
  assert.strictEqual(record.automaticClosed, false, "returns non-conducting when no useful transfer exists");
  const fields = switchgearProtectionFields(ship, record.componentIndex);
  assert.strictEqual(fields.lastRetryReason, "no safe Automatic transfer");
  assert.strictEqual(fields.retryCount, 1);
  // And with a useful safe transfer it recloses through the policy.
  const useful = switchgearShip("automatic", "light", 6);
  tick(useful, 5);
  setDemand(useful, { 1: 3 });
  tick(useful, CONFIG.tripCooldownSeconds + 0.2);
  assert.strictEqual(sgRecord(useful).automaticClosed, true);
  assert.strictEqual(switchgearProtectionFields(useful, sgRecord(useful).componentIndex).lastRetryReason, "reclosed by automatic policy");
});
check("20/21. Closed retry recloses only below the safe threshold; unsafe retries reschedule", () => {
  const ship = switchgearShip("closed", "light", 6);
  tick(ship, 5);
  assert.strictEqual(sgRecord(ship).state, "tripped");
  // Demand stays 6 > 0.9 * 4 = 3.6 -> every retry is unsafe.
  tick(ship, CONFIG.tripCooldownSeconds + 2 * CONFIG.retryIntervalSeconds + 0.5);
  let fields = switchgearProtectionFields(ship, sgRecord(ship).componentIndex);
  assert.strictEqual(sgRecord(ship).state, "tripped");
  assert(fields.retryCount >= 2, "multiple scheduled retries");
  assert.strictEqual(fields.lastRetryReason, "projected flow above safe reclose threshold");
  // Load drops below the safe threshold -> next retry recloses.
  setDemand(ship, { 1: 3 });
  tick(ship, CONFIG.retryIntervalSeconds + 0.2);
  assert.strictEqual(sgRecord(ship).state, "closed");
  fields = switchgearProtectionFields(ship, sgRecord(ship).componentIndex);
  assert.strictEqual(fields.lastRetryReason, "reclosed: projected flow within safe threshold");
  assert.strictEqual(ship.componentPower.byComponentIndex[1].allocatedMw, 3, "reclose restores delivery");
});
check("22/23. several Closed retries are evaluated jointly, in one rebuild, order-independently", () => {
  const run = (order) => {
    const ship = twoSwitchgearShip(order, "closed", 5);
    tick(ship, 7);
    assert(ship.runtimeSwitchgear.every((r) => r.state === "tripped"));
    const demand = {};
    ship.design.forEach((part, index) => { if (part.type === "shield") demand[index] = 3; });
    setDemand(ship, demand);
    global.__mfaDataSupportPerf = {};
    tick(ship, CONFIG.tripCooldownSeconds + 0.4);
    const rebuilds = global.__mfaDataSupportPerf.wiringNormalizationCount;
    global.__mfaDataSupportPerf = null;
    return { ship, rebuilds };
  };
  const a = run("normal");
  assert(a.ship.runtimeSwitchgear.every((r) => r.state === "closed"), "both reclose jointly");
  assert.strictEqual(a.rebuilds, 1, "one rebuild for the joint retry decision");
  const b = run("swapped");
  assert.deepStrictEqual(switchStateByKey(b.ship), switchStateByKey(a.ship), "retry decisions independent of component-array order");
});
check("24. oversized retry groups fail safely without closing anything", () => {
  __setPowerProtectionConfigForTests({ maxAutomaticRetrySubsets: 2 }); // 2 candidates -> 4 subsets > 2
  try {
    const ship = twoSwitchgearShip("normal", "closed", 5);
    tick(ship, 7);
    assert(ship.runtimeSwitchgear.every((r) => r.state === "tripped"));
    const demand = {};
    ship.design.forEach((part, index) => { if (part.type === "shield") demand[index] = 3; });
    setDemand(ship, demand);
    tick(ship, componentPower.powerProtectionConfig().tripCooldownSeconds + 0.4);
    assert(ship.runtimeSwitchgear.every((r) => r.state === "tripped"), "unresolved group stays tripped");
    for (const record of ship.runtimeSwitchgear) {
      const fields = switchgearProtectionFields(ship, record.componentIndex);
      assert.strictEqual(fields.lastRetryReason, "evaluation bound exceeded");
      assert(fields.cooldownRemaining > 0, "another retry interval scheduled");
    }
  } finally { __setPowerProtectionConfigForTests(null); }
});
check("25/42. retry counts, reasons and trip timing are deterministic across identical runs", () => {
  const run = () => {
    const ship = switchgearShip("closed", "light", 6);
    const events = [];
    for (let i = 0; i < 300; i += 1) {
      updateShipPowerProtection(ship, 0.05);
      const record = sgRecord(ship);
      const fields = switchgearProtectionFields(ship, record.componentIndex);
      events.push(`${record.state}:${fields.retryCount}:${fields.lastRetryReason || ""}`);
    }
    return events.join("|");
  };
  assert.strictEqual(run(), run(), "identical simulations produce identical trip times and retry decisions");
});
check("26/27. manual Closed baseline and donor demand protection survive automatic retry", () => {
  // Manual closed switchgear feeds a 10 MW donor engine; an automatic
  // switchgear could steal from it after its own overload trip cycle — the 7F
  // baseline must keep protecting the manual link and donor-side demand.
  const design = [
    { x: 0, y: 0, type: "reactor" },
    { x: 3, y: 0, type: "engine" },
    { x: 0, y: 3, type: "shield" },
    { x: 1, y: 0, type: "switchgear", rotation: 0, switchgearMode: "closed", switchgearRatingTier: "standard" },
    { x: 0, y: 1, type: "switchgear", rotation: 90, switchgearMode: "automatic", switchgearRatingTier: "light" }
  ];
  const sections = [sec("m1", 0, 0, 1, 0), sec("m2", 2, 0, 3, 0), sec("a2", 0, 2, 0, 3)];
  const ship = makeShip(design, sections, { 1: 5, 2: 6 });
  // The automatic light tie carries ~5 MW (spare after donor) -> overload -> trip.
  tick(ship, 40);
  const manual = ship.runtimeSwitchgear.find((r) => r.mode === "closed");
  assert.strictEqual(manual.state, "closed", "manual Closed link stays in the baseline throughout trips/retries");
  assert.strictEqual(ship.componentPower.byComponentIndex[1].allocatedMw, 5, "donor-side demand never sacrificed");
});
check("28/29/30. six categories stay distinct; shedding follows priority; ties stay fair", () => {
  const ship = lightCableShip(20);
  const byCategory = ship.powerFlow.summary.byCategory;
  assert.deepStrictEqual(Object.keys(byCategory).sort(), ["command", "coolingSupport", "pointDefence", "propulsion", "shields", "weapons"].sort());
  // Priority shed order: shields (higher) before weapons under a bottleneck.
  const design = [
    { x: 0, y: 0, type: "reactor" },
    { x: 2, y: 0, type: "shield" },
    { x: 2, y: 1, type: "blaster" },
    { x: 1, y: 0, type: "frame" }, { x: 1, y: 1, type: "frame" }
  ];
  const sections = [sec("p1", 0, 0, 1, 0, "light"), sec("p2", 1, 0, 2, 0, "light"), sec("p3", 1, 0, 1, 1, "light"), sec("p4", 1, 1, 2, 1, "light")];
  const shed = makeShip(design, sections, { 1: 6, 2: 6 }, policy(["shields", "command", "propulsion", "pointDefence", "weapons", "coolingSupport"]));
  updateShipPowerProtection(shed, 0.1);
  assert.strictEqual(shed.componentPower.byComponentIndex[1].allocatedMw, 6, "higher priority fully served first");
  assert.strictEqual(shed.componentPower.byComponentIndex[2].allocatedMw, 1, "lower priority sheds under the peak cap");
  assert.deepStrictEqual(shed.powerFlow.summary.loadShedCategories, ["weapons"]);
  assert.strictEqual(shed.powerProtectionDiagnostics.state, "brownout", "partial consumer -> brownout diagnostic");
  // Tied priority consumers share fairly.
  const tied = makeShip(
    [{ x: 0, y: 0, type: "reactor" }, { x: 2, y: 0, type: "shield" }, { x: 2, y: 1, type: "shield" }, { x: 1, y: 0, type: "frame" }, { x: 1, y: 1, type: "frame" }],
    [sec("t1", 0, 0, 1, 0, "light"), sec("t2", 1, 0, 2, 0, "light"), sec("t3", 1, 0, 1, 1, "light"), sec("t4", 1, 1, 2, 1, "light")],
    { 1: 6, 2: 6 }
  );
  close(tied.componentPower.byComponentIndex[1].allocatedMw, tied.componentPower.byComponentIndex[2].allocatedMw, 0.01, "tied consumers share");
});
check("31. an external Light cable still bottlenecks a Heavy Switchgear", () => {
  const ship = switchgearShip("closed", "heavy", 20, "light");
  const internal = ship.powerFlow.sectionFlows.find((f) => f.sectionId.startsWith("switchgear:"));
  assert(internal.absoluteFlowMw <= LIGHT.peakCapacityMw + 1e-9, "heavy internal edge cannot remove the light bottleneck");
  assert.strictEqual(ship.componentPower.byComponentIndex[1].allocatedMw, LIGHT.peakCapacityMw);
});

// ---------------------------------------------------------------------------
console.log("Cable-Heat integration");
// ---------------------------------------------------------------------------
check("32/33. a trip refreshes cable flow and Heat once; internal edges add no cable-cell Heat", () => {
  const ship = switchgearShip("closed", "light", 6);
  const heatBefore = ship.powerCableHeatRate;
  assert(heatBefore > 0);
  assert(!ship.powerCableThermalAnalysis.sections.some((s) => String(s.sectionId).startsWith("switchgear:")), "synthetic internal edges are not cable-Heat cells");
  tick(ship, 3.4);
  global.__mfaDataSupportPerf = {};
  tick(ship, 0.3); // the trip lands here
  assert.strictEqual(sgRecord(ship).state, "tripped");
  assert.strictEqual(global.__mfaDataSupportPerf.powerCableThermalAnalysisCount, 1, "exactly one cable-Heat refresh after the batched solve");
  global.__mfaDataSupportPerf = null;
  assert(ship.powerCableHeatRate < heatBefore, "tripped flow change reduces dynamic cable Heat");
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
  assert.strictEqual(snapshot.trippedSwitchgearCount, 0);
  // The still-overloaded live flow honestly reports "strained"; a ship with
  // idle demand starts fully "normal".
  setDemand(ship, { 2: 1 });
  refreshShipPowerProtectionDiagnostics(ship);
  assert.strictEqual(buildPowerProtectionSnapshot(ship).state, "normal");
});
check("37. runtime protection state is never persisted into Blueprint data", () => {
  const ship = switchgearShip("closed", "light", 6);
  const before = JSON.stringify({ wiring: ship.wiring, design: ship.design });
  tick(ship, 30); // trips + failed retries
  assert.strictEqual(JSON.stringify({ wiring: ship.wiring, design: ship.design }), before);
  const persisted = JSON.stringify(ship.wiring) + JSON.stringify(ship.design);
  for (const token of ["stress", "cooldown", "retry", "tripped"]) assert(!persisted.includes(token), `Blueprint contains runtime token ${token}`);
});
check("43. correctly remapped input order produces equivalent physical results", () => {
  const runStates = (order) => {
    const ship = twoSwitchgearShip(order, "closed", 5);
    const timeline = [];
    for (let i = 0; i < 260; i += 1) {
      updateShipPowerProtection(ship, 0.05);
      timeline.push(stableSwitchStateString(ship));
    }
    const stress = {};
    for (const [id, record] of ship._powerProtection.sections) stress[id] = Math.round(record.stress * 1e9);
    return { timeline: timeline.join("|"), stress };
  };
  const a = runStates("normal");
  const b = runStates("swapped");
  assert.strictEqual(b.timeline, a.timeline, "trip/retry timeline equivalent under remapped order");
  assert.deepStrictEqual(b.stress, a.stress, "section stress equivalent under remapped order");
});
check("44. diagnostics and snapshots contain no NaN, Infinity or negative zero", () => {
  const ship = switchgearShip("closed", "light", 6);
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
