"use strict";

const assert = require("assert");
const fs = require("fs");
const WeaponPresentationRules = require("../public/src/shared/weaponPresentationRules.js");
const DataSupportRules = require("../public/src/shared/dataSupportRules.js");
const { PARTS } = require("../src/server/components");
const { computeStats: computeServerStats } = require("../src/server/shipStats");

const close = (actual, expected, message, tolerance = 1e-9) => {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} !== ${expected}`);
};

globalThis.WeaponPresentationRules = WeaponPresentationRules;
globalThis.DataSupportRules = DataSupportRules;
globalThis.ComponentTransform = require("../public/src/shared/componentTransform.js");
globalThis.EngineExhaustRules = require("../public/src/shared/engineExhaust.js");
globalThis.HeatRules = require("../public/src/shared/heatRules.js");
globalThis.TurretRules = require("../public/src/shared/turretRules.js");
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
  addEventListener() {},
  documentElement: { style: { setProperty() {} } },
  body: { classList: { add() {}, remove() {} } }
};
globalThis.window = { devicePixelRatio: 1, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.localStorage = { getItem: () => null, setItem() {} };

(async () => {
  const { PART_STATS } = await import("../public/src/design/parts.js");
  const Inspector = await import("../public/src/design/componentInspectorModel.js");
  const Ledger = await import("../public/src/ledger/ledgerContent.js");
  const { computeStats: computeClientStats } = await import("../public/src/design/componentStats.js");

  const normal = WeaponPresentationRules.weaponCyclePresentation({ damage: 100, fireRate: 2 });
  close(normal.dps, 200, "ordinary weapons retain damage times fire rate");
  close(normal.reloadSeconds, 0.5, "ordinary reload remains one over fire rate");
  assert.equal(normal.dpsLabel, "DPS");

  const spinal = WeaponPresentationRules.weaponCyclePresentation({
    damage: 2040,
    fireRate: 0.25,
    spinalCharge: { chargeSeconds: 8 }
  });
  close(spinal.reloadSeconds, 4, "Spinal reload is derived from fire rate");
  close(spinal.cycleSeconds, 12, "Spinal cycle includes charge and reload");
  close(spinal.dps, 170, "Spinal uses ideal charge-aware cycle DPS");
  assert.equal(spinal.dpsLabel, "Ideal cycle DPS");

  close(WeaponPresentationRules.weaponCyclePresentation({
    damage: 2040,
    fireRate: 0.25,
    spinalCharge: { chargeSeconds: 6 }
  }).dps, 204, "changing charge time changes ideal cycle DPS");
  const faster = WeaponPresentationRules.weaponCyclePresentation({
    damage: 2040,
    fireRate: 0.5,
    spinalCharge: { chargeSeconds: 8 }
  });
  close(faster.reloadSeconds, 2, "changing fire rate changes reload");
  close(faster.dps, 204, "changing fire rate changes charge-aware cycle DPS");

  for (const malformed of [
    { damage: 10, fireRate: 0 },
    { damage: 10, spinalCharge: { chargeSeconds: 8 } },
    { damage: "bad", fireRate: "bad", spinalCharge: { chargeSeconds: "bad" } }
  ]) {
    const result = WeaponPresentationRules.weaponCyclePresentation(malformed);
    assert(Number.isFinite(result.reloadSeconds), "missing or zero fire rate has finite reload presentation");
    assert(Number.isFinite(result.cycleSeconds), "missing or zero fire rate has finite cycle presentation");
    assert(Number.isFinite(result.dps), "missing or zero fire rate has finite DPS presentation");
  }

  close(PARTS.blaster.weapon.dps, PARTS.blaster.weapon.damage * PARTS.blaster.weapon.fireRate, "server Blaster DPS remains ordinary");
  close(PARTS.railgun.weapon.dps, PARTS.railgun.weapon.damage * PARTS.railgun.weapon.fireRate, "server Railgun DPS remains ordinary");
  close(PARTS.spinalAccelerator.weapon.dps, 170, "server Spinal weapon record is charge-aware");
  close(PARTS.spinalAccelerator.weapon.combatDps, 510, "server combat-facing cadence remains unchanged");
  close(PART_STATS.blaster.weapon.dps, Number((PART_STATS.blaster.weapon.damage * PART_STATS.blaster.weapon.fireRate).toFixed(1)), "client Blaster DPS remains ordinary");
  close(PART_STATS.railgun.weapon.dps, Number((PART_STATS.railgun.weapon.damage * PART_STATS.railgun.weapon.fireRate).toFixed(1)), "client Railgun DPS remains ordinary");
  close(PART_STATS.spinalAccelerator.weapon.dps, 170, "client Spinal weapon record is charge-aware");

  const design = [
    { x: 0, y: 0, type: "core" },
    { x: 1, y: 0, type: "engine" },
    { x: 2, y: 0, type: "spinalAccelerator" }
  ];
  const serverStats = computeServerStats(design);
  const clientStats = computeClientStats(design);
  close(serverStats.weapons.railgun.dps, 170, "server aggregate uses the shared Spinal cycle");
  close(clientStats.weapons.railgun.dps, 170, "client aggregate uses the shared Spinal cycle");
  close(serverStats.weaponDps, 170, "server ship DPS is not inflated to 510");
  close(clientStats.weaponDps, 170, "client ship DPS is not inflated to 510");
  assert.equal(serverStats.weaponDpsLabel, "Weapon DPS (ideal charge cycle)");
  assert.equal(clientStats.weaponDpsLabel, "Weapon DPS (ideal charge cycle)");

  const supported = DataSupportRules.effectiveWeaponProfile(PARTS.spinalAccelerator.weapon, { fireRateBonus: 1 });
  close(supported.reload, 2000, "supported Spinal reload uses effective fire rate");
  close(supported.dps, 204, "supported Spinal cycle DPS uses effective fire rate");
  close(supported.combatDps, 1020, "supported combat-facing cadence remains direct fire-rate based");

  const model = Inspector.buildComponentInspectorModel("spinalAccelerator", PART_STATS.spinalAccelerator, {
    name: "Spinal Accelerator",
    description: PART_STATS.spinalAccelerator.description,
    category: "Weapons",
    effectiveCost: "$300"
  });
  const allRows = [...model.core, ...model.capability, ...model.sections.flatMap((section) => section.rows)];
  const headline = model.capability.find((row) => row.id === "weapon.dps");
  assert.equal(headline.label, "Ideal cycle DPS", "component inspector labels Spinal output explicitly");
  assert.equal(headline.value, "170.0");
  for (const label of ["Damage per Shot", "Charge", "Reload", "Ideal Cycle"]) {
    assert(allRows.some((row) => row.label === label), `component inspector shows ${label}`);
  }

  const article = Ledger.getArticleById("component:spinalAccelerator");
  assert(article, "Fleet Ledger contains the Spinal component article");
  assert(article.importantStats.some((row) => row.label === "Ideal Cycle DPS" && row.value === "170.0"));
  assert(article.importantStats.some((row) => row.label === "Charge" && row.value === "8.0 s"));
  assert(article.importantStats.some((row) => row.label === "Reload" && row.value === "4.0 s"));
  assert.match(article.practicalUse, /Ideal cycle DPS: 170\.0/);
  assert.doesNotMatch(article.practicalUse, /Theoretical DPS: 510/);

  for (const relative of [
    "public/src/design/parts.js",
    "public/src/design/componentStats.js",
    "public/src/design/componentInspectorModel.js",
    "public/src/ledger/ledgerContent.js",
    "src/server/components.js",
    "src/server/shipStats.js",
    "public/src/shared/dataSupportRules.js"
  ]) {
    assert.match(fs.readFileSync(relative, "utf8"), /weaponPresentationRules|WeaponPresentationRules|weaponPresentationRules/,
      `${relative} uses the shared weapon presentation authority`);
  }

  console.log("PASS: weapon presentation uses ordinary DPS for normal weapons and charge-aware ideal cycles for Spinal Accelerator");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
