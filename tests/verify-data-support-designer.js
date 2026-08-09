"use strict";

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const DataRules = require("../public/src/shared/dataSupportRules");
const HeatRules = require("../public/src/shared/heatRules");
const { PARTS } = require("../src/server/components");

globalThis.DataSupportRules = DataRules;
globalThis.HeatRules = HeatRules;
vm.runInThisContext(
  fs.readFileSync("public/src/design/dataSupportAnalysis.js", "utf8").replace(/export /g, ""),
  { filename: "public/src/design/dataSupportAnalysis.js" }
);

const Analysis = globalThis.DesignDataSupportAnalysis;
const at = (type, x, y = 0) => ({ type, x, y, rotation: 0 });
const budget = (type) => DataRules.nominalSupportBudget(type, PARTS);
const close = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-9, message + ": " + actual + " !== " + expected);

const design = [
  at("fireControl", 0, 0),
  at("signalAmplifier", 14, 14),
  at("railgun", 1, 13),
  at("blaster", 13, 1)
];
const links = [{ sourceIndex: 0, targetIndex: 2 }, { sourceIndex: 0, targetIndex: 3 }, { sourceIndex: 1, targetIndex: 2 }];
const analysis = Analysis.analyzeDesignDataSupport(design, PARTS, { thermalLoadMode: "idle", dataLinks: links });
assert.equal(analysis.mode, "direct-links");
assert(!Object.prototype.hasOwnProperty.call(analysis, "networks"));
close(analysis.sources[0].bonusPerWeapon, budget("fireControl") / 2, "designer divides one source budget across explicit links");
close(analysis.weapons[0].fireRateBonus, budget("fireControl") / 2, "designer preserves the divided Fire Control contribution");
close(analysis.weapons[0].rangeBonus, budget("signalAmplifier"), "designer stacks independent source contributions");
close(analysis.weapons[1].fireRateBonus, budget("fireControl") / 2, "designer applies the same divided source budget to its second link");

const destroyed = Analysis.analyzeDesignDataSupport(design, PARTS, {
  dataLinks: links,
  sourceOperationalMultiplier: (index) => index === 0 ? 0 : 1
});
assert.equal(destroyed.sources[0].status, "destroyed");
close(destroyed.weapons[1].fireRateBonus, 0, "destroyed source contributes nothing");
close(destroyed.weapons[0].rangeBonus, budget("signalAmplifier"), "destroying one source preserves another direct contribution");

const overheated = Analysis.analyzeDesignDataSupport(design, PARTS, {
  dataLinks: links,
  sourceThermalMultiplier: (index) => index === 1 ? 0 : 1
});
assert.equal(overheated.sources[1].status, "overheated");
close(overheated.weapons[0].rangeBonus, 0, "overheated source contributes nothing");

const vulnerabilities = Analysis.analyzeDataVulnerabilities(design, PARTS, analysis);
assert(vulnerabilities.some((item) => item.componentIndex === 0), "failure analysis reports source-local support loss");
assert(vulnerabilities.every((item) => item.kind === "source"), "failure analysis contains no physical route failures");

console.log("Direct Data Links designer analysis verification passed.");
