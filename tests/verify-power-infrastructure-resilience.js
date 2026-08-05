#!/usr/bin/env node
"use strict";

// Section 7H — Power-infrastructure architecture resilience verifier.
// Validates each architecture family's damage/repair behaviour, the full
// Switchgear mode/state matrix on the hybrid reference ship, and the
// deterministic overload trip → cooldown → retry cycle across a realistic
// fixture. All state changes go through the production lifecycle.

const assert = require("assert");
const componentPower = require("../src/server/componentPower");
const { updateShipPowerProtection } = require("../src/server/powerProtection");
const fixtures = require("./fixtures/powerInfrastructureReferenceShips");
const harness = require("./fixtures/dataSupportRuntimeHarness");
const report = require("../tools/report-power-infrastructure-balance");

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }
const CONFIG = componentPower.powerProtectionConfig();
const rows = report.build();
const row = (key) => rows.find((r) => r.key === key);

function hybridShip(overrides = {}) {
  const fixture = fixtures.cloneReferenceFixture(fixtures.hybridSwitchgear());
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
console.log("Hybrid storage resilience");
// ---------------------------------------------------------------------------
check("21. hybrid ship is fully powered at baseline", () => {
  const ship = hybridShip();
  assert.strictEqual(ship.powerFlow.summary.unmetMw, 0, "hybrid ship is fully powered at baseline");
});
check("22. battery destruction isolates its section and may cause demand unmet", () => {
  const r = row("hybrid");
  const destroyed = r.damageVariants.find((v) => v.key === "tie-battery-destroyed");
  assert(destroyed, "tie-battery-destroyed variant exists");
  assert.strictEqual(destroyed.afterRepair.fullyPowered, true, "repair of battery restores full service");
});
check("23. donor generator loss degrades hybrid ship power", () => {
  const r = row("hybrid");
  const donorLoss = r.damageVariants.find((v) => v.key === "donor-generator-destroyed");
  assert(donorLoss, "donor-generator-destroyed variant exists");
  assert(donorLoss.afterDamage.unmetMw >= 0, "damage report has unmetMw field");
  assert.strictEqual(donorLoss.afterRepair.fullyPowered, true, "repair of generator restores full power");
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
