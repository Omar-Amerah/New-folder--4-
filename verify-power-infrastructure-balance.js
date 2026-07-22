#!/usr/bin/env node
"use strict";

// Section 7H — Power-infrastructure balance-target verifier.
// Asserts the intended economic and behavioural trade-offs of the final
// authoritative values against the machine-readable reference report:
// conventional wiring cost range, distinct tier roles, architecture
// trade-offs and the provisional overload-protection timings.

const assert = require("assert");
const { BALANCE } = require("./src/server/balanceConfig");
const { PARTS } = require("./src/server/components");
const componentPower = require("./src/server/componentPower");
const { updateShipPowerProtection } = require("./src/server/powerProtection");
const fixtures = require("./test-fixtures/powerInfrastructureReferenceShips");
const harness = require("./test-fixtures/dataSupportRuntimeHarness");
const report = require("./tools/report-power-infrastructure-balance");

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

const rows = report.build();
const row = (key) => {
  const found = rows.find((r) => r.key === key);
  assert(found, `report row ${key}`);
  return found;
};
const TIERS = BALANCE.wiringInfrastructure.powerTiers;
const CONFIG = componentPower.powerProtectionConfig();

// ---------------------------------------------------------------------------
console.log("Conventional wiring cost");
// ---------------------------------------------------------------------------
check("8. conventional frigate infrastructure cost sits in the intended 5-10% range", () => {
  const frigate = row("frigate").economics;
  assert(frigate.wiringPercentOfTotal >= 5 && frigate.wiringPercentOfTotal <= 10,
    `frigate wiring ${frigate.wiringPercentOfTotal}% must be within 5-10%`);
  assert(frigate.wiringPercentOfTotal <= 7.5, "a simple no-Switchgear frigate stays in the lower part of the range");
  assert.strictEqual(frigate.switchgearCost, 0, "frigate carries no optional Switchgear");
  // Switchgear is reported separately and included in the combined total.
  const hybrid = row("hybrid").economics;
  assert.strictEqual(hybrid.switchgearCost, 2 * PARTS.switchgear.cost);
  assert(Math.abs(hybrid.combinedInfrastructureCost - (hybrid.infrastructureCost + hybrid.switchgearCost)) < 1e-9);
  assert(hybrid.combinedPercentOfTotal > hybrid.wiringPercentOfTotal, "combined total includes Switchgear");
  // Small utility hulls sit below the conventional range; the redundant ring
  // exceeds the frigate for a clear resilience benefit (never forced to 5-10%).
  assert(row("interceptor").economics.wiringPercentOfTotal < 5);
  assert(row("cheapBus").economics.wiringPercentOfTotal < 5);
  assert(row("ring").economics.wiringPercentOfTotal > frigate.wiringPercentOfTotal);
});

