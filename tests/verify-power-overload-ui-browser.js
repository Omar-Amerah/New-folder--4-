#!/usr/bin/env node
"use strict";

// Section 7G — desktop Power-protection inspection UI verifier.
// Confirms the selected-ship Power/Heat diagnostics, Switchgear runtime
// inspection and wiring-section inspection expose runtime overload protection
// with clear text labels, that the shared rules load in the browser, and that
// no touch/mobile-specific behaviour was added for this feature.

const fs = require("fs");
const assert = require("assert");

const index = fs.readFileSync("public/index.html", "utf8");
assert(index.includes("powerProtectionRules.js"), "browser loads shared Power-protection rules");

const damagePanel = fs.readFileSync("public/src/ui/shipDamagePanelUi.js", "utf8");
// The dedicated Power tab surfaces protection through the prioritised issue list
// (compact design) rather than dedicated protection/Switchgear inspection rows.
// Each protection condition still reads as clear text; verify-combat-power-tab.js
// covers the compact tab structure in full.
assert(/trippedSwitchgearCount[\s\S]*?temporarily offline/.test(damagePanel), "tripped Switchgear routes surface as a protection issue");
assert(/nextRetrySeconds[\s\S]*?Automatic recovery in/.test(damagePanel), "automatic retry timing surfaces in the tripped-route issue detail");
assert(/shedConsumerCount[\s\S]*?shed/.test(damagePanel), "shed consumers surface as a protection issue");
assert(/partialConsumerCount[\s\S]*?partially supplied/.test(damagePanel), "partially supplied consumers surface as a protection issue");
assert(damagePanel.includes("Cable at peak capacity") && damagePanel.includes("Critical cable stress") && damagePanel.includes("Cable above sustained load"), "cable stress states have readable issue titles");
assert(damagePanel.includes("most-stressed section") && damagePanel.includes("mostStressedSectionText"), "the most-stressed section is called out in plain text");
assert(damagePanel.includes("Partially powered") && damagePanel.includes("Powered"), "overall Power states have readable labels");

// Wiring-section inspection (Power tab): id, tier, flow, capacities,
// utilisation, stress, seconds above sustained, protection state, disabled.
assert(damagePanel.includes("renderPowerSectionReadout"), "Power-section inspection readout present");
for (const token of ["sustainedCapacityMw", "peakCapacityMw", "sustainedUtilisation", "peakUtilisation", "secondsAboveSustained", "above sustained", "disabled"]) {
  assert(damagePanel.includes(token), `wiring-section inspection missing: ${token}`);
}

// The client merge preserves the protection block when compact deltas omit it.
const merge = fs.readFileSync("public/src/snapshotMerge.js", "utf8");
assert(merge.includes('"powerProtection"') && merge.includes('"powerProtectionRevision"'), "snapshot merge preserves protection diagnostics");

// No touch/pen/swipe/long-press or mobile-specific behaviour in the Section 7G
// additions (shared rules, server runtime, snapshot block).
for (const file of ["public/src/shared/powerProtectionRules.js", "src/server/powerProtection.js"]) {
  const source = fs.readFileSync(file, "utf8").toLowerCase();
  for (const token of ["touchstart", "touchend", "pointerdown", "longpress", "long-press", "swipe", "gesture", "mobile"]) {
    assert(!source.includes(token), `${file} must not add touch/mobile behaviour (${token})`);
  }
}

console.log("verify-power-overload-ui-browser passed");
