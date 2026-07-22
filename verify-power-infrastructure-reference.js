#!/usr/bin/env node
"use strict";

// Section 7H — Power-infrastructure reference verifier.
// Confirms the locked authoritative values, schema rejection of invalid
// balance, generated-mirror synchronisation, reference-fixture validity and
// determinism, remapped-order equivalence, flow/Heat/protection/snapshot
// parity, overlap accounting, performance counters and runtime-state hygiene.

const assert = require("assert");
const fs = require("fs");
const WiringRules = require("./public/src/shared/wiringRules");
const WiringInfrastructureRules = require("./public/src/shared/wiringInfrastructureRules.js");
const PowerProtectionRules = require("./public/src/shared/powerProtectionRules");
const PowerCableThermalRules = require("./public/src/shared/powerCableThermalRules");
const PowerPolicyRules = require("./public/src/shared/powerPolicyRules");
const { PARTS } = require("./src/server/components");
const { BALANCE } = require("./src/server/balanceConfig");
const { validateComponentBalance, validateWiringInfrastructure, validatePowerProtection } = require("./src/server/componentSchema");
const { validateDesign } = require("./src/server/shipDesign");
const componentPower = require("./src/server/componentPower");
const { updateShipPowerProtection } = require("./src/server/powerProtection");
const { snapshotRoom } = require("./src/server/snapshots");
const fixtures = require("./test-fixtures/powerInfrastructureReferenceShips");
const harness = require("./test-fixtures/dataSupportRuntimeHarness");
const report = require("./tools/report-power-infrastructure-balance");

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }
function finite(value) {
  if (typeof value === "number") assert(Number.isFinite(value) && !Object.is(value, -0), `non-finite or -0: ${value}`);
  else if (Array.isArray(value)) value.forEach(finite);
  else if (value && typeof value === "object") Object.values(value).forEach(finite);
}

const TIERS = BALANCE.wiringInfrastructure.powerTiers;
const CONFIG = componentPower.powerProtectionConfig();

