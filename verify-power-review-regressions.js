"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ui = fs.readFileSync(path.join(__dirname, "public/src/ui/shipDamagePanelUi.js"), "utf8");
const snap = fs.readFileSync(path.join(__dirname, "src/server/snapshots.js"), "utf8");
const wiring = fs.readFileSync(path.join(__dirname, "public/src/shared/wiringClarityRules.js"), "utf8");
const pws = fs.readFileSync(path.join(__dirname, "src/server/powerWiringSnapshot.js"), "utf8");
let n = 0; function check(name, fn){ fn(); console.log(`  ok  ${++n}. ${name}`); }
check("combat snapshot exposes explicit switchgear presentation states", () => {
  for (const state of ["open", "closed-conducting", "automatic-idle", "automatic-conducting", "tripped-cooling", "tripped-retry-pending", "destroyed", "disconnected", "unpowered", "unknown"]) assert(snap.includes(state), state);
  assert(/presentationState/.test(snap) && /reasonNotConducting/.test(snap) && /conducts/.test(snap));
});
check("generator readout separates rated, available, delivered and unused output", () => {
  for (const text of ["Rated:", "Available:", "Delivered:", "Unused:"]) assert(ui.includes(text), text);
  for (const field of ["ratedGenerationMw", "availableGenerationMw", "deliveredGenerationMw", "unusedGenerationMw", "reductionReasons"]) assert(snap.includes(field), field);
});
check("section Heat is keyed directly by namespaced Power section id", () => {
  assert(/powerCableHeatBySectionId/.test(snap));
  assert(/namespacedPowerSectionId/.test(snap));
  assert(/powerThermal\?\.powerCableHeatBySectionId/.test(ui));
});
check("Power section ids are namespaced in combat wiring snapshots", () => {
  assert(/function powerSectionId/.test(pws));
  assert(/`power:\$\{id\}`/.test(pws));
  assert(/networkType: "power"/.test(pws));
});
check("wiring wording avoids overclaiming physical separation", () => {
  assert(wiring.includes("Power and Data wiring do not occupy the same cells."));
  assert(!wiring.includes("physically separate where drawn"));
});
check("bottleneck messaging requires limiting evidence", () => {
  assert(/above rating/.test(wiring));
  assert(/current flow/.test(wiring));
  assert(/sustained \/ \$\{mw\(flow\.peakCapacityMw\)\} peak/.test(wiring));
});
console.log(`verify-power-review-regressions: ${n} checks passed`);
