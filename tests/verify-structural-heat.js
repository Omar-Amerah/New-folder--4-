"use strict";

const assert = require("assert");
const HeatRules = require("../public/src/shared/heatRules");
const { PARTS } = require("../src/server/components");
const { initShipHeat } = require("../src/server/heat");

const STRUCTURAL_FAMILIES = [
  {
    material: "frame",
    base: "frame",
    variants: [
      ["halfFrameDiagonal", 0.5],
      ["wingFrame", 0.8],
      ["bevelFrame", 0.75],
      ["roundedFrame", 0.8],
      ["longWedgeFrame", 1.5]
    ]
  },
  {
    material: "armor",
    base: "armor",
    variants: [
      ["halfArmorDiagonal", 0.5],
      ["wingArmor", 0.8],
      ["bevelArmor", 0.75],
      ["roundedArmor", 0.8],
      ["longWedgeArmor", 1.5]
    ]
  },
  {
    material: "compositeArmor",
    base: "compositeArmor",
    variants: [
      ["halfCompositeArmorDiagonal", 0.5],
      ["wingCompositeArmor", 0.8],
      ["bevelCompositeArmor", 0.75],
      ["roundedCompositeArmor", 0.8],
      ["longWedgeCompositeArmor", 1.5]
    ]
  },
  {
    material: "ablativeArmor",
    base: "ablativeArmor",
    variants: [
      ["halfAblativeArmorDiagonal", 0.5],
      ["wingAblativeArmor", 0.8],
      ["bevelAblativeArmor", 0.75],
      ["roundedAblativeArmor", 0.8],
      ["longWedgeAblativeArmor", 1.5]
    ]
  },
  {
    material: "refractoryArmor",
    base: "refractoryArmor",
    variants: [
      ["halfRefractoryArmorDiagonal", 0.5],
      ["wingRefractoryArmor", 0.8],
      ["bevelRefractoryArmor", 0.75],
      ["roundedRefractoryArmor", 0.8],
      ["longWedgeRefractoryArmor", 1.5]
    ]
  }
];

const PROFILE_FIELDS = ["capacity", "cooling", "passiveCooling", "conductivity", "retention"];

function close(actual, expected, label) {
  assert(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} should be ${expected}`);
}

function serverThermalProfile(type) {
  const part = PARTS[type];
  const hp = Math.max(1, Number(part?.hp) || 1);
  const ship = {
    alive: true,
    design: [{ type, x: 0, y: 0 }],
    componentHp: [hp],
    componentMaxHp: [hp],
    stats: { powerUse: 0, powerGeneration: 0 },
    dirtyHeat: new Set()
  };
  initShipHeat(ship);
  return ship.componentThermals[0];
}

for (const family of STRUCTURAL_FAMILIES) {
  const basePart = PARTS[family.base];
  const base = HeatRules.profile(family.base, basePart);
  assert.strictEqual(HeatRules.structuralThermalMaterial(family.base), family.material,
    `${family.base} resolves to its canonical material`);
  assert.deepStrictEqual(
    HeatRules.structuralThermalProfile(family.base, basePart),
    base,
    `${family.base} profile is the shared structural profile`
  );

  for (const [type, scale] of family.variants) {
    const part = PARTS[type];
    assert(part, `${type} exists in the server catalogue`);
    assert.strictEqual(HeatRules.structuralThermalMaterial(type), family.material,
      `${type} resolves to ${family.material}`);
    const profile = HeatRules.profile(type, part);
    const server = serverThermalProfile(type);

    close(profile.capacity, base.capacity * scale, `${type} Heat capacity`);
    close(profile.cooling, base.cooling * scale, `${type} Heat cooling`);
    close(profile.passiveCooling, base.passiveCooling * scale, `${type} passive cooling`);
    close(profile.conductivity, base.conductivity, `${type} conductivity remains material-level`);
    close(profile.retention, base.retention, `${type} retention remains material-level`);
    for (const field of PROFILE_FIELDS) close(server[field], profile[field], `server ${type} ${field}`);
  }
}

assert(
  HeatRules.profile("halfFrameDiagonal", PARTS.halfFrameDiagonal).capacity
    < HeatRules.profile("frame", PARTS.frame).capacity,
  "Half Frame no longer receives the full/generic Frame thermal capacity"
);
close(
  HeatRules.profile("longWedgeFrame", PARTS.longWedgeFrame).capacity,
  HeatRules.profile("frame", PARTS.frame).capacity * 1.5,
  "Long Wedge Frame carries 1.5x Frame thermal mass"
);

// The browser Designer imports this same shared HeatRules module. Compare its
// actual model profile with the server's initialized runtime profile rather
// than checking only a copied balance field.
globalThis.HeatRules = HeatRules;
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    appendChild() {},
    getContext: () => null
  })
};
globalThis.window = { devicePixelRatio: 1 };

(async () => {
  const { PART_STATS } = await import("../public/src/design/parts.js");
  const { buildThermalModel, preDisplacementHeatCapacities } = await import("../public/src/design/thermalAnalysis.js");
  for (const family of STRUCTURAL_FAMILIES) {
    for (const [type] of [[family.base], ...family.variants]) {
      const design = [{ type, x: 0, y: 0 }];
      const designer = buildThermalModel(design).profiles[0];
      const designerCapacity = preDisplacementHeatCapacities(design)[0];
      const server = serverThermalProfile(type);
      const shared = HeatRules.profile(type, PART_STATS[type]);
      for (const field of PROFILE_FIELDS) close(designer[field], shared[field], `Designer ${type} ${field} uses shared HeatRules`);
      close(designerCapacity, designer.capacity, `Designer ${type} capacity model is authoritative`);
      for (const field of PROFILE_FIELDS) close(server[field], designer[field], `server and Designer ${type} ${field} agree`);
    }
  }
  assert.strictEqual(PARTS.refractoryArmor.heatBeamShield, true, "Refractory Armour keeps Heat-beam shielding");
  for (const [type] of STRUCTURAL_FAMILIES[4].variants) {
    assert.strictEqual(PARTS[type].heatBeamShield, true, `${type} keeps Heat-beam shielding`);
  }
  console.log("Structural thermal inheritance verification passed");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
