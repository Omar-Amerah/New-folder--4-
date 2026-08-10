"use strict";

const assert = require("assert");
const HeatRules = require("../public/src/shared/heatRules");

globalThis.HeatRules = HeatRules;
global.document = {
  createElement: () => ({ getContext: () => ({}), style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {} }),
  createElementNS: () => ({ setAttribute() {}, appendChild() {} }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  documentElement: { style: { setProperty() {} } },
  body: { classList: { add() {}, remove() {} } }
};
global.window = { devicePixelRatio: 1, addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
global.localStorage = { getItem: () => null, setItem: () => {} };

function close(actual, expected, message) {
  assert.ok(Math.abs(Number(actual) - Number(expected)) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

(async () => {
  const { PART_STATS } = await import("../public/src/design/parts.js");
  const { formatHeatEffect, formatHeatEffectValue, getHeatEffectsForComponent } = await import("../public/src/shared/heatEffects.js");
  const S = HeatRules.STATE;

  function presentation(type, state) {
    assert.ok(PART_STATS[type], `catalogue has ${type}`);
    return getHeatEffectsForComponent(type, PART_STATS[type], state, HeatRules);
  }

  function effect(type, state, key) {
    const found = presentation(type, state).effects.find((candidate) => candidate.key === key);
    assert.ok(found, `${type} at ${HeatRules.STATE_LABELS[state]} exposes ${key}`);
    return found;
  }

  function firstType(predicate, label) {
    const entry = Object.entries(PART_STATS).find(([type, part]) => predicate(type, part));
    assert.ok(entry, `catalogue has a ${label}`);
    return entry[0];
  }

  for (const state of [S.NORMAL, S.WARM, S.HOT, S.CRITICAL, S.OVERHEATED]) {
    assert.strictEqual(presentation("engine", state).state, HeatRules.STATE_LABELS[state], "state label comes from HeatRules");
  }

  close(effect("engine", S.HOT, "activeOutput").multiplier, 0.70, "engine Hot Thrust output");
  close(effect("engine", S.CRITICAL, "activeOutput").multiplier, 0.40, "engine Critical Thrust output");
  close(effect("engine", S.OVERHEATED, "activeOutput").multiplier, 0, "engine Overheated Thrust output");
  assert.strictEqual(effect("engine", S.HOT, "activeOutput").label, "Thrust output", "engine category is explicit");
  assert.strictEqual(effect(firstType((_type, part) => Boolean(part.weapon), "weapon"), S.HOT, "activeOutput").label, "Weapon output", "weapon category is explicit");
  assert.strictEqual(effect(firstType((_type, part) => Number(part.powerGeneration) > 0, "Power source"), S.HOT, "activeOutput").label, "Power output", "reactor category is explicit");
  assert.strictEqual(effect(firstType((_type, part) => Number(part.repairRate) > 0, "repair source"), S.HOT, "activeOutput").label, "Repair output", "repair category is explicit");
  assert.strictEqual(effect(firstType((_type, part) => Number(part.sensorRangeBonus) > 0, "sensor"), S.HOT, "activeOutput").label, "Sensor output", "sensor category is explicit");
  assert.strictEqual(effect(firstType((_type, part) => Number(part.shieldRegen) > 0, "shield"), S.HOT, "activeOutput").label, "Shield regeneration", "shield category is explicit");
  assert.strictEqual(effect(firstType((_type, part) => part.category === "Command" && _type !== "core" && _type !== "droneBay", "command aura"), S.HOT, "activeOutput").label, "Command aura output", "command aura category is explicit");
  assert.strictEqual(effect(firstType((_type, part) => Number(part.rangeBonus) > 0 || Number(part.accuracyBonus) > 0 || Number(part.fireRateBonus) > 0, "Data source"), S.HOT, "activeOutput").label, "Data support output", "Data category is explicit");

  for (const type of ["radiator", "closedCycleCooler"]) {
    close(effect(type, S.HOT, "activeCooling").multiplier, 0.75, `${type} Hot Cooling output`);
    close(effect(type, S.CRITICAL, "activeCooling").multiplier, 0.50, `${type} Critical Cooling output`);
    close(effect(type, S.OVERHEATED, "activeCooling").multiplier, 0, `${type} Overheated Cooling output`);
  }

  for (const [state, expected] of [[S.HOT, 1.15], [S.CRITICAL, 1.35], [S.OVERHEATED, 1.60]]) {
    close(effect("frame", state, "structuralDamageTaken").multiplier, expected, `frame ${HeatRules.STATE_LABELS[state]} damage multiplier`);
  }

  assert.strictEqual(PART_STATS.armor.armorFlatReduction, 5, "armor base reduction remains 5");
  for (const [state, expectedProtection, expectedReduction] of [[S.HOT, 0.85, 4.25], [S.CRITICAL, 0.65, 3.25], [S.OVERHEATED, 0.40, 2]]) {
    close(effect("armor", state, "armorProtection").multiplier, expectedProtection, `armor ${HeatRules.STATE_LABELS[state]} effectiveness`);
    close(effect("armor", state, "armorDamageReduction").value, expectedReduction, `armor ${HeatRules.STATE_LABELS[state]} reduction`);
  }

  const lockout = effect("engine", S.OVERHEATED, "overheatLockout");
  const recovery = HeatRules.THRESHOLDS.overheated - HeatRules.HYSTERESIS.overheated;
  close(lockout.recoveryThreshold, recovery, "lockout recovery comes from HeatRules");
  assert.match(formatHeatEffect(lockout), new RegExp(`${Math.round(recovery * 100)}% Heat`), "lockout text includes derived recovery");
  assert.match(formatHeatEffectValue(lockout), /shut down/, "lockout text states shutdown");
  effect("droneBay", S.OVERHEATED, "overheatLockout");
  effect("decoyLauncher", S.OVERHEATED, "overheatLockout");

  const shapeVariants = {
    frame: ["halfFrameDiagonal", "wingFrame", "bevelFrame", "roundedFrame", "longWedgeFrame"],
    armor: ["halfArmorDiagonal", "wingArmor", "bevelArmor", "roundedArmor", "longWedgeArmor"],
    compositeArmor: ["halfCompositeArmorDiagonal", "wingCompositeArmor", "bevelCompositeArmor", "roundedCompositeArmor", "longWedgeCompositeArmor"],
    ablativeArmor: ["halfAblativeArmorDiagonal", "wingAblativeArmor", "bevelAblativeArmor", "roundedAblativeArmor", "longWedgeAblativeArmor"],
    refractoryArmor: ["halfRefractoryArmorDiagonal", "wingRefractoryArmor", "bevelRefractoryArmor", "roundedRefractoryArmor", "longWedgeRefractoryArmor"]
  };
  for (const [parent, variants] of Object.entries(shapeVariants)) {
    close(effect(parent, S.CRITICAL, "structuralDamageTaken").multiplier, 1.35, `${parent} uses structural Heat rules`);
    for (const type of variants) {
      close(effect(type, S.CRITICAL, "structuralDamageTaken").multiplier, 1.35, `${type} inherits ${parent} Heat rules`);
    }
  }

  for (const type of ["battery", "capacitor", "heatSink", "heatPipe", "heatVent", "burstCooler"]) {
    if (!PART_STATS[type]) continue;
    const penalties = presentation(type, S.HOT).effects.filter((candidate) => candidate.isPenalty);
    assert.strictEqual(penalties.length, 0, `${type} has no invented Hot Heat penalty`);
  }

  const catalogueTypes = Object.keys(PART_STATS);
  assert.ok(catalogueTypes.length > 0, "catalogue is non-empty");
  for (const type of catalogueTypes) {
    for (const state of Object.values(S)) {
      const result = presentation(type, state);
      assert.ok(Array.isArray(result.effects), `${type} has a presentation result at ${state}`);
      for (const item of result.effects) {
        assert.ok(item.label && item.key, `${type} effect at ${state} has a label and key`);
        assert.ok(!String(formatHeatEffect(item)).includes("undefined"), `${type} effect at ${state} has no undefined text`);
      }
    }
  }

  console.log(`heat presentation verification passed (${catalogueTypes.length} catalogue types)`);
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