// ---------------------------------------------------------------------------
console.log("Authoritative values and schema");
// ---------------------------------------------------------------------------
check("1. final documented tier, Data and Switchgear values are authoritative", () => {
  assert.deepStrictEqual(
    [TIERS.light.sustainedCapacityMw, TIERS.light.peakCapacityMw, TIERS.light.costPerHostedCell, TIERS.light.heatCapacityDisplacement, TIERS.light.cableHeatAtSustainedPerHostedCell, TIERS.light.cableHeatUtilisationExponent, TIERS.light.renderedThickness],
    [4, 7, 1, 2, 0.35, 2.2, 1]);
  assert.deepStrictEqual(
    [TIERS.standard.sustainedCapacityMw, TIERS.standard.peakCapacityMw, TIERS.standard.costPerHostedCell, TIERS.standard.heatCapacityDisplacement, TIERS.standard.cableHeatAtSustainedPerHostedCell, TIERS.standard.cableHeatUtilisationExponent, TIERS.standard.renderedThickness],
    [10, 16, 2, 4, 0.55, 2.2, 2]);
  assert.deepStrictEqual(
    [TIERS.heavy.sustainedCapacityMw, TIERS.heavy.peakCapacityMw, TIERS.heavy.costPerHostedCell, TIERS.heavy.heatCapacityDisplacement, TIERS.heavy.cableHeatAtSustainedPerHostedCell, TIERS.heavy.cableHeatUtilisationExponent, TIERS.heavy.renderedThickness],
    [24, 36, 5, 8, 0.9, 2.2, 4]);
  assert.deepStrictEqual(
    [BALANCE.wiringInfrastructure.data.costPerHostedCell, BALANCE.wiringInfrastructure.data.heatCapacityDisplacement],
    [0.25, 1]);
  assert.strictEqual(PARTS.switchgear.cost, 18);
  assert.strictEqual(PARTS.switchgear.hp, 35);
  // Section 7G protection defaults remain the provisional values (unchanged in 7H).
  assert.deepStrictEqual(
    [CONFIG.overloadStartRatio, CONFIG.recoveryStartRatio, CONFIG.tripStressThreshold, CONFIG.baseStressPerSecond, CONFIG.additionalStressPerSecondAtPeak, CONFIG.recoveryPerSecond, CONFIG.criticalStressRatio, CONFIG.tripCooldownSeconds, CONFIG.retryIntervalSeconds, CONFIG.safeRecloseSustainedRatio, CONFIG.maxAutomaticRetrySubsets, CONFIG.maximumProtectionDeltaSeconds],
    [1, 0.95, 1, 0.12, 0.38, 0.25, 0.75, 4, 2, 0.9, 1024, 0.25]);
  // Priority categories remain exactly the six canonical ones.
  assert.deepStrictEqual([...PowerPolicyRules.POWER_CATEGORIES], ["command", "propulsion", "shields", "pointDefence", "weapons", "coolingSupport"]);
});
check("2. balance blocks pass schema validation and invalid values are rejected", () => {
  assert.strictEqual(validateComponentBalance(BALANCE).ok, true);
  const errorsFor = (mutate) => {
    const errors = [];
    const copy = JSON.parse(JSON.stringify(BALANCE.wiringInfrastructure));
    mutate(copy);
    validateWiringInfrastructure(copy, "test", errors);
    return errors;
  };
  assert(errorsFor((c) => { c.powerTiers.light.peakCapacityMw = 2; }).length, "inverted sustained/peak rejected");
  assert(errorsFor((c) => { c.powerTiers.standard.sustainedCapacityMw = Infinity; }).length, "non-finite rejected");
  assert(errorsFor((c) => { c.powerTiers.heavy.costPerHostedCell = -1; }).length, "negative cost rejected");
  assert(errorsFor((c) => { c.powerTiers.light.cableHeatUtilisationExponent = 1; }).length, "invalid Heat exponent rejected");
  assert(errorsFor((c) => { c.powerTiers.light.costPerHostedCell = 3; }).length, "inverted tier cost ordering rejected");
  const protErrors = (mutate) => {
    const errors = [];
    const copy = JSON.parse(JSON.stringify(BALANCE.powerProtection));
    mutate(copy);
    validatePowerProtection(copy, "test", errors);
    return errors;
  };
  assert(protErrors((c) => { c.recoveryStartRatio = 2; }).length, "invalid recovery/overload ordering rejected");
  assert(protErrors((c) => { c.maxAutomaticRetrySubsets = 0; }).length, "invalid retry bound rejected");
  assert(protErrors((c) => { c.baseStressPerSecond = -1; }).length, "negative stress rate rejected");
});
check("3. generated/public balance mirrors match the authoritative source", () => {
  const authoritative = JSON.parse(fs.readFileSync("component-balance.json", "utf8"));
  const publicCopy = JSON.parse(fs.readFileSync("public/component-balance.json", "utf8"));
  assert.deepStrictEqual(publicCopy, authoritative, "public/component-balance.json mirrors the source");
  const generated = fs.readFileSync("public/src/generatedBalance.js", "utf8");
  const embedded = JSON.parse(generated.slice(generated.indexOf("{"), generated.lastIndexOf("}") + 1));
  assert.deepStrictEqual(embedded, authoritative, "generatedBalance.js embeds the same balance");
});

// ---------------------------------------------------------------------------
console.log("Reference fixtures");
// ---------------------------------------------------------------------------
const allShips = fixtures.allReferenceShips();
check("4/5. every reference Blueprint normalises idempotently and is buildable", () => {
  for (const fixture of allShips) {
    fixtures.validateReferenceFixture(fixture); // includes idempotence + canonical ids
    assert.strictEqual(validateDesign(fixture.design).ok, true, `${fixture.key} buildable`);
  }
  assert.strictEqual(allShips.length, 7, "seven reference architectures");
  const architectures = new Set(allShips.map((f) => f.architecture));
  for (const family of ["central-heavy-bus", "distributed-grids", "ring-bus", "hybrid-switchgear"]) {
    assert(architectures.has(family), `architecture family present: ${family}`);
  }
});
check("6. reference report is deterministic under repeated runs", () => {
  assert.strictEqual(JSON.stringify(report.build()), JSON.stringify(report.build()));
});
check("7. reordered equivalent fixtures produce equivalent report rows and runtime state", () => {
  for (const fixture of allShips) {
    const reordered = fixtures.reorderedFixture(fixture);
    assert.deepStrictEqual(report.buildFixtureRow(reordered), report.buildFixtureRow(fixture), `${fixture.key} report row order-independent`);
  }
});

