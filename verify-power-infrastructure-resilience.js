#!/usr/bin/env node
"use strict";

// Section 7H — Power-infrastructure architecture resilience verifier.
// Validates each architecture family's damage/repair behaviour, the full
// Switchgear mode/state matrix on the hybrid reference ship, and the
// deterministic overload trip → cooldown → retry cycle across a realistic
// fixture. All state changes go through the production lifecycle.

const assert = require("assert");
const SwitchgearRules = require("./public/src/shared/switchgearRules");
const componentPower = require("./src/server/componentPower");
const { updateShipPowerProtection, switchgearProtectionFields } = require("./src/server/powerProtection");
const fixtures = require("./test-fixtures/powerInfrastructureReferenceShips");
const harness = require("./test-fixtures/dataSupportRuntimeHarness");
const report = require("./tools/report-power-infrastructure-balance");

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }
const CONFIG = componentPower.powerProtectionConfig();
const rows = report.build();
const row = (key) => rows.find((r) => r.key === key);

function tieRecord(ship) { return ship.runtimeSwitchgear.find((r) => r.mode !== "closed" || SwitchgearRules.normalizeMode(ship.design[r.componentIndex].switchgearMode) === "closed" ? r.orientation === "horizontal" && r.componentIndex === fixtures.componentIndexAt(ship.design, 4, 0) : false); }
function hybridShip(overrides = {}) {
  const fixture = fixtures.cloneReferenceFixture(fixtures.hybridSwitchgear());
  if (overrides.tieMode) {
    const tieIndex = fixtures.componentIndexAt(fixture.design, 4, 0);
    fixture.design[tieIndex].switchgearMode = overrides.tieMode;
  }
  if (overrides.tieRating) {
    const tieIndex = fixtures.componentIndexAt(fixture.design, 4, 0);
    fixture.design[tieIndex].switchgearRatingTier = overrides.tieRating;
  }
  const ship = harness.createRuntimeShip(fixture);
  if (overrides.demand) {
    ship._activityDemandByIndex = {};
    for (const [key, mw] of Object.entries(overrides.demand)) {
      const [x, y] = key.split(",").map(Number);
      ship._activityDemandByIndex[fixtures.componentIndexAt(ship.design, x, y)] = mw;
    }
    componentPower.reallocateShipPower(ship, "resilience-probe");
  }
  return ship;
}
function allocAt(ship, x, y) { return ship.componentPower.byComponentIndex[fixtures.componentIndexAt(ship.design, x, y)].allocatedMw; }
function tieAt(ship) { return ship.runtimeSwitchgear.find((r) => r.componentIndex === fixtures.componentIndexAt(ship.design, 4, 0)); }
function tick(ship, seconds, dt = 0.05) { for (let t = 0; t < Math.round(seconds / dt); t += 1) updateShipPowerProtection(ship, dt); }

// ---------------------------------------------------------------------------
console.log("Central bus (frigate / heavy combat)");
// ---------------------------------------------------------------------------
check("trunk damage severs downstream consumers; branch damage stays local; repair restores at zero stress", () => {
  for (const key of ["frigate", "heavyCombat"]) {
    const r = row(key);
    const trunk = r.damageVariants.find((v) => v.key === "trunk-host-destroyed");
    assert(trunk.afterDamage.shedCount + trunk.afterDamage.partialCount >= 3, `${key} trunk damage degrades several consumers`);
    const branch = r.damageVariants.find((v) => v.key === "branch-host-destroyed");
    assert.strictEqual(branch.afterDamage.unmetMw, 0, `${key} branch damage leaves unrelated branches serviced`);
    for (const variant of r.damageVariants) {
      assert.strictEqual(variant.afterRepair.fullyPowered, true, `${key}/${variant.key} repair restores full service`);
      assert.strictEqual(variant.afterRepair.maxResidualStress, 0, `${key}/${variant.key} repair starts overload stress at zero`);
    }
  }
});

// ---------------------------------------------------------------------------
console.log("Distributed grids");
// ---------------------------------------------------------------------------
check("damage to one grid never disables the independent grid", () => {
  const r = row("distributed");
  for (const variant of r.damageVariants) {
    assert(variant.afterDamage.consumers.powered.includes("engine@2,0"), `${variant.key}: first island engine unaffected`);
    assert(variant.afterDamage.consumers.powered.includes("blaster@3,0"), `${variant.key}: first island blaster unaffected`);
  }
});

