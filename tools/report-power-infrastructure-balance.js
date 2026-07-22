"use strict";

// Section 7H — deterministic machine-readable Power-infrastructure balance
// report. Every value is computed from authoritative production code
// (computeStats, WiringInfrastructureRules, the runtime Power/protection
// modules and the shared protection/thermal rules); no production formula is
// duplicated here. Output is stable under repeated runs and under
// equivalent component-array reordering.
//
// Usage: node tools/report-power-infrastructure-balance.js [--json]

const { PARTS } = require("../src/server/components");
const { BALANCE } = require("../src/server/balanceConfig");
const { computeStats } = require("../src/server/shipStats");
const WiringInfrastructureRules = require("../public/src/shared/wiringInfrastructureRules.js");
const PowerProtectionRules = require("../public/src/shared/powerProtectionRules");
const { powerProtectionConfig } = require("../src/server/componentPower");
const { updateShipPowerProtection } = require("../src/server/powerProtection");
const fixtures = require("../test-fixtures/powerInfrastructureReferenceShips");
const harness = require("../test-fixtures/dataSupportRuntimeHarness");

const round3 = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const rounded = Math.round(n * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const sortStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function consumerKey(design, index) {
  const module = design[index];
  return `${module.type}@${module.x},${module.y}`;
}

// Consumer service classification straight from the authoritative allocation.
function consumerOutcomes(ship) {
  const outcome = { connected: [], powered: [], partial: [], shed: [] };
  (ship.componentPower?.byComponentIndex || []).forEach((entry, index) => {
    if (entry.role !== "consumer" || (ship.componentHp?.[index] ?? 0) <= 0) return;
    const key = consumerKey(ship.design, index);
    if (entry.state !== "disconnected") outcome.connected.push(key);
    if (entry.state === "powered") outcome.powered.push(key);
    else if (entry.state === "underpowered") outcome.partial.push(key);
    else outcome.shed.push(key);
  });
  for (const list of Object.values(outcome)) list.sort(sortStrings);
  return outcome;
}

function sectionTierCounts(wiring) {
  const counts = { light: 0, standard: 0, heavy: 0 };
  for (const section of wiring.power.sections) counts[section.tier] = (counts[section.tier] || 0) + 1;
  return counts;
}

// Graph cycle rank (independent alternate paths) of the operational Power
// topology: E - V + C over section endpoints.
function alternatePathCount(ship) {
  const flows = ship.powerFlow?.sectionFlows || [];
  const cells = new Set();
  let edges = 0;
  for (const flow of flows) {
    const [a, b] = String(flow.sectionId).startsWith("switchgear:")
      ? [null, null]
      : String(flow.sectionId).split(":");
    edges += 1;
    if (a && b) { cells.add(a); cells.add(b); }
  }
  for (const flow of flows) {
    if (String(flow.sectionId).startsWith("switchgear:")) {
      // Synthetic edges join two cells too; count their terminals from the
      // runtime Switchgear records.
      const record = (ship.runtimeSwitchgear || []).find((r) => r.internalEdgeId === flow.sectionId);
      if (record) { cells.add(`${record.terminalA.x},${record.terminalA.y}`); cells.add(`${record.terminalB.x},${record.terminalB.y}`); }
    }
  }
  const networks = ship.powerFlow?.networks?.length || 0;
  return Math.max(0, edges - cells.size + networks);
}

// Worst-case overload timings from the shared protection rules at the tier's
// peak flow (production formula, production configuration).
function overloadTimings(config, sustained, peak) {
  const rateAtPeak = PowerProtectionRules.stressRatePerSecond(peak, sustained, peak, config);
  const rateSlight = PowerProtectionRules.stressRatePerSecond(sustained * 1.05, sustained, peak, config);
  return {
    secondsToCriticalAtPeak: round3(config.criticalStressRatio / rateAtPeak),
    secondsToTripAtPeak: round3(config.tripStressThreshold / rateAtPeak),
    secondsToTripSlightOverload: round3(config.tripStressThreshold / rateSlight)
  };
}

function byCategoryRows(summary) {
  const out = {};
  for (const [category, entry] of Object.entries(summary.byCategory || {})) {
    out[category] = { requestedMw: round3(entry.demandMw), deliveredMw: round3(entry.allocatedMw), unmetMw: round3(entry.unmetMw) };
  }
  return out;
}

function damageVariantRow(fixture, variant) {
  const ship = harness.createRuntimeShip(fixture);
  const indices = variant.cells.map(([x, y]) => fixtures.componentIndexAt(ship.design, x, y));
  const { beginComponentLifecycleBatch, endComponentLifecycleBatch } = require("../src/server/componentHealth");
  global.__mfaDataSupportPerf = {};
  beginComponentLifecycleBatch(ship);
  for (const index of indices) harness.destroyComponent(ship, index);
  endComponentLifecycleBatch(ship);
  const damageCounters = { ...global.__mfaDataSupportPerf };
  global.__mfaDataSupportPerf = null;
  updateShipPowerProtection(ship, 0.1);
  const damaged = consumerOutcomes(ship);
  const damagedSummary = ship.powerFlow.summary;
  // Repair with one combined budget through the production repair path (the
  // repair system chooses its own most-damaged-first order, so per-index
  // budgets would be order-dependent), batched into a single lifecycle flush.
  const { repairShipComponents } = require("../src/server/componentHealth");
  const totalMissing = indices.reduce((sum, index) => sum + Math.max(0, (ship.componentMaxHp?.[index] || 0) - (ship.componentHp?.[index] || 0)), 0);
  beginComponentLifecycleBatch(ship);
  if (totalMissing > 0) repairShipComponents({ effects: [], ships: new Map([[ship.id, ship]]) }, ship, totalMissing, Date.now());
  endComponentLifecycleBatch(ship);
  updateShipPowerProtection(ship, 0.1);
  const repaired = consumerOutcomes(ship);
  const repairedStress = [...(ship._powerProtection?.sections.values() || [])].reduce((max, record) => Math.max(max, record.stress), 0);
  return {
    key: variant.key,
    role: variant.role,
    description: variant.description,
    destroyed: variant.cells.map(([x, y]) => consumerKey(fixture.design, fixtures.componentIndexAt(fixture.design, x, y))).sort(),
    afterDamage: {
      consumers: damaged,
      poweredCount: damaged.powered.length,
      partialCount: damaged.partial.length,
      shedCount: damaged.shed.length,
      unmetMw: round3(damagedSummary.unmetMw)
    },
    lifecycleCounters: {
      wiringRebuilds: damageCounters.wiringNormalizationCount || 0,
      powerSolves: damageCounters.powerFlowSolveCount || 0,
      hostedRebuilds: damageCounters.hostedWiringRebuildCount || 0
    },
    afterRepair: {
      consumers: repaired,
      fullyPowered: repaired.partial.length === 0 && repaired.shed.length === 0,
      maxResidualStress: round3(repairedStress)
    }
  };
}

function buildFixtureRow(fixture) {
  const stats = computeStats(fixture.design, fixture.wiring);
  const breakdown = stats.costBreakdown;
  const accounting = WiringInfrastructureRules.accountInfrastructure(fixture.design, fixture.wiring, PARTS, BALANCE.wiringInfrastructure);
  const config = powerProtectionConfig();

  const ship = harness.createRuntimeShip(fixture);
  updateShipPowerProtection(ship, 0.1);
  const summary = ship.powerFlow.summary;
  const physicalFlows = ship.powerFlow.sectionFlows.filter((flow) => !String(flow.sectionId).startsWith("switchgear:"));
  const maxSustained = physicalFlows.reduce((max, flow) => Math.max(max, flow.sustainedUtilisation), 0);
  const maxPeak = physicalFlows.reduce((max, flow) => Math.max(max, flow.peakUtilisation), 0);
  const cableSummary = ship.powerCableThermalAnalysis?.summary || {};

  const switchgearCost = fixture.expected.switchgearComponentCost;
  const combinedInfrastructure = breakdown.totalInfrastructure + switchgearCost;

  // Demand-change refresh counters: a pure demand change must re-solve flow
  // without rebuilding hosted mappings or topology.
  const demandProbe = harness.createRuntimeShip(fixture);
  global.__mfaDataSupportPerf = {};
  demandProbe._activityDemandByIndex = Object.fromEntries(demandProbe.design.map((module, index) => [index, (Number(PARTS[module.type].powerUse) || 0) * 0.5]));
  require("../src/server/componentPower").reallocateShipPower(demandProbe, "report-demand-change");
  const demandCounters = { ...global.__mfaDataSupportPerf };
  global.__mfaDataSupportPerf = null;

  const tiers = BALANCE.wiringInfrastructure.powerTiers;
  return {
    key: fixture.key,
    name: fixture.name,
    architecture: fixture.architecture,
    economics: {
      totalShipCost: round3(stats.unitCost),
      preInfrastructureShipCost: round3(breakdown.preInfrastructureShipCost),
      componentCost: round3(fixture.design.reduce((sum, m) => sum + (Number(PARTS[m.type].cost) || 0), 0)),
      powerWiringCost: round3(breakdown.powerWiring),
      dataWiringCost: round3(breakdown.dataWiring),
      switchgearCost: round3(switchgearCost),
      infrastructureCost: round3(breakdown.totalInfrastructure),
      combinedInfrastructureCost: round3(combinedInfrastructure),
      wiringPercentOfTotal: round3(breakdown.infrastructurePercentage * 100),
      combinedPercentOfTotal: round3(stats.unitCost > 0 ? (combinedInfrastructure / stats.unitCost) * 100 : 0),
      totalMass: round3(stats.mass)
    },
    displacement: {
      power: round3(accounting.power.displacement),
      data: round3(accounting.data.displacement),
      total: round3(accounting.power.displacement + accounting.data.displacement)
    },
    wiring: {
      sectionCountByTier: sectionTierCounts(fixture.wiring),
      uniqueCellsByTier: {
        light: accounting.power.cellsByTier.light.length,
        standard: accounting.power.cellsByTier.standard.length,
        heavy: accounting.power.cellsByTier.heavy.length
      },
      dataCells: accounting.data.uniqueHostedCellCount
    },
    power: {
      installedGenerationMw: round3(summary.availableGenerationMw),
      requestedDemandMw: round3(summary.demandMw),
      deliveredDemandMw: round3(summary.allocatedMw),
      unmetDemandMw: round3(summary.unmetMw),
      spareGenerationMw: round3(summary.spareGenerationMw),
      byCategory: byCategoryRows(summary),
      networkCount: ship.powerFlow.networks.length,
      alternatePaths: alternatePathCount(ship),
      maxSustainedUtilisation: round3(maxSustained),
      maxPeakUtilisation: round3(maxPeak),
      sectionsAboveSustained: summary.aboveSustainedSections,
      sectionsAtPeak: summary.atPeakSections
    },
    heat: {
      powerCableHeatRate: round3(ship.powerCableHeatRate),
      hottestSectionId: cableSummary.hottestSectionId || null
    },
    protection: {
      state: ship.powerProtectionDiagnostics?.state || "normal",
      overloadTimingsByTier: {
        light: overloadTimings(config, tiers.light.sustainedCapacityMw, tiers.light.peakCapacityMw),
        standard: overloadTimings(config, tiers.standard.sustainedCapacityMw, tiers.standard.peakCapacityMw),
        heavy: overloadTimings(config, tiers.heavy.sustainedCapacityMw, tiers.heavy.peakCapacityMw)
      },
      switchgear: (ship.runtimeSwitchgear || []).map((record) => ({
        at: `${record.terminalA.x},${record.terminalA.y}`,
        mode: record.mode,
        state: record.state,
        conducting: record.conducts,
        ratingTier: record.ratingTier,
        transferMw: round3(record.signedTransferMw)
      })).sort((a, b) => sortStrings(a.at, b.at))
    },
    counters: {
      demandChange: {
        powerSolves: demandCounters.powerFlowSolveCount || 0,
        wiringRebuilds: demandCounters.wiringNormalizationCount || 0,
        hostedRebuilds: demandCounters.hostedWiringRebuildCount || 0
      }
    },
    baselineConsumers: consumerOutcomes(ship),
    damageVariants: (fixture.damageVariants || []).map((variant) => damageVariantRow(fixture, variant))
  };
}

function build() {
  return fixtures.allReferenceShips()
    .sort((a, b) => sortStrings(a.key, b.key))
    .map(buildFixtureRow);
}

function print(rows) {
  console.log("Section 7H Power-infrastructure balance report");
  console.log("Computed from authoritative production stats/wiring/power/protection code; not live telemetry.\n");
  for (const row of rows) {
    const e = row.economics;
    console.log(`## ${row.name} (${row.architecture})`);
    console.log(`Cost ${e.totalShipCost} (components ${e.preInfrastructureShipCost}, Power wiring ${e.powerWiringCost}, Data ${e.dataWiringCost}, Switchgear ${e.switchgearCost}) · wiring ${e.wiringPercentOfTotal}% · with Switchgear ${e.combinedPercentOfTotal}% · mass ${e.totalMass}`);
    console.log(`Displacement P/D ${row.displacement.power}/${row.displacement.data} · cells L/S/H ${row.wiring.uniqueCellsByTier.light}/${row.wiring.uniqueCellsByTier.standard}/${row.wiring.uniqueCellsByTier.heavy} · Data cells ${row.wiring.dataCells}`);
    console.log(`Power ${row.power.deliveredDemandMw}/${row.power.requestedDemandMw} MW delivered (unmet ${row.power.unmetDemandMw}, spare ${row.power.spareGenerationMw}) · networks ${row.power.networkCount} · alt paths ${row.power.alternatePaths} · max util ${row.power.maxSustainedUtilisation}`);
    console.log(`Cable Heat ${row.heat.powerCableHeatRate} H/s (hottest ${row.heat.hottestSectionId || "none"}) · protection ${row.protection.state}`);
    for (const variant of row.damageVariants) {
      console.log(`- damage ${variant.key}: powered ${variant.afterDamage.poweredCount}, partial ${variant.afterDamage.partialCount}, shed ${variant.afterDamage.shedCount}, unmet ${variant.afterDamage.unmetMw} MW · rebuilds ${variant.lifecycleCounters.wiringRebuilds} · repaired fully powered ${variant.afterRepair.fullyPowered}`);
    }
    console.log("");
  }
}

module.exports = { build, buildFixtureRow };

if (require.main === module) {
  const rows = build();
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else print(rows);
}
