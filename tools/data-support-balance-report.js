"use strict";

const DataRules = require("../public/src/shared/dataSupportRules");
const HeatRules = require("../public/src/shared/heatRules");
const { PARTS } = require("../src/server/components");
const fixtures = require("../tests/fixtures/dataSupportReferenceShips");
const harness = require("../tests/fixtures/dataSupportRuntimeHarness");

const round = (value) => Number.isFinite(Number(value)) ? Math.round(Number(value) * 1000) / 1000 : 0;

function weaponStats(type, support) {
  const base = PARTS[type].weapon;
  const effective = DataRules.effectiveWeaponProfile(base, support);
  return {
    base: { range: round(base.range), accuracy: round(base.accuracy), fireRate: round(base.fireRate), dps: round(base.dps), reload: round(base.reload) },
    effective: { range: round(effective.range), accuracy: round(effective.accuracy), fireRate: round(effective.fireRate), dps: round(effective.dps), reload: round(effective.reload) },
    deltas: { range: round(effective.range - base.range), accuracy: round(effective.accuracy - base.accuracy), fireRate: round(effective.fireRate - base.fireRate), dps: round(effective.dps - base.dps) }
  };
}

function sourceRows(ship, indices) {
  return indices.map((index) => {
    const record = harness.runtimeSourceAllocation(ship, index);
    return {
      index,
      type: ship.design[index].type,
      effect: record.effect,
      nominalBudget: round(record.nominalBudget),
      effectiveBudget: round(record.effectiveBudget),
      sourceMultiplier: round(record.sourceMultiplier),
      thermalMultiplier: round(record.thermalMultiplier),
      operationalMultiplier: round(record.operationalMultiplier),
      recipients: record.eligibleWeaponIndices,
      perRecipient: round(record.bonusPerWeapon),
      status: record.status
    };
  });
}

function weaponRows(ship, indices) {
  return indices.map((index) => {
    const support = harness.runtimeWeaponSupport(ship, index);
    return {
      index,
      type: ship.design[index].type,
      support: {
        rangeBonus: round(support.rangeBonus),
        accuracyBonus: round(support.accuracyBonus),
        fireRateBonus: round(support.fireRateBonus),
        sources: support.sourceIndices,
        contributions: support.contributions.map((entry) => ({ ...entry, amount: round(entry.amount) }))
      },
      ...weaponStats(ship.design[index].type, support)
    };
  });
}

function powerHeatSummary(fixture) {
  return {
    generation: round(fixture.summary.powerGeneration),
    demand: round(fixture.summary.powerUse),
    surplus: round(fixture.summary.powerGeneration - fixture.summary.powerUse),
    heatGeneration: round(fixture.summary.heatGeneration),
    heatCapacity: round(fixture.design.reduce((sum, module) => sum + (PARTS[module.type].heatCapacity || PARTS[module.type].thermalCapacity || 0), 0))
  };
}

function scenarioOutputs(fixture) {
  const source = fixture.expected.sources[0];
  if (source == null) return {};
  const ship = harness.createRuntimeShip(fixture);
  const output = {};
  harness.applyPartialPower(ship, source, 0);
  output.unpowered = sourceRows(ship, [source])[0];
  ship.componentPowerState[source] = 1;
  harness.applyFullPower(ship);
  output.reenabled = sourceRows(ship, [source])[0];
  for (const [label, state] of Object.entries({
    normal: HeatRules.STATE.NORMAL,
    warm: HeatRules.STATE.WARM,
    hot: HeatRules.STATE.HOT,
    critical: HeatRules.STATE.CRITICAL,
    overheated: HeatRules.STATE.OVERHEATED
  })) {
    harness.setSourceThermalState(ship, source, state);
    output[label] = sourceRows(ship, [source])[0];
  }
  harness.destroyComponent(ship, source);
  output.destroyed = sourceRows(ship, [source])[0];
  harness.repairComponent(ship, source);
  output.repaired = sourceRows(ship, [source])[0];
  return output;
}