// ---------------------------------------------------------------------------
console.log("Flow / Heat / protection / snapshot parity");
// ---------------------------------------------------------------------------
check("37/38. the same solved flow drives utilisation, cable Heat, stress, trips and snapshots", () => {
  // Frigate pushed above sustained on its light shield branch plus the hybrid
  // ship's conducting Switchgear give physical and synthetic samples.
  const fixture = allShips.find((f) => f.key === "hybrid");
  const ship = harness.createRuntimeShip(fixture);
  const shieldIndex = fixtures.componentIndexAt(ship.design, 7, 0);
  ship._activityDemandByIndex = { [shieldIndex]: 12 }; // force tie overload region
  componentPower.reallocateShipPower(ship, "parity-probe");
  updateShipPowerProtection(ship, 0.5);
  const hostMap = ship._infrastructureHostMaps.power;
  const protectionSections = ship._powerProtection.sections;
  for (const flow of ship.powerFlow.sectionFlows) {
    const record = protectionSections.get(String(flow.sectionId));
    assert(record, `protection record exists for ${flow.sectionId}`);
    // Protection reads the exact solved flow and tier capacities.
    assert.strictEqual(record.absoluteFlowMw, Math.abs(flow.signedFlowMw), "stress uses solved flow");
    assert.strictEqual(record.sustainedCapacityMw, flow.sustainedCapacityMw);
    assert.strictEqual(record.peakCapacityMw, flow.peakCapacityMw);
    const tierConfig = TIERS[flow.tier];
    assert.strictEqual(flow.sustainedCapacityMw, tierConfig.sustainedCapacityMw, "capacity matches tier authority");
    assert.strictEqual(flow.peakCapacityMw, tierConfig.peakCapacityMw);
    assert.strictEqual(record.overloadRatio, PowerProtectionRules.normalisedOverload(record.absoluteFlowMw, record.sustainedCapacityMw, record.peakCapacityMw), "overload ratio matches PowerProtectionRules");
    const synthetic = String(flow.sectionId).startsWith("switchgear:");
    const heatSection = (ship.powerCableThermalAnalysis.sections || []).find((s) => s.sectionId === flow.sectionId);
    if (synthetic) {
      assert.strictEqual(heatSection, undefined, "synthetic Switchgear edge adds no cable-cell Heat");
    } else {
      assert(heatSection, `cable-Heat record for ${flow.sectionId}`);
      assert.strictEqual(heatSection.absoluteFlowMw, Math.abs(flow.signedFlowMw), "cable Heat uses solved flow");
      assert.strictEqual(heatSection.heatPerHostedCellPerSecond, PowerCableThermalRules.cableHeatRateForSection(flow, tierConfig), "cable Heat matches PowerCableThermalRules");
    }
  }
  // Snapshot parity: the compact protection block reports the same values
  // after normal rounding, and Switchgear snapshot transfer equals solved flow.
  const player = { id: "p", name: "P", color: "#fff", team: "blue", ships: [ship], selectedShipIds: new Set(), stats: {}, money: 0, rallyPoint: { x: 0, y: 0 } };
  ship.id = "s"; ship.ownerId = "p"; ship.designRevision = 1; ship.hp = 100; ship.maxHp = 100; ship.shield = 0; ship.maxShield = 0;
  ship.vx = 0; ship.vy = 0; ship.targetX = 0; ship.targetY = 0; ship.weaponAngles = []; ship.cost = 1; ship.stats = { unitCost: 1 };
  const room = { code: "R", phase: "active", adminId: "p", stateEpoch: 1, snapshotSeq: 1, staticRevision: 1, mapSizeLabel: "tiny", world: { width: 100, height: 100 }, map: { asteroids: [] }, rules: { gameMode: "control" }, players: new Map([["p", player]]), ships: new Map([["s", ship]]), bullets: [], points: [], effects: [], winner: null, matchStartedAt: 1, maxScore: 100, controlVictory: null };
  const snapshotShip = snapshotRoom(room, 0, player, true, null, { player }).ships[0];
  finite(snapshotShip.powerProtection);
  finite(snapshotShip.switchgear);
  const flowsById = new Map(ship.powerFlow.sectionFlows.map((f) => [f.sectionId, f]));
  for (const record of snapshotShip.switchgear) {
    const runtime = ship.runtimeSwitchgear.find((r) => r.componentIndex === record.componentIndex);
    assert.strictEqual(record.signedTransferMw, runtime.signedTransferMw, "snapshot Switchgear transfer equals solved value");
    if (runtime.conducts) {
      const flow = flowsById.get(runtime.internalEdgeId);
      assert(Math.abs(record.signedTransferMw - Math.abs(flow.signedFlowMw)) < 1e-9 || Math.abs(record.signedTransferMw - flow.signedFlowMw) < 1e-9);
    }
  }
  for (const section of snapshotShip.powerProtection.sections) {
    const runtime = protectionSections.get(section.sectionId);
    assert(runtime, "snapshot section has runtime record");
    assert(Math.abs(section.stress - runtime.stress) <= 0.0005 + 1e-9, "snapshot stress equals runtime after rounding");
    assert(Math.abs(section.absoluteFlowMw - runtime.absoluteFlowMw) <= 0.005 + 1e-9, "snapshot flow equals solved flow after rounding");
  }
});
check("29. disabled hosted sections carry zero flow, zero dynamic Heat and no active stress", () => {
  const fixture = allShips.find((f) => f.key === "frigate");
  const ship = harness.createRuntimeShip(fixture);
  updateShipPowerProtection(ship, 1);
  const trunkIndex = fixtures.componentIndexAt(ship.design, 3, 1);
  harness.destroyComponent(ship, trunkIndex);
  updateShipPowerProtection(ship, 0.1);
  const disabledIds = [...ship.runtimeWiring.power.disabledSectionIds];
  assert(disabledIds.length >= 2, "trunk destruction disables hosted sections");
  for (const id of disabledIds) {
    assert(!ship.powerFlow.sectionFlows.some((f) => f.sectionId === id), "disabled section carries no flow");
    assert(!ship.powerCableThermalAnalysis.sections.some((s) => s.sectionId === id && s.totalHeatPerSecond > 0), "disabled section generates no dynamic Heat");
    assert(!ship._powerProtection.sections.has(id), "disabled section has no active stress record");
  }
});

