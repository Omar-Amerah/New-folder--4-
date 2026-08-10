"use strict";

const assert = require("assert");
const ShieldRules = require("../public/src/shared/shieldRules");
const RepairRules = require("../public/src/shared/repairRules");
const HeatRules = require("../public/src/shared/heatRules");
const TurretRules = require("../public/src/shared/turretRules");
const EngineExhaustRules = require("../public/src/shared/engineExhaust");
const { PARTS } = require("../src/server/components");
const { BALANCE } = require("../src/server/balanceConfig");
const { computeStats: serverComputeStats } = require("../src/server/shipStats");

globalThis.HeatRules = HeatRules;
globalThis.TurretRules = TurretRules;
globalThis.EngineExhaustRules = EngineExhaustRules;
globalThis.document = {
  createElement: () => ({
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    appendChild() {},
    getContext: () => null
  }),
  createElementNS: () => ({ setAttribute() {}, appendChild() {} }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  documentElement: { style: { setProperty() {} } },
  body: { classList: { add() {}, remove() {} } }
};
globalThis.window = { devicePixelRatio: 1, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

function close(actual, expected, message) {
  assert(Math.abs(Number(actual) - Number(expected)) < 1e-9,
    `${message}: expected ${expected}, got ${actual}`);
}

function designFor(types) {
  return types.map((type, index) => ({ type, x: 7 + index, y: 7, rotation: 0 }));
}

(async () => {
  const { PART_STATS, PART_DEFS, partCategory, partDescription } = await import("../public/src/design/parts.js");
  const { GENERATED_BALANCE } = await import("../public/src/generatedBalance.js");
  const Inspector = await import("../public/src/design/componentInspectorModel.js");
  const ClientStats = await import("../public/src/design/componentStats.js");
  const Summary = await import("../public/src/design/shipSummaryModel.js");
  const Mechanics = await import("../public/src/ledger/componentMechanics.js");
  const Ledger = await import("../public/src/ledger/ledgerContent.js");

  const build = (type) => Inspector.buildComponentInspectorModel(type, PART_STATS[type], {
    name: PART_DEFS[type]?.name || type,
    description: partDescription(type, PART_STATS[type]),
    category: partCategory(type),
    effectiveCost: `$${PART_STATS[type].cost}`,
    prediction: null
  });
  const allRows = (model) => [
    ...model.core,
    ...model.capability,
    ...model.thermalSummary,
    ...model.sections.flatMap((section) => section.rows)
  ];

  const impactRate = ShieldRules.getShieldImpactHeatPerDamage();
  close(impactRate, 0.12, "Shield impact Heat rule remains authoritative");
  assert.equal(ShieldRules.IMPACT_HEAT_PER_BLOCKED_DAMAGE, impactRate, "Shield rule exports the same impact Heat rate");
  assert.equal(100 * impactRate, 12, "Shield impact Heat example is 12 H total");

  const shieldTypes = Object.entries(PART_STATS)
    .filter(([, stat]) => Number(stat.shield || 0) > 0)
    .map(([type]) => type);
  assert(shieldTypes.includes("shield"), "standard Shield is covered");
  assert(shieldTypes.includes("aegisProjector"), "Aegis Projector is covered");
  for (const type of shieldTypes) {
    const rows = allRows(build(type));
    const impact = rows.find((row) => row.id === "shield.impactHeat");
    const source = rows.find((row) => row.id === "shield.impactHeatSource");
    const distribution = rows.find((row) => row.id === "shield.impactHeatDistribution");
    const example = rows.find((row) => row.id === "shield.impactHeatExample");
    assert(impact, `${type} shows Shield impact Heat`);
    assert.equal(impact.value, "0.12 H / damage blocked", `${type} derives the Shield impact rate`);
    assert.equal(source?.value, "Damage absorbed by Shields generates Heat in the Shield system.", `${type} explains the Heat source`);
    assert.equal(distribution?.value, "Impact Heat is distributed across the ship's active Shield generators.", `${type} explains total Heat distribution`);
    assert.equal(example?.value, "100 Shield damage blocked = 12 H total", `${type} shows a total example`);
    assert(!rows.some((row) => /12 H per generator/i.test(row.value)), `${type} does not imply 12 H per generator`);
  }

  const localRepairTypes = Object.entries(PART_STATS)
    .filter(([type, stat]) => RepairRules.isLocalRepairSource(type, stat))
    .map(([type]) => type);
  assert(localRepairTypes.includes("repair"), "standard Repair uses the local stack");
  assert(localRepairTypes.includes("overclockedRepair"), "Overclocked Repair uses the local stack");
  for (const type of localRepairTypes) {
    const rows = allRows(build(type));
    assert.equal(rows.find((row) => row.id === "repair.stacking")?.value, "Diminishing returns", `${type} states diminishing Repair returns`);
    assert.equal(rows.find((row) => row.id === "repair.stackRule")?.value,
      "Additional Repair modules contribute 80% as much as the previous one.", `${type} states the 80% Repair rule`);
    assert.match(rows.find((row) => row.id === "repair.stackProgression")?.value || "", /1st: 100%.*2nd: 80%.*3rd: 64%.*4th: 51\.2%/,
      `${type} states the Repair progression`);
  }
  const beamRows = allRows(build("repairBeam"));
  assert(!beamRows.some((row) => row.id === "repair.stacking"), "Repair Beam does not receive the local Repair warning");

  close(RepairRules.getRepairStackingMultiplier(BALANCE), 0.8, "Repair stack authority is 0.8");
  close(RepairRules.getEffectiveRepairRate([8, 8], BALANCE), 14.4, "two equal Repair sources stack to 14.4");
  close(RepairRules.getEffectiveRepairRate([8, 8, 8], BALANCE), 19.52, "three equal Repair sources stack to 19.52");
  close(RepairRules.getEffectiveRepairRate([8, 24], BALANCE), RepairRules.getEffectiveRepairRate([24, 8], BALANCE), "Repair order is invariant");

  const two = designFor(["core", "frame", "repair", "repair"]);
  const three = designFor(["core", "frame", "repair", "repair", "repair"]);
  for (const [label, design, expected, installed] of [["two", two, 14.4, 16], ["three", three, 19.52, 24]]) {
    const server = serverComputeStats(design);
    const client = ClientStats.computeStats(design);
    close(server.repairRateInstalled, installed, `${label} server Installed/Base Repair`);
    close(client.repairRateInstalled, installed, `${label} client Installed/Base Repair`);
    close(server.repairRate, expected, `${label} server Effective Repair`);
    close(client.repairRate, expected, `${label} client Effective Repair`);
    close(server.repairRate, client.repairRate, `${label} server/client Effective Repair parity`);
    assert.equal(server.repairRateSourceCount, 2 + (label === "three" ? 1 : 0), `${label} Repair source count`);
  }

  const summary = Summary.buildShipSummaryModel(ClientStats.computeStats(two), { design: two });
  const support = summary.sections.find((section) => section.id === "support");
  assert(support, "Ship summary includes Support details");
  assert.equal(support.rows.find((row) => row.id === "repair")?.label, "Installed/Base Repair", "summary labels installed Repair");
  assert.equal(support.rows.find((row) => row.id === "repair.effective")?.label, "Effective Repair", "summary labels effective Repair");
  assert.equal(support.rows.find((row) => row.id === "repair.stacking")?.value, "Diminishing returns", "summary explains Repair stacking");
  assert.match(support.rows.find((row) => row.id === "repair")?.value || "", /16/);
  assert.match(support.rows.find((row) => row.id === "repair.effective")?.value || "", /14\.4/);

  const shieldMechanics = Mechanics.getMechanics("shield");
  assert(shieldMechanics.specialMechanics.some((entry) => entry.value === "0.12 H / damage blocked"), "Shield Ledger mechanic uses the shared rate");
  const repairMechanics = Mechanics.getMechanics("repair");
  assert(repairMechanics.specialMechanics.some((entry) => entry.value === "Diminishing returns"), "Repair Ledger mechanic states diminishing returns");
  assert(!Mechanics.getMechanics("repairBeam").specialMechanics.some((entry) => /diminishing/i.test(`${entry.label} ${entry.value} ${entry.detail || ""}`)), "Repair Beam Ledger mechanic omits local stack warning");
  assert.match(JSON.stringify(Ledger.getArticleById("defence")), /0\.12 H \/ damage blocked/);
  assert.match(JSON.stringify(Ledger.getArticleById("repair-mechanics")), /diminishing/i);

  console.log("Shield impact Heat and Repair stacking presentation verification passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