function damageOutputs(fixture) {
  const ship = harness.createRuntimeShip(fixture);
  const weapon = fixture.expected.weapons[0];
  const output = { baseline: weapon == null ? null : weaponRows(ship, [weapon])[0] };
  if (fixture.key === "redundant") {
    const fireControl = fixtures.firstComponentIndexByType(fixture, "fireControl");
    const signal = fixtures.firstComponentIndexByType(fixture, "signalAmplifier");
    harness.destroyComponent(ship, fireControl);
    output.fireControlDestroyed = weaponRows(ship, [weapon])[0];
    harness.destroyComponent(ship, signal);
    output.allSourcesDestroyed = weaponRows(ship, [weapon])[0];
  } else if (weapon != null) {
    harness.destroyComponent(ship, weapon);
    output.weaponDestroyed = weaponRows(ship, [weapon])[0];
  }
  return output;
}

function build() {
  return fixtures.allReferenceShips().map((fixture) => {
    const ship = harness.createRuntimeShip(fixture);
    const sources = sourceRows(ship, fixture.expected.sources);
    const weapons = weaponRows(ship, fixture.expected.weapons);
    const baseDps = round(weapons.reduce((sum, weapon) => sum + weapon.base.dps, 0));
    const supportedDps = round(weapons.reduce((sum, weapon) => sum + weapon.effective.dps, 0));
    const row = {
      key: fixture.key,
      name: fixture.name,
      components: fixture.design.map((module, index) => ({ index, type: module.type, x: module.x, y: module.y })),
      economics: {
        totalCost: round(fixture.summary.cost),
        supportCost: round(fixture.summary.supportCost),
        weaponCost: round(fixture.summary.weaponCost),
        totalMass: round(fixture.summary.mass),
        opportunityCostRatios: {
          supportCostShare: round(fixture.summary.supportCost / (fixture.summary.cost || 1)),
          supportComponentShare: round(fixture.expected.sources.length / (fixture.design.length || 1))
        }
      },
      powerHeat: powerHeatSummary(fixture),
      data: { linkCount: fixture.summary.dataLinkCount },
      sources,
      weapons,
      totals: { baseDps, supportedDps, dpsDelta: round(supportedDps - baseDps), dpsRatio: round(supportedDps / (baseDps || 1)) },
      scenarios: scenarioOutputs(fixture),
      damage: damageOutputs(fixture)
    };
    row.conclusions = {
      measured: "Measured support changes total theoretical DPS by " + round(row.totals.dpsDelta)
        + " with conserved source budgets and explicit-link-only source membership."
    };
    return row;
  });
}

function print(rows) {
  console.log("Direct Data Links support balance report");
  console.log("Computed from explicit links and runtime component Power/Heat states; not live multiplayer telemetry.\n");
  for (const row of rows) {
    console.log("## " + row.name);
    console.log("Cost " + row.economics.totalCost + " (support " + row.economics.supportCost + ", weapons " + row.economics.weaponCost
      + ") · mass " + row.economics.totalMass + " · Power " + row.powerHeat.generation + "/" + row.powerHeat.demand
      + " MW · Heat " + row.powerHeat.heatGeneration + "/" + row.powerHeat.heatCapacity + " · Data Links " + row.data.linkCount);
    console.log("Base DPS " + row.totals.baseDps + " → supported DPS " + row.totals.supportedDps
      + " (Δ " + row.totals.dpsDelta + ", ×" + row.totals.dpsRatio + ")");
    row.sources.forEach((source) => console.log("- Source #" + source.index + " " + source.type + ": budget " + source.effectiveBudget
      + ", recipients " + (source.recipients.join(",") || "none") + ", each " + source.perRecipient + ", status " + source.status));
    row.weapons.forEach((weapon) => console.log("- Weapon #" + weapon.index + " " + weapon.type
      + ": range " + weapon.base.range + "→" + weapon.effective.range + ", accuracy " + weapon.base.accuracy + "→" + weapon.effective.accuracy
      + ", fire-rate " + weapon.base.fireRate + "→" + weapon.effective.fireRate + ", DPS " + weapon.base.dps + "→" + weapon.effective.dps));
    console.log("Conclusion: " + row.conclusions.measured + "\n");
  }
}

const rows = build();
if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
else print(rows);
