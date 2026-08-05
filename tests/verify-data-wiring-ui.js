"use strict";

const assert = require("assert");

// Load dependencies
const DataSupportRules = require("../public/src/shared/dataSupportRules");
const WiringRules = require("../public/src/shared/wiringRules");
const HeatRules = require("../public/src/shared/heatRules");
const { PARTS } = require("../src/server/components");

globalThis.DataSupportRules = DataSupportRules;
globalThis.WiringRules = WiringRules;
globalThis.HeatRules = HeatRules;

const { analyzeDesignDataSupport, getCachedDesignDataSupport, getCachedDataVulnerabilities } = require("../public/src/design/dataSupportAnalysis");
globalThis.DesignDataSupportAnalysis = { analyzeDesignDataSupport, getCachedDesignDataSupport, getCachedDataVulnerabilities };

const mod = (type, x, y, rotation = 0) => ({ type, x, y, rotation });

function wire(design, powerPaths = [], dataPaths = []) {
  let wiring = WiringRules.emptyWiring();
  for (const path of powerPaths) {
    wiring = WiringRules.addPath(wiring, "power", path, design, PARTS);
  }
  for (const path of dataPaths) {
    wiring = WiringRules.addPath(wiring, "data", path, design, PARTS);
  }
  return wiring;
}

console.log("Running Data Wiring UI regression tests...");

// Test Fixture 1: Signal Amplifier + 2 Blasters (Fully Powered & Operational)
const design1 = [
  mod("reactor", 6, 6),
  mod("signalAmplifier", 7, 6),
  mod("blaster", 7, 7),
  mod("blaster", 8, 7)
];
const powerPaths1 = [[{ x: 6, y: 6 }, { x: 7, y: 6 }]];
const dataPaths1 = [[{ x: 7, y: 6 }, { x: 7, y: 7 }, { x: 8, y: 7 }]];
const wiring1 = wire(design1, powerPaths1, dataPaths1);

const analysis1 = analyzeDesignDataSupport(design1, wiring1, PARTS, { thermalLoadMode: "idle" });

// 1. Source Inspection Data
const source1 = analysis1.sourceAllocationByIndex[1];
assert.ok(source1, "Source allocation exists for Signal Amplifier at index 1");
assert.strictEqual(source1.sourceType, "signalAmplifier");
assert.strictEqual(source1.nominalBudget, 40);
assert.strictEqual(source1.effectiveBudget, 40);
assert.strictEqual(source1.recipientCount, 2);
assert.strictEqual(source1.bonusPerWeapon, 20);
assert.strictEqual(source1.status, "active");

// 2. Weapon Inspection Data & Stat Hiding Rule
const weapon1 = analysis1.weaponBonusByIndex[2];
assert.ok(weapon1, "Weapon support exists for Blaster at index 2");
assert.strictEqual(weapon1.status, "supported");
assert.strictEqual(weapon1.sourceIndices.length, 1);
assert.strictEqual(weapon1.baseProfile.range, 560);
assert.strictEqual(weapon1.effectiveProfile.range, 580);
assert.strictEqual(weapon1.contributions.length, 1);
assert.strictEqual(weapon1.contributions[0].amount, 20);

// Check that accuracy and fire rate are UNCHANGED for weapon1 (only range is boosted by Signal Amplifier)
assert.strictEqual(weapon1.baseProfile.accuracy, weapon1.effectiveProfile.accuracy);
assert.strictEqual(weapon1.baseProfile.fireRate, weapon1.effectiveProfile.fireRate);

// 3. Vulnerability & Concrete Failure Consequences
const vulns1 = getCachedDataVulnerabilities(design1, wiring1, PARTS, analysis1);
assert.ok(vulns1.length > 0, "Vulnerability analysis returns failure impact items");

const sectionVuln = vulns1.find(v => v.kind === "section");
assert.ok(sectionVuln, "Section vulnerability exists");
assert.ok(sectionVuln.losses.length > 0, "Section failure has concrete loss records");

const lossItem = sectionVuln.losses[0];
assert.strictEqual(lossItem.lostRangeBonus, 20, "Vulnerability captures lost range bonus");

// Test Fixture 2: Multiple Data Sources (Signal Amplifier + Targeting Computer)
const design2 = [
  mod("reactor", 6, 6),
  mod("signalAmplifier", 7, 6),
  mod("targetingComputer", 7, 5),
  mod("blaster", 7, 7)
];
const powerPaths2 = [[{ x: 6, y: 6 }, { x: 7, y: 6 }, { x: 7, y: 5 }]];
const dataPaths2 = [[{ x: 7, y: 5 }, { x: 7, y: 6 }, { x: 7, y: 7 }]];
const wiring2 = wire(design2, powerPaths2, dataPaths2);

const analysis2 = analyzeDesignDataSupport(design2, wiring2, PARTS, { thermalLoadMode: "idle" });
const weapon2 = analysis2.weaponBonusByIndex[3];
assert.ok(weapon2, "Weapon support exists for Blaster with multi-source");
assert.strictEqual(weapon2.status, "supported");
assert.strictEqual(weapon2.contributions.length, 2, "Blaster receives 2 distinct source contributions");

const rangeContrib = weapon2.contributions.find(c => c.bonusField === "rangeBonus");
const accContrib = weapon2.contributions.find(c => c.bonusField === "accuracyBonus");
assert.ok(rangeContrib && rangeContrib.amount > 0, "Range contribution present");
assert.ok(accContrib && accContrib.amount > 0, "Accuracy contribution present");

// Test Fixture 3: Unpowered Data Source
const design3 = [
  mod("signalAmplifier", 7, 6),
  mod("blaster", 7, 7)
];
const dataPaths3 = [[{ x: 7, y: 6 }, { x: 7, y: 7 }]];
const wiring3 = wire(design3, [], dataPaths3);

// Power is 0 because there is no reactor or power network
const analysis3 = analyzeDesignDataSupport(design3, wiring3, PARTS, { thermalLoadMode: "idle" });
const source3 = analysis3.sourceAllocationByIndex[0];
assert.strictEqual(source3.status, "unpowered", "Unpowered Signal Amplifier flagged as unpowered");
assert.strictEqual(source3.effectiveBudget, 0, "Unpowered source delivers 0 effective budget");

const weapon3 = analysis3.weaponBonusByIndex[1];
assert.strictEqual(weapon3.status, "connected-unsupported", "Weapon connected to unpowered source is connected-unsupported");

console.log("All Data Wiring UI regression tests passed successfully!");
