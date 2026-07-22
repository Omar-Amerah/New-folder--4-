#!/usr/bin/env node
"use strict";

// Section 7H — desktop Power-infrastructure UI verifier.
// Confirms the player-facing Power Infrastructure reference exists with the
// required practical guidance, and that the existing desktop Blueprint and
// live-ship surfaces expose the final wiring cost, displacement, capacity,
// protection and Switchgear diagnostics with accessible text labels. No
// touch/mobile behaviour is added.

const fs = require("fs");
const assert = require("assert");

const index = fs.readFileSync("public/index.html", "utf8");

// Player-facing reference: one concise collapsible block in the designer
// wiring surface, covering every required topic with clear text.
assert(index.includes('id="powerInfrastructureReference"'), "Power Infrastructure reference block exists");
// Tier capacities in the reference are filled at runtime from the
// authoritative balance (data-tier-capacity spans) rather than hardcoded, so
// the static check verifies the data-driven placeholders exist per tier.
for (const tier of ["light", "standard", "heavy"]) {
  assert(index.includes(`data-tier-capacity="${tier}"`), `reference has an authoritative ${tier} capacity placeholder`);
}
for (const topic of [
  "Power Infrastructure reference",
  "Sustained vs peak",
  "overload stress",
  "never trip, burn or take damage",
  "Open isolates",
  "Automatic closes only",
  "cooldown",
  "Destroyed Switchgear",
  "command, propulsion, shields, point defence, weapons, cooling",
  "does not remove that bottleneck",
  "not required for ordinary branches",
  "Data wiring is separate",
  "no capacity, overload, Heat or breaker mechanics"
]) assert(index.includes(topic), `reference covers: ${topic}`);

// The architecture comparison is rendered at runtime into #architectureComparison
// from the shared WiringClarityRules.ARCHITECTURE_NOTES (authoritative source),
// so the static check verifies the container plus the shared families.
assert(index.includes('id="architectureComparison"'), "reference has an architecture comparison container");
const architectureLabels = require("./public/src/shared/wiringClarityRules.js").ARCHITECTURE_NOTES.map((note) => note.label).join(" | ");
for (const family of ["Central bus", "Distributed grids", "Ring bus", "Hybrid"]) {
  assert(architectureLabels.includes(family), `architecture comparison covers ${family}`);
}

// Blueprint surfaces: wiring cost breakdown, per-tier cells, displacement,
// section inspection and Switchgear configuration.
const designer = fs.readFileSync("public/src/ui/designerUi.js", "utf8");
assert(designer.includes("Power wiring") && designer.includes("Data wiring") && designer.includes("Total infrastructure") && designer.includes("Infrastructure share"), "Blueprint cost breakdown lists Power/Data/total infrastructure and share");
assert(designer.includes("displacement"), "Blueprint surfaces expose wiring displacement");
const wiringUi = fs.readFileSync("public/src/ui/wiringUi.js", "utf8");
assert(wiringUi.includes("accountInfrastructure"), "wiring editor uses the authoritative accounting rules");
assert(wiringUi.includes("inspect"), "wiring editor has a section inspect tool");
const inspector = fs.readFileSync("public/src/ui/partInspectorUi.js", "utf8");
assert(inspector.includes("data-switchgear-config") && inspector.includes("Default mode"), "part inspector exposes Switchgear mode/rating configuration");
assert(index.includes("data-wiring-tier") && index.includes("Change Tier"), "tier selection and tier-change tooling exist");

// Live-ship surfaces: requested/delivered/unmet Power, protection state,
// overload counts, most stressed section, cable Heat, consumer counts and
// full Switchgear runtime inspection (from Sections 7D-7G).
const damagePanel = fs.readFileSync("public/src/ui/shipDamagePanelUi.js", "utf8");
for (const label of [
  "Power gen / requested",
  "Power delivered",
  "Power spare / unmet",
  "Power cable Heat rate",
  "Power protection",
  "Sections above sustained / at peak",
  "Most stressed section",
  "Tripped Switchgear",
  "Next retry",
  "Partial / shed consumers"
]) assert(damagePanel.includes(label), `live diagnostics label present: ${label}`);
assert(damagePanel.includes("switchgearSummaryText") && damagePanel.includes("cooldown") && damagePanel.includes("retries"), "Switchgear runtime inspection shows state, stress, cooldown and retries");
assert(damagePanel.includes("sectionProtectionText") && damagePanel.includes("disabled"), "section inspection distinguishes disabled from overloaded sections");

// Damage/repair distinguishability: disabled sections render as disconnected
// (dashed status) rather than overload colours in the wiring legend text.
assert(index.includes("disconnected"), "legend distinguishes disconnected from overloaded status");

// No new touch/pen/swipe/long-press or mobile-specific behaviour in the 7H
// reference block (static markup only, no scripts registered for it).
const referenceBlock = index.slice(index.indexOf('id="powerInfrastructureReference"'), index.indexOf("</details>", index.indexOf('id="powerInfrastructureReference"')));
for (const token of ["touchstart", "pointerdown", "swipe", "longpress", "gesture"]) {
  assert(!referenceBlock.toLowerCase().includes(token), `reference block adds no ${token} behaviour`);
}

console.log("verify-power-infrastructure-ui-browser passed");