// ---------------------------------------------------------------------------
console.log("Tier usefulness");
// ---------------------------------------------------------------------------
check("9/10/11. Light is cheapest/lowest displacement, Heavy highest, Standard in between", () => {
  assert(TIERS.light.costPerHostedCell < TIERS.standard.costPerHostedCell && TIERS.standard.costPerHostedCell < TIERS.heavy.costPerHostedCell);
  assert(TIERS.light.heatCapacityDisplacement < TIERS.standard.heatCapacityDisplacement && TIERS.standard.heatCapacityDisplacement < TIERS.heavy.heatCapacityDisplacement);
  assert(TIERS.light.sustainedCapacityMw < TIERS.standard.sustainedCapacityMw && TIERS.standard.sustainedCapacityMw < TIERS.heavy.sustainedCapacityMw);
  assert(TIERS.light.peakCapacityMw < TIERS.standard.peakCapacityMw && TIERS.standard.peakCapacityMw < TIERS.heavy.peakCapacityMw);
  // Standard is the frigate's trunk tier; Light only serves final branches.
  const frigateWiring = row("frigate").wiring;
  assert(frigateWiring.uniqueCellsByTier.standard > 0 && frigateWiring.uniqueCellsByTier.light > 0 && frigateWiring.uniqueCellsByTier.heavy === 0);
});
check("12. Heavy everywhere is inefficient on the interceptor", () => {
  const base = fixtures.lightInterceptor();
  const heavyEverywhere = fixtures.withUniformPowerTier(base, "heavy");
  const baseRow = report.buildFixtureRow(base);
  const heavyRow = report.buildFixtureRow({ ...heavyEverywhere, expected: base.expected, damageVariants: [] });
  assert(heavyRow.economics.powerWiringCost >= baseRow.economics.powerWiringCost * 4, "heavy wiring costs several times more");
  assert(heavyRow.displacement.power >= baseRow.displacement.power * 3, "heavy wiring displaces far more Heat capacity");
  assert.strictEqual(heavyRow.power.deliveredDemandMw, baseRow.power.deliveredDemandMw, "identical delivered Power — pure waste");
});
check("13. Light everywhere cannot satisfy the heavy combat fixture", () => {
  const base = fixtures.heavyCombat();
  const lightEverywhere = fixtures.withUniformPowerTier(base, "light");
  const ship = harness.createRuntimeShip({ ...lightEverywhere, damageVariants: [] });
  const summary = ship.powerFlow.summary;
  assert(summary.unmetMw > 5, `light trunk starves the heavy loadout (unmet ${summary.unmetMw} MW)`);
  assert.strictEqual(report.buildFixtureRow(base).power.unmetDemandMw, 0, "the intended Heavy trunk fully serves it");
});
check("14. Heavy cable downstream of a Light bottleneck does not remove the bottleneck", () => {
  const base = fixtures.lightInterceptor();
  const copy = fixtures.cloneReferenceFixture(base);
  // Upgrade only the final section to Heavy; the upstream Light sections
  // remain the bottleneck.
  copy.wiring.power.sections = copy.wiring.power.sections.map((s) => (s.id === "2,0:3,0" ? { ...s, tier: "heavy" } : s));
  const ship = harness.createRuntimeShip({ ...copy, damageVariants: [] });
  const blasterIndex = fixtures.componentIndexAt(ship.design, 3, 0);
  ship._activityDemandByIndex = { [blasterIndex]: 20 };
  componentPower.reallocateShipPower(ship, "bottleneck-probe");
  const delivered = ship.componentPower.byComponentIndex[blasterIndex].allocatedMw;
  assert(delivered <= TIERS.light.peakCapacityMw + 1e-9, `delivery stays capped by the upstream Light peak (${delivered} MW)`);
});

// ---------------------------------------------------------------------------
console.log("Architecture trade-offs");
// ---------------------------------------------------------------------------
check("distributed grids trade duplicated generation and stranded spare for trunk savings", () => {
  const distributed = row("distributed");
  const frigate = row("frigate");
  assert(distributed.power.networkCount === 2, "independent local grids");
  assert(distributed.economics.powerWiringCost < frigate.economics.powerWiringCost, "no long trunk to pay for");
  const overProvision = distributed.power.installedGenerationMw - distributed.power.requestedDemandMw;
  const frigateProvision = frigate.power.installedGenerationMw - frigate.power.requestedDemandMw;
  assert(overProvision > frigateProvision + 3, "duplicated generation is required");
  assert(distributed.power.spareGenerationMw > 5, "spare capacity is stranded per island");
});
check("17/18. ring survives a single failure and pays a measurable premium", () => {
  const ring = row("ring");
  const frigate = row("frigate");
  const singleFailure = ring.damageVariants.find((v) => v.key === "ring-host-destroyed");
  assert.strictEqual(singleFailure.afterDamage.shedCount, 0, "alternate route retains every consumer");
  assert.strictEqual(singleFailure.afterDamage.unmetMw, 0);
  const split = ring.damageVariants.find((v) => v.key === "ring-split");
  assert(split.afterDamage.shedCount >= 3, "two strategic failures split the ring");
  // Premium: cost and Heat-capacity displacement both exceed the comparable
  // conventional frigate. (Dynamic cable Heat per section is lower because the
  // ring splits flow — the measured Heat cost of redundancy is displacement.)
  assert(ring.economics.infrastructureCost > frigate.economics.infrastructureCost * 1.2, "meaningful cost premium");
  assert(ring.displacement.total > frigate.displacement.total * 1.2, "meaningful displacement premium");
  assert.strictEqual(ring.power.alternatePaths, 1, "redundancy is real, not free capacity");
  assert(ring.power.installedGenerationMw === frigate.power.installedGenerationMw, "no duplicate generation through parallel routes");
  assert(ring.power.deliveredDemandMw <= ring.power.installedGenerationMw, "no generation double-counting");
});
check("19/20. hybrid Automatic tie shares only safe spare Power and protects the donor", () => {
  const hybrid = row("hybrid");
  const tie = hybrid.protection.switchgear.find((s) => s.mode === "automatic");
  assert(tie && tie.conducting, "Automatic tie conducts at baseline");
  assert(Math.abs(tie.transferMw) > 3 && Math.abs(tie.transferMw) < 4, "transfer covers exactly the receiver deficit");
  for (const [category, entry] of Object.entries(hybrid.power.byCategory)) {
    assert.strictEqual(entry.unmetMw, 0, `${category} fully served with the tie conducting`);
  }
  // Donor-side demand protection under scarcity: with the donor reactor gone,
  // the donor's own consumers must not be sacrificed to feed the other grid.
  const donorLoss = hybrid.damageVariants.find((v) => v.key === "donor-generator-destroyed");
  const donorConsumers = ["blaster@3,0", "engine@2,3"];
  for (const key of donorConsumers) {
    assert(donorLoss.afterDamage.consumers.powered.includes(key), `donor consumer ${key} stays fully powered`);
  }
});
check("cheap bus is cheaper but materially less resilient", () => {
  const cheap = row("cheapBus");
  const frigate = row("frigate");
  assert(cheap.economics.infrastructureCost < frigate.economics.infrastructureCost / 3);
  const failure = cheap.damageVariants.find((v) => v.key === "trunk-host-destroyed");
  assert.strictEqual(failure.afterDamage.poweredCount, 0, "one hosted-section failure sheds every consumer");
  assert(failure.afterDamage.shedCount >= 2);
});
check("15/16. central bus vulnerability and distributed independence", () => {
  const frigate = row("frigate");
  const trunkLoss = frigate.damageVariants.find((v) => v.key === "trunk-host-destroyed");
  assert(trunkLoss.afterDamage.shedCount >= 2, "trunk damage severs several downstream consumers");
  const branchLoss = frigate.damageVariants.find((v) => v.key === "branch-host-destroyed");
  assert.strictEqual(branchLoss.afterDamage.unmetMw, 0, "branch damage leaves unrelated branches serviced");
  const distributed = row("distributed");
  const islandLoss = distributed.damageVariants.find((v) => v.key === "island-generator-destroyed");
  assert(islandLoss.afterDamage.consumers.powered.includes("blaster@3,0"), "first island unaffected by second-island damage");
  assert(islandLoss.afterDamage.consumers.powered.includes("engine@2,0"));
});

