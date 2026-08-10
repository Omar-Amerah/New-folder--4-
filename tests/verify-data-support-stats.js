"use strict";

const assert = require("assert");
const DataSupportRules = require("../public/src/shared/dataSupportRules.js");
const EngineExhaustRules = require("../public/src/shared/engineExhaust.js");
const HeatRules = require("../public/src/shared/heatRules.js");
const WeaponPresentationRules = require("../public/src/shared/weaponPresentationRules.js");

globalThis.DataSupportRules = DataSupportRules;
globalThis.EngineExhaustRules = EngineExhaustRules;
globalThis.HeatRules = HeatRules;
globalThis.WeaponPresentationRules = WeaponPresentationRules;
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    appendChild() {},
    getContext: () => null
  }),
  createElementNS: () => ({ setAttribute() {}, appendChild() {} }),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  documentElement: { style: { setProperty() {} } },
  body: { classList: { add() {}, remove() {} } }
};
globalThis.window = { devicePixelRatio: 1, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.localStorage = { getItem: () => null, setItem() {} };

function close(actual, expected, message) {
  assert(Math.abs(Number(actual) - Number(expected)) <= 1e-9,
    `${message}: expected ${expected}, got ${actual}`);
}

(async () => {
  const { PART_STATS } = await import("../public/src/design/parts.js");
  const { computeStats } = await import("../public/src/design/componentStats.js");
  const design = [
    { x: 7, y: 7, type: "core" },
    { x: 7, y: 8, type: "engine" },
    { x: 8, y: 7, type: "signalAmplifier" },
    { x: 8, y: 8, type: "targetingComputer" },
    { x: 9, y: 7, type: "railgun" },
    { x: 9, y: 8, type: "blaster" },
    { x: 10, y: 7, type: "missile" }
  ];
  const railgun = PART_STATS.railgun.weapon;
  const blaster = PART_STATS.blaster.weapon;
  const missile = PART_STATS.missile.weapon;
  const signalRange = PART_STATS.signalAmplifier.rangeBonus;
  const targetingAccuracy = PART_STATS.targetingComputer.accuracyBonus;

  const base = computeStats(design, { dataLinks: [] });
  const supported = computeStats(design, {
    dataLinks: [
      { sourceIndex: 2, targetIndex: 5 },
      { sourceIndex: 2, targetIndex: 6 },
      { sourceIndex: 3, targetIndex: 6 }
    ]
  });

  close(base.weapons.railgun.range, railgun.range, "unlinked Railgun keeps base range");
  close(base.weapons.railgun.accuracy, railgun.accuracy, "unlinked Railgun keeps base accuracy");
  close(supported.weapons.railgun.range, railgun.range, "unlinked Railgun keeps base range");
  close(supported.weapons.railgun.accuracy, railgun.accuracy, "unlinked Railgun keeps base accuracy");
  close(supported.weapons.blaster.range, blaster.range + signalRange / 2, "Signal Amplifier range is split across linked weapons");
  close(supported.weapons.blaster.accuracy, blaster.accuracy, "unlinked Blaster keeps base accuracy");
  close(supported.weapons.missile.range, missile.range + signalRange / 2, "split Signal Amplifier range reaches the second linked weapon");
  close(
    supported.weapons.missile.accuracy,
    Math.min(Math.max(0.99, missile.accuracy), missile.accuracy + targetingAccuracy),
    "linked Missile receives Targeting Computer accuracy"
  );

  console.log("Designer Data Link weapon-stat allocation verification passed.");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