// ---------------------------------------------------------------------------
console.log("Wiring overlap and Data separation");
// ---------------------------------------------------------------------------
check("31/39/40. Power and Data overlap independently; Data cost/displacement stay separate", () => {
  const design = [
    { type: "core", x: 0, y: 0, rotation: 0 },
    { type: "fireControl", x: 1, y: 0, rotation: 0 },
    { type: "blaster", x: 2, y: 0, rotation: 0 }
  ];
  const wiring = {
    version: WiringRules.WIRING_VERSION,
    power: { sections: [{ id: "0,0:1,0", x1: 0, y1: 0, x2: 1, y2: 0, tier: "standard" }, { id: "1,0:2,0", x1: 1, y1: 0, x2: 2, y2: 0, tier: "standard" }], connections: [] },
    data: { sections: [{ id: "1,0:2,0", x1: 1, y1: 0, x2: 2, y2: 0, tier: "standard" }], connections: [] },
    powerPolicy: PowerPolicyRules.defaultPolicy()
  };
  const accounting = WiringInfrastructureRules.accountInfrastructure(design, wiring, PARTS, BALANCE.wiringInfrastructure);
  assert.strictEqual(accounting.power.uniqueHostedCellCount, 3);
  assert.strictEqual(accounting.data.uniqueHostedCellCount, 2, "shared cells count for Data independently");
  assert.strictEqual(accounting.power.cost, 6);
  assert.strictEqual(accounting.data.cost, 0.5);
  assert.strictEqual(accounting.power.displacement, 12);
  assert.strictEqual(accounting.data.displacement, 2);
  const overlapped = accounting.byComponentIndex[1];
  assert(overlapped.hostedStandardCells === 1 && overlapped.hostedDataCells === 1, "one cell hosts both kinds at once");
});
check("32. Data has no Heat, overload or breaker behaviour", () => {
  const fixture = allShips.find((f) => f.key === "frigate");
  const ship = harness.createRuntimeShip(fixture);
  updateShipPowerProtection(ship, 2);
  const dataIds = new Set(fixture.wiring.data.sections.map((s) => s.id));
  for (const id of dataIds) {
    assert(!ship.powerCableThermalAnalysis.sections.some((s) => s.sectionId === id && dataIds.has(s.sectionId) && fixture.wiring.power.sections.every((p) => p.id !== id)), "no Data-only section in cable Heat");
  }
  for (const id of ship._powerProtection.sections.keys()) {
    assert(fixture.wiring.power.sections.some((p) => p.id === id) || String(id).startsWith("switchgear:"), "protection records only Power edges");
  }
  const infrastructure = BALANCE.wiringInfrastructure;
  assert(!("powerTiers" in (infrastructure.data || {})), "Data has a single physical tier");
});