// ---------------------------------------------------------------------------
console.log("Ring bus");
// ---------------------------------------------------------------------------
check("one break reroutes, two strategic breaks split, no capacity double-counting", () => {
  const fixture = fixtures.ringBus();
  const ship = harness.createRuntimeShip(fixture);
  const frameIndex = fixtures.componentIndexAt(ship.design, 2, 0);
  harness.destroyComponent(ship, frameIndex);
  const summary = ship.powerFlow.summary;
  assert.strictEqual(summary.unmetMw, 0, "alternate ring route keeps every consumer powered");
  // Rerouted flow must respect per-section capacity and conservation.
  for (const flow of ship.powerFlow.sectionFlows) {
    assert(Math.abs(flow.signedFlowMw) <= flow.peakCapacityMw + 1e-9, "no section exceeds peak after rerouting");
  }
  assert(summary.usedGenerationMw <= summary.availableGenerationMw + 1e-9, "no generation double-counting through parallel routes");
  const split = row("ring").damageVariants.find((v) => v.key === "ring-split");
  assert(split.afterDamage.shedCount >= 3, "two strategic failures split the ring");
  assert.strictEqual(split.afterRepair.fullyPowered, true, "ring repair restores both arcs");
});

// ---------------------------------------------------------------------------
console.log("Hybrid Switchgear mode/state matrix");
// ---------------------------------------------------------------------------
check("21. Open isolates the receiver grid", () => {
  const ship = hybridShip({ tieMode: "open" });
  const tie = tieAt(ship);
  assert.strictEqual(tie.state, "open");
  assert.strictEqual(tie.signedTransferMw, 0);
  assert(ship.powerFlow.summary.unmetMw > 3, "receiver grid deficit is unserved through an Open tie");
});
check("22. Closed connects through its rating and surrounding bottlenecks", () => {
  const ship = hybridShip({ tieMode: "closed", tieRating: "light", demand: { "7,0": 12, "8,0": 3, "3,0": 2.4, "2,3": 1.2 } });
  const tie = tieAt(ship);
  assert.strictEqual(tie.state, "closed");
  assert(Math.abs(tie.signedTransferMw) <= 7 + 1e-9, "Light-rated tie transfer never exceeds the Light peak");
  assert(ship.powerFlow.summary.unmetMw > 0, "the rating limit genuinely bottlenecks the transfer");
  const standard = hybridShip({ tieMode: "closed", demand: { "7,0": 12, "8,0": 3, "3,0": 2.4, "2,3": 1.2 } });
  assert(Math.abs(tieAt(standard).signedTransferMw) > 7, "Standard rating carries what Light could not");
});
check("23/24/25. overload trip isolates; unsafe retry stays Tripped; safe retry restores", () => {
  // Push the receiver grid demand far above the donor's safe reclose band.
  const ship = hybridShip({ tieMode: "closed", demand: { "7,0": 12, "8,0": 3, "3,0": 2.4, "2,3": 1.2 } });
  assert(Math.abs(tieAt(ship).signedTransferMw) > 10, "tie runs above its Standard sustained rating");
  tick(ship, 8);
  const tie = tieAt(ship);
  assert.strictEqual(tie.state, "tripped", "overload trips the conducting Closed tie");
  assert.strictEqual(tie.signedTransferMw, 0, "tripped tie isolates");
  const trippedFields = switchgearProtectionFields(ship, tie.componentIndex);
  assert(/overload trip/.test(trippedFields.lastTripReason));
  // Cooldown prevents immediate reconnection; the demand is still unsafe, so
  // every retry reschedules deterministically.
  tick(ship, CONFIG.tripCooldownSeconds + CONFIG.retryIntervalSeconds + 0.5);
  assert.strictEqual(tieAt(ship).state, "tripped", "unsafe Closed retry remains Tripped");
  assert.strictEqual(switchgearProtectionFields(ship, tie.componentIndex).lastRetryReason, "projected flow above safe reclose threshold");
  // Load falls to a safe level -> the next retry restores the connection.
  ship._activityDemandByIndex = { [fixtures.componentIndexAt(ship.design, 7, 0)]: 3.5, [fixtures.componentIndexAt(ship.design, 8, 0)]: 3, [fixtures.componentIndexAt(ship.design, 3, 0)]: 2.4, [fixtures.componentIndexAt(ship.design, 2, 3)]: 1.2 };
  componentPower.reallocateShipPower(ship, "safe-load");
  tick(ship, CONFIG.retryIntervalSeconds + 0.3);
  assert.strictEqual(tieAt(ship).state, "closed", "safe Closed retry restores the saved mode");
  assert(Math.abs(tieAt(ship).signedTransferMw) > 0, "restored tie carries the safe transfer");
});
check("26/27. destroyed Switchgear never retries; repair restores the saved mode", () => {
  const r = row("hybrid");
  const destroyed = r.damageVariants.find((v) => v.key === "tie-switchgear-destroyed");
  assert(destroyed.afterDamage.unmetMw > 3, "destroyed tie stops conducting");
  assert.strictEqual(destroyed.afterRepair.fullyPowered, true, "repair restores the saved Automatic mode and transfer");
  // Runtime confirmation that a destroyed tie stays non-conducting through
  // many retry intervals.
  const ship = hybridShip({});
  const tieIndex = fixtures.componentIndexAt(ship.design, 4, 0);
  harness.destroyComponent(ship, tieIndex);
  tick(ship, CONFIG.tripCooldownSeconds + 3 * CONFIG.retryIntervalSeconds);
  assert.strictEqual(tieAt(ship).state, "destroyed", "Destroyed remains Destroyed and never retries");
  assert.strictEqual(tieAt(ship).signedTransferMw, 0);
  harness.repairComponent(ship, tieIndex);
  tick(ship, 0.1);
  assert.strictEqual(tieAt(ship).state, "automatic", "repair restores the saved Automatic mode");
});
check("Automatic tie protects donor demand under merged-grid scarcity", () => {
  // Shield demand 12 makes the merged grid scarce: under the balanced preset
  // the donor's weapons-band blaster would lose allocation to the higher-band
  // shield, so the joint policy must refuse to close.
  const scarce = hybridShip({ demand: { "7,0": 12, "8,0": 3, "3,0": 2.4, "2,3": 1.2 } });
  const scarceTie = tieAt(scarce);
  assert.strictEqual(scarceTie.automaticClosed, false, "no priority-safe transfer exists under scarcity");
  assert.strictEqual(allocAt(scarce, 3, 0), 2.4, "donor blaster keeps its full allocation");
});
check("Automatic retry re-enters the 7F joint policy after an overload trip", () => {
  // Shield 10.4 keeps closure priority-safe (total demand 17.0 <= 17.2 MW
  // generation) while the ~10.2 MW transfer still exceeds the tie's Standard
  // sustained rating and trips it.
  const ship = hybridShip({ demand: { "7,0": 10.4, "8,0": 3, "3,0": 2.4, "2,3": 1.2 } });
  assert(tieAt(ship).automaticClosed, "automatic tie conducts into the overload");
  assert(Math.abs(tieAt(ship).signedTransferMw) > 10, "transfer exceeds the sustained rating");
  tick(ship, 10);
  assert.strictEqual(tieAt(ship).state, "tripped");
  global.__mfaDataSupportPerf = {};
  tick(ship, CONFIG.tripCooldownSeconds + 0.2);
  const rebuilds = global.__mfaDataSupportPerf.wiringNormalizationCount || 0;
  global.__mfaDataSupportPerf = null;
  assert.strictEqual(rebuilds, 1, "the retry decision batch causes exactly one rebuild");
  const tie = tieAt(ship);
  assert.strictEqual(tie.state, "automatic", "no longer labelled Tripped after the retry evaluation");
  const fields = switchgearProtectionFields(ship, tie.componentIndex);
  assert(["reclosed by automatic policy", "no safe Automatic transfer"].includes(fields.lastRetryReason), "decision came from the joint policy");
});
check("Data support remains independent of Power damage on shared hulls", () => {
  const fixture = fixtures.standardFrigate();
  const ship = harness.createRuntimeShip(fixture);
  const dataNetworksBefore = ship.runtimeWiring.dataNetworks.length;
  harness.destroyComponent(ship, fixtures.componentIndexAt(ship.design, 3, 1)); // Power trunk host with no Data wiring
  assert.strictEqual(ship.runtimeWiring.dataNetworks.length, dataNetworksBefore, "Data topology untouched by Power-only host damage");
});