// ---------------------------------------------------------------------------
console.log("Overload protection timings (provisional defaults)");
// ---------------------------------------------------------------------------
check("slight overload is slow, mid-range much faster, peak trips in about two seconds", () => {
  const timings = row("frigate").protection.overloadTimingsByTier.light;
  assert(Math.abs(timings.secondsToTripAtPeak - 2) <= 0.05, `peak trips in ~2s (${timings.secondsToTripAtPeak})`);
  assert(timings.secondsToTripSlightOverload > 7, `slight overload accumulates slowly (${timings.secondsToTripSlightOverload}s)`);
  assert(timings.secondsToTripSlightOverload > timings.secondsToTripAtPeak * 3, "mid/peak overload trips substantially faster than slight");
  assert(timings.secondsToCriticalAtPeak < timings.secondsToTripAtPeak, "critical stress precedes the trip");
  // Same provisional formula for every tier (ratios identical by design).
  for (const tier of ["standard", "heavy"]) {
    const t = row("frigate").protection.overloadTimingsByTier[tier];
    assert(Math.abs(t.secondsToTripAtPeak - timings.secondsToTripAtPeak) < 1e-9);
  }
});
check("interceptor becomes constrained when overloaded but stays intact", () => {
  const ship = harness.createRuntimeShip(fixtures.lightInterceptor());
  const blasterIndex = fixtures.componentIndexAt(ship.design, 3, 0);
  ship._activityDemandByIndex = { [blasterIndex]: 6 };
  componentPower.reallocateShipPower(ship, "overload-probe");
  for (let i = 0; i < 60; i += 1) updateShipPowerProtection(ship, 0.05);
  const stressed = [...ship._powerProtection.sections.values()].filter((r) => r.stress > 0.5);
  assert(stressed.length >= 1, "overloaded Light wiring accumulates stress");
  assert(ship.componentHp.every((hp) => hp > 0), "physical cables never damage their hosts");
  assert.strictEqual(ship.powerFlow.summary.aboveSustainedSections >= 1, true);
});

console.log(`Section 7H Power-infrastructure balance-target verification passed (${passed} checks).`);