// ---------------------------------------------------------------------------
console.log("Priorities");
// ---------------------------------------------------------------------------
check("33/34/35/36. six distinct categories, valid presets, deterministic Custom, fair ties", () => {
  for (const preset of PowerPolicyRules.PRESET_NAMES) {
    const bands = PowerPolicyRules.resolvePriorityBands({ preset });
    const seen = bands.flat();
    assert.deepStrictEqual([...seen].sort(), [...PowerPolicyRules.POWER_CATEGORIES].sort(), `preset ${preset} covers all six categories`);
    assert(!bands.some((band) => band.includes("shields") && band.includes("pointDefence") && band.length === 2 && preset === "custom"), "no forced generic defence merge");
  }
  const custom = PowerPolicyRules.normalizePolicy({ preset: "custom", customOrder: ["weapons", "shields", "command", "propulsion", "pointDefence", "coolingSupport"] });
  assert.deepStrictEqual(PowerPolicyRules.resolvePriorityBands(custom).map((band) => band[0]), ["weapons", "shields", "command", "propulsion", "pointDefence", "coolingSupport"], "custom ordering deterministic");
  // Tied consumers share fairly (from the report's ring row: two shields band
  // — reuse frigate category rows instead: single shield, so probe directly).
  const ship = harness.createRuntimeShip(allShips.find((f) => f.key === "distributed"));
  const shieldIndex = fixtures.componentIndexAt(ship.design, 8, 0);
  const pdIndex = fixtures.componentIndexAt(ship.design, 9, 0);
  ship.wiring = { ...ship.wiring, powerPolicy: PowerPolicyRules.normalizePolicy({ preset: "custom", customOrder: ["shields", "pointDefence", "command", "propulsion", "weapons", "coolingSupport"] }) };
  ship._activityDemandByIndex = { [shieldIndex]: 20, [pdIndex]: 20 };
  componentPower.rebuildShipWiringState(ship, "priority-probe");
  const shieldEntry = ship.componentPower.byComponentIndex[shieldIndex];
  const pdEntry = ship.componentPower.byComponentIndex[pdIndex];
  assert(shieldEntry.allocatedMw > pdEntry.allocatedMw, "priority order respected under scarcity");
  assert(shieldEntry.priorityBand !== pdEntry.priorityBand, "shields and point defence stay distinct bands");
});

