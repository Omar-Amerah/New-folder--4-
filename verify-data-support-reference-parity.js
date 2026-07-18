"use strict";
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const WiringRules = require("./public/src/shared/wiringRules");
const DataRules = require("./public/src/shared/dataSupportRules");
const HeatRules = require("./public/src/shared/heatRules");
const { PARTS } = require("./src/server/components");
const fixtures = require("./test-fixtures/dataSupportReferenceShips");
const harness = require("./test-fixtures/dataSupportRuntimeHarness");

globalThis.WiringRules = WiringRules; globalThis.DataSupportRules = DataRules; globalThis.HeatRules = HeatRules;
const src = fs.readFileSync("public/src/design/dataSupportAnalysis.js", "utf8").replace(/export /g, "");
vm.runInThisContext(src, { filename: "public/src/design/dataSupportAnalysis.js" });
const Designer = globalThis.DesignDataSupportAnalysis;
const close = (a, b, msg, eps = 1e-9) => assert(Math.abs(a - b) <= eps, `${msg}: ${a} !== ${b}`);
const clone = (v) => JSON.parse(JSON.stringify(v));
function compareWeapon(label, shared, runtime, designer, index) { const s = DataRules.weaponSupportForIndex(shared, index), r = runtime.weaponBonusByIndex[index], d = designer.weaponBonusByIndex[index]; for (const k of ["rangeBonus", "accuracyBonus", "fireRateBonus"]) { close(s[k], r[k], `${label} shared/runtime ${k}`); close(r[k], d[k], `${label} runtime/designer ${k}`); } assert.deepEqual(s.sourceIndices, r.sourceIndices, `${label} source set runtime`); assert.deepEqual(r.sourceIndices, d.sourceIndices, `${label} source set designer`); }
function compareSource(label, shared, runtime, designer, index) { const s = shared.sourceAllocationByIndex[index], r = runtime.sourceAllocationByIndex[index], d = designer.sourceAllocationByIndex[index]; close(s.nominalBudget, r.nominalBudget, `${label} nominal`); close(r.nominalBudget, d.nominalBudget, `${label} designer nominal`); close(r.effectiveBudget, d.effectiveBudget, `${label} designer effective`); assert.deepEqual(s.eligibleWeaponIndices, r.eligibleWeaponIndices, `${label} recipients runtime`); assert.deepEqual(r.eligibleWeaponIndices, d.eligibleWeaponIndices, `${label} recipients designer`); }
for (const f of fixtures.allReferenceShips()) {
  const beforeDesign = clone(f.design), beforeWiring = clone(f.wiring);
  const shared = WiringRules.analyzeWiring(f.design, f.wiring, PARTS).data.supportAnalysis;
  const ship = harness.createRuntimeShip(f); const runtime = ship.runtimeDataSupport;
  const designer = Designer.analyzeDesignDataSupport(f.design, f.wiring, PARTS, { thermalLoadMode: "full" });
  f.expected.sources.forEach((i) => compareSource(`${f.name} source ${i}`, shared, runtime, designer, i));
  f.expected.weapons.forEach((i) => compareWeapon(`${f.name} weapon ${i}`, shared, runtime, designer, i));
  assert.equal(shared.networks.length, runtime.networks.length, `${f.name} shared/runtime network count`);
  assert.equal(runtime.networks.length, designer.networks.length, `${f.name} runtime/designer network count`);
  assert.deepEqual(f.design, beforeDesign, `${f.name} designer does not persist design data`);
  assert.deepEqual(f.wiring, beforeWiring, `${f.name} designer does not persist wiring data`);
}
console.log("Section 6E shared/runtime/designer reference parity passed.");
