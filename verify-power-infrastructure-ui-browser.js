#!/usr/bin/env node
"use strict";

// Section 7H — desktop Power-infrastructure UI verifier.
// Confirms infrastructure guidance is available through compact Help and
// right-side Analysis instead of a permanent block above the ship grid.

const fs = require("fs");
const assert = require("assert");

const index = fs.readFileSync("public/index.html", "utf8");

assert(!index.includes('id="powerInfrastructureReference"'), "permanent Power reference is removed from the workspace");
assert(index.includes('id="wiringHelpPanel"'), "compact Wiring Help exists");
assert(index.includes('id="analysisPowerPanel"') && index.includes('id="analysisWiringPanel"'), "Power and Wiring have separate Analysis panels");
// Compact tier capacities are filled at runtime from authoritative balance.
for (const tier of ["light", "standard", "heavy"]) {
  assert(index.includes(`data-tier-capacity-compact="${tier}"`), `toolbar has an authoritative ${tier} capacity placeholder`);
}
for (const topic of [
  "sustained is safe continuous load",
  "overload stress",
  "Drawing Power over existing cable",
  "Data is a separate single-tier network",
  "no capacity or overload mechanics",
  "red dashed disconnected"
]) assert(index.includes(topic), `Help covers: ${topic}`);

// Architecture facts remain authoritative shared analysis data, but no longer
// occupy a permanent centre-workspace comparison.
assert(!index.includes('id="architectureComparison"'), "architecture comparison is removed from the centre workspace");
const architectureLabels = require("./public/src/shared/wiringClarityRules.js").ARCHITECTURE_NOTES.map((note) => note.label).join(" | ");
for (const family of ["Central bus", "Distributed grids", "Ring bus", "Hybrid"]) {
  assert(architectureLabels.includes(family), `architecture comparison covers ${family}`);
}

// Blueprint surfaces: wiring cost breakdown, per-tier cells, displacement,
// section inspection and Switchgear configuration.
const designer = fs.readFileSync("public/src/ui/designerUi.js", "utf8");
const wiringUi = fs.readFileSync("public/src/ui/wiringUi.js", "utf8");
const designerInfrastructure = `${designer}\n${wiringUi}`;
assert(designerInfrastructure.includes("Power wiring") && designerInfrastructure.includes("Data wiring") && designerInfrastructure.includes("Total infrastructure") && designerInfrastructure.includes("Infrastructure share"), "Blueprint Analysis lists Power/Data/total infrastructure and share");
assert(designerInfrastructure.includes("displacement"), "Blueprint surfaces expose wiring displacement");
assert(wiringUi.includes("accountInfrastructure"), "wiring editor uses the authoritative accounting rules");
assert(wiringUi.includes("inspect"), "wiring editor has a section inspect tool");
const inspector = fs.readFileSync("public/src/ui/partInspectorUi.js", "utf8");
assert(inspector.includes("data-switchgear-config") && inspector.includes("Default mode"), "part inspector exposes Switchgear mode/rating configuration");
assert(index.includes("data-wiring-tier") && !index.includes("Change Tier"), "tier selection exists without a separate Change Tier tool");

// Live-ship surfaces (dedicated Power tab): requested/delivered/unmet Power,
// protection state, overload counts, most stressed section, cable Heat,
// consumer counts and full Switchgear runtime inspection (Sections 7D-7G).
const damagePanel = fs.readFileSync("public/src/ui/shipDamagePanelUi.js", "utf8");
for (const label of [
  "Generation",
  "Requested",
  "Delivered",
  "Spare",
  "Unmet",
  "Cable Heat rate",
  "Protection state",
  "Above sustained",
  "At peak",
  "Most-stressed section",
  "Tripped Switchgear",
  "Nearest retry",
  "Partial consumers",
  "Shed consumers"
]) assert(damagePanel.includes(label), `live diagnostics label present: ${label}`);
assert(damagePanel.includes("switchgearSummaryText") && damagePanel.includes("cooldown") && damagePanel.includes("retries"), "Switchgear runtime inspection shows state, stress, cooldown and retries");
assert(damagePanel.includes("renderPowerSectionReadout") && damagePanel.includes("disabled"), "section inspection distinguishes disabled from overloaded sections");

// Damage/repair distinguishability: disabled sections render as disconnected
// (dashed status) rather than overload colours in the wiring legend text.
assert(index.includes("disconnected"), "legend distinguishes disconnected from overloaded status");

// Help adds no gesture-only behaviour.
const helpStart = index.indexOf('id="wiringHelpPanel"');
const referenceBlock = index.slice(helpStart, index.indexOf("</div>", helpStart));
for (const token of ["touchstart", "pointerdown", "swipe", "longpress", "gesture"]) {
  assert(!referenceBlock.toLowerCase().includes(token), `reference block adds no ${token} behaviour`);
}

console.log("verify-power-infrastructure-ui-browser passed");