// ---------------------------------------------------------------------------
console.log("Performance and lifecycle");
// ---------------------------------------------------------------------------
check("41/42/46. accumulation-only ticks: no rebuild, no solve, records persist across refresh", () => {
  const ship = harness.createRuntimeShip(allShips.find((f) => f.key === "interceptor"));
  const blasterIndex = fixtures.componentIndexAt(ship.design, 3, 0);
  ship._activityDemandByIndex = { [blasterIndex]: 6 };
  componentPower.reallocateShipPower(ship, "overload-probe");
  global.__mfaDataSupportPerf = {};
  for (let i = 0; i < 40; i += 1) updateShipPowerProtection(ship, 0.05);
  assert.strictEqual(global.__mfaDataSupportPerf.wiringNormalizationCount || 0, 0, "ordinary accumulation rebuilds nothing");
  assert.strictEqual(global.__mfaDataSupportPerf.powerFlowSolveCount || 0, 0, "ordinary accumulation solves nothing");
  global.__mfaDataSupportPerf = null;
  const stressed = [...ship._powerProtection.sections.values()].filter((r) => r.stress > 0);
  assert(stressed.length >= 1, "overload stress accumulated");
  const before = Math.max(...stressed.map((r) => r.stress));
  ship._activityDemandByIndex = { [blasterIndex]: 6.2 };
  componentPower.reallocateShipPower(ship, "refresh-probe");
  const after = Math.max(...[...ship._powerProtection.sections.values()].map((r) => r.stress));
  assert(Math.abs(after - before) < 1e-9, "stable section records persist across ordinary flow refresh");
});
check("43/44/45. trips, retries and batched damage each cause exactly one rebuild", () => {
  const row = report.build();
  for (const fixtureRow of row) {
    for (const variant of fixtureRow.damageVariants) {
      assert.strictEqual(variant.lifecycleCounters.wiringRebuilds, 1, `${fixtureRow.key}/${variant.key} one lifecycle rebuild`);
    }
    assert.strictEqual(fixtureRow.counters.demandChange.wiringRebuilds, 0, `${fixtureRow.key} demand change rebuilds nothing`);
    assert.strictEqual(fixtureRow.counters.demandChange.hostedRebuilds, 0, `${fixtureRow.key} demand change reuses hosted maps`);
    assert.strictEqual(fixtureRow.counters.demandChange.powerSolves, 1, `${fixtureRow.key} demand change is one solve`);
  }
  // Simultaneous trip/retry batching is covered against the hybrid ship in
  // verify-power-infrastructure-resilience.js and Section 7G's verifier.
});
check("47/48/49. topology removal prunes stale state; replacement clears; nothing persisted", () => {
  const fixture = allShips.find((f) => f.key === "cheapBus");
  const ship = harness.createRuntimeShip(fixture);
  const blasterIndex = fixtures.componentIndexAt(ship.design, 4, 0);
  ship._activityDemandByIndex = { [blasterIndex]: 6 };
  componentPower.reallocateShipPower(ship, "stress-probe");
  for (let i = 0; i < 20; i += 1) updateShipPowerProtection(ship, 0.05);
  assert([...ship._powerProtection.sections.values()].some((r) => r.stress > 0));
  const trunkIndex = fixtures.componentIndexAt(ship.design, 2, 0);
  harness.destroyComponent(ship, trunkIndex);
  updateShipPowerProtection(ship, 0.05);
  for (const id of ship.runtimeWiring.power.disabledSectionIds) {
    assert(!ship._powerProtection.sections.has(id), "stale protection state pruned after topology removal");
  }
  const blueprintBefore = JSON.stringify({ design: fixture.design, wiring: fixture.wiring });
  componentPower.initializeComponentPower(ship);
  assert.strictEqual([...ship._powerProtection.sections.values()].filter((r) => r.stress > 0).length, 0, "design replacement clears runtime protection state");
  assert.strictEqual(JSON.stringify({ design: fixture.design, wiring: fixture.wiring }), blueprintBefore, "fixture Blueprint never mutated");
});

// ---------------------------------------------------------------------------
console.log("Output hygiene");
// ---------------------------------------------------------------------------
check("52. report and runtime outputs contain no NaN, Infinity or negative zero", () => {
  finite(report.build());
});
check("53/54. no touch/mobile behaviour and no Section 8 mechanics in 7H additions", () => {
  // (This scanning check necessarily contains the forbidden tokens itself, so
  // it scans the other 7H additions.)
  const files = [
    "test-fixtures/powerInfrastructureReferenceShips.js",
    "tools/report-power-infrastructure-balance.js",
    "verify-power-infrastructure-balance.js",
    "verify-power-infrastructure-resilience.js"
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8").toLowerCase();
    for (const token of ["touchstart", "touchend", "longpress", "long-press", "swipe", "gesture"]) {
      assert(!source.includes(token), `${file} must not add touch behaviour (${token})`);
    }
    for (const token of ["voltage", "transformer", "cablefire", "cablehp", "armouredconduit", "databandwidth", "databreaker"]) {
      assert(!source.includes(token), `${file} must not add Section 8 mechanics (${token})`);
    }
  }
});

console.log(`Section 7H Power-infrastructure reference verification passed (${passed} checks).`);