// ---------------------------------------------------------------------------
console.log("Physical cables under overload");
// ---------------------------------------------------------------------------
check("28/30. cable overload causes Heat and stress but no trip, HP loss or fire; repairs restart at zero", () => {
  const ship = harness.createRuntimeShip(fixtures.cheapBus());
  const blasterIndex = fixtures.componentIndexAt(ship.design, 4, 0);
  ship._activityDemandByIndex = { [blasterIndex]: 7 };
  componentPower.reallocateShipPower(ship, "cable-overload");
  const hpBefore = ship.componentHp.slice();
  tick(ship, 30);
  assert(ship.powerCableHeatRate > 0, "overloaded cable produces dynamic Heat");
  assert([...ship._powerProtection.sections.values()].some((r) => r.stress >= 1), "stress saturates");
  assert.deepStrictEqual(ship.componentHp, hpBefore, "no HP loss, no destruction, no fire");
  for (const flow of ship.powerFlow.sectionFlows) assert(flow.operational !== false, "cables never trip themselves");
  for (const variant of rows.flatMap((r) => r.damageVariants)) {
    assert.strictEqual(variant.afterRepair.maxResidualStress, 0, "every repaired fixture restarts at zero stress");
  }
});

console.log(`Section 7H Power-infrastructure resilience verification passed (${passed} checks).`);
