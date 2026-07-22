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
// Selected-ship Power protection diagnostics now live in the dedicated Power
// tab (clear text labels, not colour-only).
for (const label of [
  "Protection state",
  "Above sustained",
  "At peak",
  "Critical-stress sections",
  "Most-stressed section",
  "Tripped Switchgear",
  "Nearest retry",
  "Partial consumers",
  "Shed consumers"
]) assert(damagePanel.includes(label), `selected-ship diagnostics label missing: ${label}`);
assert(damagePanel.includes("protectionStateLabel") && damagePanel.includes("Load shedding") && damagePanel.includes("Protection trip"), "overall protection states have readable labels");

// Switchgear runtime inspection: saved mode, state, rating, transfer,
// utilisation, stress, trip reason, cooldown, retry count, last retry reason.
assert(damagePanel.includes("switchgearSummaryText"), "Switchgear summary renderer present");
for (const token of ["mode ", "stress ", "cooldown ", "retries ", "trippedReason", "lastRetryReason", "retryCount", "cooldownRemaining", "overloadStress"]) {
  assert(damagePanel.includes(token), `Switchgear runtime inspection missing: ${token}`);
}

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
