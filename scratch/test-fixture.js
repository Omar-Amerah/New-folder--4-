"use strict";

const DataSupportRules = require("../public/src/shared/dataSupportRules");
const WiringRules = require("../public/src/shared/wiringRules");
const HeatRules = require("../public/src/shared/heatRules");
const { PARTS } = require("../src/server/components");

globalThis.DataSupportRules = DataSupportRules;
globalThis.WiringRules = WiringRules;
globalThis.HeatRules = HeatRules;

const { analyzeDesignDataSupport, getCachedDataVulnerabilities } = require("../public/src/design/dataSupportAnalysis");
const referenceFixtures = require("../test-fixtures/dataSupportReferenceShips");

for (const [key, fixture] of Object.entries(referenceFixtures)) {
  if (!fixture?.design) continue;
  const analysis = analyzeDesignDataSupport(fixture.design, fixture.wiring, PARTS, { thermalLoadMode: "full" });
  const vulns = getCachedDataVulnerabilities(fixture.design, fixture.wiring, PARTS, analysis);
  const crit = vulns.filter(v => v.kind === "section" && v.severity === "critical");
  console.log(key, "critical count:", crit.length);
  if (crit.length) {
    console.log(key, "CRITICAL SECTION:", JSON.stringify(crit[0], null, 2));
  }
}
