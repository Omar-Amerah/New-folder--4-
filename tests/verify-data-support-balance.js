"use strict";

const assert = require("assert");
const DataRules = require("../public/src/shared/dataSupportRules");
const HeatRules = require("../public/src/shared/heatRules");
const { PARTS } = require("../src/server/components");
const fixtures = require("./fixtures/dataSupportReferenceShips");
const harness = require("./fixtures/dataSupportRuntimeHarness");

const close = (actual, expected, message, epsilon = 1e-9) => assert(Math.abs(actual - expected) <= epsilon, message + ": " + actual + " !== " + expected);
const budget = (type) => DataRules.nominalSupportBudget(type, PARTS);
const byType = fixtures.componentIndicesByType;

function sharedAnalysis(fixture) {
  return DataRules.analyzeDirectDataSupport(fixture.design, fixture.dataLinks, PARTS);
}

function assertFixtureAuthority() {
  const refs = fixtures.allReferenceShips();
  assert.deepEqual(refs, fixtures.allReferenceShips(), "repeated direct-link fixture construction is deterministic");
  refs[0].design[0].x = 99;
  assert.notEqual(fixtures.allReferenceShips()[0].design[0].x, 99, "returned fixtures are independent clones");
  for (const fixture of refs) {
    fixtures.validateReferenceFixture(fixture);
    const analysis = sharedAnalysis(fixture);
    assert.equal(analysis.links.length, fixture.expectedLinkCount, fixture.name + " link count");
    analysis.sourceAllocations.forEach((source) => {
      close(source.bonusPerWeapon * source.recipientCount, source.effectiveBudget, fixture.name + " source budget conservation");
    });
  }
}

function assertRuntimeParity() {
  for (const fixture of fixtures.allReferenceShips()) {
    const shared = sharedAnalysis(fixture);
    const ship = harness.createRuntimeShip(fixture);
    const runtime = ship.runtimeDataSupport;
    assert(!Object.prototype.hasOwnProperty.call(runtime, "networks"), fixture.name + " runtime has no physical Data network state");
    assert.equal(typeof runtime.linkSignature, "string", fixture.name + " runtime tracks explicit Data Links");
    assert(runtime.linkRevision >= 1, fixture.name + " runtime has a Data Link revision");
    for (const source of shared.sourceAllocations) {
      const actual = harness.runtimeSourceAllocation(ship, source.sourceIndex);
      assert.deepEqual(actual.directWeaponIndices, source.directWeaponIndices, fixture.name + " direct recipient parity");
      close(actual.nominalBudget, source.nominalBudget, fixture.name + " nominal budget parity");
      close(actual.effectiveBudget, actual.nominalBudget * actual.sourceMultiplier, fixture.name + " effective budget parity");
      close(actual.bonusPerWeapon, actual.recipientCount ? actual.effectiveBudget / actual.recipientCount : 0, fixture.name + " per-recipient budget parity");
    }
    for (const weapon of shared.weaponBonuses) {
      const actual = harness.runtimeWeaponSupport(ship, weapon.weaponIndex);
      assert.deepEqual(actual.sourceIndices, weapon.sourceIndices, fixture.name + " source membership parity");
      for (const field of ["rangeBonus", "accuracyBonus", "fireRateBonus"]) close(actual[field], weapon[field], fixture.name + " " + field + " parity");
    }
  }
}

function assertLifecycleStates() {
  const fixture = fixtures.broadsideBuild();
  const fireControl = byType(fixture, "fireControl")[0];
  const blasters = byType(fixture, "blaster");
  const ship = harness.createRuntimeShip(fixture);
  const baseline = blasters.map((index) => harness.runtimeWeaponSupport(ship, index).fireRateBonus);
  assert(baseline.every((value) => value > 0), "baseline Fire Control support is active");
  harness.disconnectSourcePower(ship, fireControl);
  blasters.forEach((index) => {
    close(harness.runtimeWeaponSupport(ship, index).fireRateBonus, 0, "unpowered source contributes nothing");
    close(harness.effectiveWeaponStats(ship, index).fireRate, PARTS.blaster.weapon.fireRate, "unpowered source leaves base weapon rate");
  });
  ship.componentPowerState[fireControl] = 1;
  harness.applyFullPower(ship);
  blasters.forEach((index, position) => close(harness.runtimeWeaponSupport(ship, index).fireRateBonus, baseline[position], "re-enabled source restores support"));

  const thermal = fixtures.precisionBuild();
  const thermalShip = harness.createRuntimeShip(thermal);
  const signal = byType(thermal, "signalAmplifier")[0];
  const rail = byType(thermal, "railgun")[0];
  harness.setSourceThermalState(thermalShip, signal, HeatRules.STATE.OVERHEATED);
  assert.equal(harness.runtimeSourceAllocation(thermalShip, signal).thermalMultiplier, 0, "overheated source has no thermal output");
  close(harness.runtimeWeaponSupport(thermalShip, rail).rangeBonus, 0, "overheated source contributes nothing");
}

function assertDirectIndependence() {
  const fixture = fixtures.redundantSupport();
  const ship = harness.createRuntimeShip(fixture);
  const fireControl = byType(fixture, "fireControl")[0];
  const signal = byType(fixture, "signalAmplifier")[0];
  const blaster = byType(fixture, "blaster")[0];
  const baseline = harness.runtimeWeaponSupport(ship, blaster);
  assert(baseline.sourceIndices.includes(fireControl) && baseline.sourceIndices.includes(signal), "both explicit sources support the weapon");
  harness.destroyComponent(ship, fireControl);
  const afterFireControl = harness.runtimeWeaponSupport(ship, blaster);
  assert(afterFireControl.sourceIndices.includes(signal), "destroying one source keeps the other explicit link");
  close(afterFireControl.rangeBonus, budget("signalAmplifier") / 2, "remaining source keeps its divided budget");
  harness.destroyComponent(ship, signal);
  const afterBoth = harness.runtimeWeaponSupport(ship, blaster);
  close(afterBoth.rangeBonus, 0, "destroying the remaining source removes only its contribution");
}

assertFixtureAuthority();
assertRuntimeParity();
assertLifecycleStates();
assertDirectIndependence();
console.log("Direct Data Links runtime/lifecycle balance verification passed.");
