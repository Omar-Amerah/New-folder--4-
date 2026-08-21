"use strict";

const assert = require("assert");
const fs = require("fs");
const WeaponPresentationRules = require("../public/src/shared/weaponPresentationRules.js");
const DataSupportRules = require("../public/src/shared/dataSupportRules.js");
const { PARTS } = require("../src/server/components");
const { computeStats: computeServerStats } = require("../src/server/shipStats");
const { _test: SnapshotTest } = require("../src/server/snapshots");

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

  const scatterCycle = WeaponPresentationRules.weaponCyclePresentation({ damage: 5, fireRate: 1.1, pelletCount: 6 });
  close(scatterCycle.damagePerImpact, 5, "Scatter keeps authored damage per pellet");
  assert.equal(scatterCycle.projectileCount, 6, "Scatter counts every pellet in one firing event");
  close(scatterCycle.damagePerShot, 30, "Scatter damage per shot includes the full six-pellet volley");
  close(scatterCycle.dps, 33, "Scatter DPS includes every pellet fired each second");

  assert.equal(WeaponPresentationRules.hasReloadTelegraph(PARTS.railgun.weapon), true,
    "ordinary Railguns publish their reload for the rail-light indicator");
  assert.equal(WeaponPresentationRules.hasReloadTelegraph(PARTS.torpedo.weapon, "torpedo"), true,
    "Torpedoes publish their reload for the warhead charge animation");
  assert.equal(WeaponPresentationRules.hasReloadTelegraph(PARTS.missile.weapon, "missile"), false,
    "other missile-family weapons do not inherit the Torpedo animation");
  assert.equal(WeaponPresentationRules.hasReloadTelegraph(PARTS.blaster.weapon), false,
    "ordinary short-cycle weapons do not pay for staged reload art");
  assert.equal(WeaponPresentationRules.hasReloadTelegraph(PARTS.spinalAccelerator.weapon), false,
    "the Spinal Accelerator keeps its firing-solution charge telegraph");
  assert.equal(WeaponPresentationRules.weaponCyclePresentation(PARTS.railgun.weapon).isChargeWeapon, false,
    "the Railgun reload indicator does not add a pre-fire charge gate");

  const railReload = 1 / PARTS.railgun.weapon.fireRate;
  close(WeaponPresentationRules.reloadTelegraphProgress(PARTS.railgun.weapon, railReload, railReload), 0,
    "Railgun rails go dark immediately after firing");
  close(WeaponPresentationRules.reloadTelegraphProgress(PARTS.railgun.weapon, railReload / 2, railReload), 0.5,
    "Railgun rails fill linearly through the authored reload");
  close(WeaponPresentationRules.reloadTelegraphProgress(PARTS.railgun.weapon, 0, railReload), 1,
    "Railgun rails remain full when ready");
  close(WeaponPresentationRules.reloadTelegraphProgress(PARTS.railgun.weapon, railReload, railReload * 2), 0.5,
    "a reduced-output Railgun fills steadily across its longer committed reload");

  const reloadSnapshot = SnapshotTest.buildWeaponChargeProgress({
    design: [{ type: "railgun" }],
    weaponCharge: [0],
    weaponCooldowns: [railReload],
    weaponReloadDurations: [railReload * 2]
  });
  assert.deepEqual(reloadSnapshot, [0.5], "the public weaponCharge field carries authoritative Railgun reload progress");

  const torpedoReload = 1 / PARTS.torpedo.weapon.fireRate;
  const torpedoReloadSnapshot = SnapshotTest.buildWeaponChargeProgress({
    design: [{ type: "torpedo" }],
    weaponCharge: [0],
    weaponCooldowns: [torpedoReload * 0.75],
    weaponReloadDurations: [torpedoReload]
  });
  assert.deepEqual(torpedoReloadSnapshot, [0.25],
    "the public weaponCharge field carries authoritative Torpedo reload progress");

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
  close(PARTS.scatterCannon.weapon.dps, 33, "server Scatter Cannon DPS includes all six pellets");
  close(PARTS.scatterCannon.weapon.combatDps, 33, "server Scatter Cannon combat output includes all six pellets");
  close(PARTS.spinalAccelerator.weapon.dps, 170, "server Spinal weapon record is charge-aware");
  close(PARTS.spinalAccelerator.weapon.combatDps, 510, "server combat-facing cadence remains unchanged");
  close(PART_STATS.blaster.weapon.dps, Number((PART_STATS.blaster.weapon.damage * PART_STATS.blaster.weapon.fireRate).toFixed(1)), "client Blaster DPS remains ordinary");
  close(PART_STATS.railgun.weapon.dps, Number((PART_STATS.railgun.weapon.damage * PART_STATS.railgun.weapon.fireRate).toFixed(1)), "client Railgun DPS remains ordinary");
  close(PART_STATS.scatterCannon.weapon.dps, 33, "client Scatter Cannon DPS includes all six pellets");
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

  const scatterDesign = [
    { x: 0, y: 0, type: "core" },
    { x: 2, y: 0, type: "scatterCannon" }
  ];
  const serverScatterStats = computeServerStats(scatterDesign);
  const clientScatterStats = computeClientStats(scatterDesign);
  close(serverScatterStats.weapons.blaster.dps, 33, "server aggregate counts the full Scatter volley");
  close(clientScatterStats.weapons.blaster.dps, 33, "client aggregate counts the full Scatter volley");
  close(serverScatterStats.weaponDps, 33, "server ship DPS includes all Scatter pellets");
  close(clientScatterStats.weaponDps, 33, "client ship DPS includes all Scatter pellets");

  const supported = DataSupportRules.effectiveWeaponProfile(PARTS.spinalAccelerator.weapon, { fireRateBonus: 1 });
  close(supported.reload, 2000, "supported Spinal reload uses effective fire rate");
  close(supported.dps, 204, "supported Spinal cycle DPS uses effective fire rate");
  close(supported.combatDps, 1020, "supported combat-facing cadence remains direct fire-rate based");

  const supportedScatter = DataSupportRules.effectiveWeaponProfile(PARTS.scatterCannon.weapon, { fireRateBonus: 1 });
  close(supportedScatter.dps, 66, "Data-supported Scatter DPS includes every pellet at the effective fire rate");
  close(supportedScatter.combatDps, 66, "Data-supported Scatter combat output includes every pellet");

  const scatterModel = Inspector.buildComponentInspectorModel("scatterCannon", PART_STATS.scatterCannon, {
    name: "Scatter Cannon",
    description: PART_STATS.scatterCannon.description,
    category: "Weapons",
    effectiveCost: "$36"
  });
  const scatterHeadline = scatterModel.capability.find((row) => row.id === "weapon.dps");
  const scatterShot = scatterModel.sections.flatMap((section) => section.rows)
    .find((row) => row.id === "weapon.pelletDamage");
  assert.equal(scatterHeadline.value, "33.0", "component inspector reports full-volley Scatter DPS");
  assert.equal(scatterShot.value, "30 dmg across 6 separate impacts", "component inspector retains per-shot pellet delivery detail");

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

  console.log("PASS: weapon presentation counts multi-pellet volleys and uses charge-aware ideal cycles for Spinal Accelerator");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
