"use strict";
// Focused Section 7D-4 browser-verifier companion. This is intentionally
// static/DOM-contract coverage so the browser group checks that the production
// UI exposes authoritative 7D-1..7D-3 diagnostics without adding UI formulas.
const assert = require("assert");
const fs = require("fs");

const designer = fs.readFileSync("public/src/ui/designerUi.js", "utf8");
const damage = fs.readFileSync("public/src/ui/shipDamagePanelUi.js", "utf8");
const snapshots = fs.readFileSync("src/server/snapshots.js", "utf8");
const merge = fs.readFileSync("public/src/snapshotMerge.js", "utf8");
const thermal = fs.readFileSync("public/src/design/thermalAnalysis.js", "utf8");
const css = fs.readFileSync("public/styles/build-grid.css", "utf8");
const runner = fs.readFileSync("tools/run-tests.js", "utf8");

function has(source, pattern, label) { assert(pattern.test(source), label); }

has(designer, /THERMAL_SCENARIO_EXPLANATIONS[\s\S]*idle:[\s\S]*standby[\s\S]*combat:[\s\S]*mixed combat[\s\S]*full:[\s\S]*full output/, "Idle, Combat and Full explanations are present");
has(designer, /Component Heat generation[\s\S]*Power cable Heat generation[\s\S]*Total Heat generation/, "Blueprint summary separates component Heat and cable Heat");
has(designer, /Power requested[\s\S]*Power delivered[\s\S]*Power spare \/ unmet/, "Blueprint summary shows requested/delivered/spare/unmet Power");
has(designer, /Hottest component[\s\S]*Hottest cable section/, "Blueprint summary shows hottest component and cable section");
// 7D-4 originally routed the per-component capacity/activity/cable Heat
// breakdown through the Heat hover card. The hover card is now a decision aid
// (see tests/verify-heat-hover-card.js): the authoritative per-component
// diagnostics still exist on the analysis result for the detailed panels, but
// they are deliberately no longer rendered under the cursor — and
// componentActivityHeat in particular is an accumulated simulation total, which
// is meaningless next to H/s values.
has(thermal, /baseHeatCapacity[\s\S]*powerDisplacement[\s\S]*dataDisplacement[\s\S]*finalHeatCapacity/, "Analysis still exposes capacity bonuses, displacement and final capacity");
has(thermal, /componentActivityHeat[\s\S]*powerCableHeat[\s\S]*totalGeneratedHeat/, "Analysis still separates activity and cable Heat");
for (const phrase of ["Base Heat capacity", "Capacity bonuses", "Component activity Heat", "Hosted Power cable Heat", "Operational multiplier"]) {
  assert(!designer.includes(phrase), `Heat hover card must not dump "${phrase}" diagnostics under the cursor`);
}
has(designer, /hostedActiveSectionIds[\s\S]*heat-hosted-power-section/, "Selecting or hovering a component highlights hosted Power sections");
has(designer, /heat-flag-displacement[\s\S]*heat-flag-cable-heat[\s\S]*heat-flag-cable-overload[\s\S]*heat-flag-cable-peak[\s\S]*heat-flag-cable-risk/, "Overlay flags displacement, cable Heat, overload, peak and cable thermal risk");
has(css, /heat-flag-cable-heat[\s\S]*box-shadow[\s\S]*heat-flag-cable-risk[\s\S]*repeating-linear-gradient/, "Thermal overlays use outlines/patterns rather than replacing tier colour");
has(css, /prefers-reduced-motion[\s\S]*animation:none[\s\S]*heat-flag-cable-peak/, "Reduced-motion mode keeps static cues");
has(designer, /isPhysicalBlueprintEditMode\(mode = state\.blueprintView\) \{ return mode === "build" \|\| mode === "heat"; \}/, "Heat mode still permits component placement and rotation");
has(designer, /isBlueprintRemovalMode\(mode = state\.blueprintView\) \{ return isPhysicalBlueprintEditMode\(mode\); \}/, "Heat mode permits component removal");
has(designer, /previousView === "wiring" && state\.blueprintView !== "wiring"\) resetWiringTransientState\(\)/, "Leaving Wiring only clears transient route state");
has(snapshots, /powerThermal = buildRuntimePowerThermalSnapshot\(ship\)/, "Runtime snapshot exposes authoritative compact Power/Heat diagnostics");
has(merge, /"powerThermal"/, "Snapshot merge safely carries optional runtime diagnostics");
// The Heat tab keeps thermal-only rows; the dedicated Power tab now renders the
// compact runtime supply/distribution Power values (protection detail is surfaced
// through the prioritised issue list rather than dedicated rows).
has(damage, /Component Heat rate[\s\S]*Total \/ net Heat rate[\s\S]*Cooling/, "Heat tab renders runtime thermal values");
has(damage, /Generation[\s\S]*Requested[\s\S]*Delivered[\s\S]*Spare[\s\S]*Unmet[\s\S]*Cable Heat/, "Power tab renders runtime supply/distribution Power values");
has(damage, /hostedActiveSectionIds[\s\S]*join\(", "\)[\s\S]*\|\| "None"/, "Power component readout degrades missing hosted-section diagnostics safely");
has(runner, /verify-power-thermal-ui-browser\.js/, "New verifier is registered in the browser group");
assert(!/NaN|undefined/.test(designer.match(/blueprintHeatSummaryMarkup[\s\S]*?}\r?\n/)?.[0] || ""), "Blueprint summary avoids literal NaN/undefined fallbacks");
console.log("Section 7D-4 Power thermal UI browser contract passed.");
