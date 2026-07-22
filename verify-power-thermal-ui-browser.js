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
const css = fs.readFileSync("public/styles/build-grid.css", "utf8");
const runner = fs.readFileSync("tools/run-tests.js", "utf8");

function has(source, pattern, label) { assert(pattern.test(source), label); }

has(designer, /THERMAL_SCENARIO_EXPLANATIONS[\s\S]*idle:[\s\S]*standby[\s\S]*combat:[\s\S]*mixed combat[\s\S]*full:[\s\S]*full output/, "Idle, Combat and Full explanations are present");
has(designer, /Component Heat generation[\s\S]*Power cable Heat generation[\s\S]*Total Heat generation/, "Blueprint summary separates component Heat and cable Heat");
has(designer, /Power requested[\s\S]*Power delivered[\s\S]*Power spare \/ unmet/, "Blueprint summary shows requested/delivered/spare/unmet Power");
has(designer, /Hottest component[\s\S]*Hottest cable section/, "Blueprint summary shows hottest component and cable section");
has(designer, /Base Heat capacity[\s\S]*Capacity bonuses[\s\S]*Power\/Data displacement[\s\S]*Final Heat capacity/, "Component inspection displays capacity bonuses, displacement and final capacity");
has(designer, /Component activity Heat[\s\S]*Hosted Power cable Heat[\s\S]*Total generated Heat/, "Component inspection separates activity and cable Heat");
has(designer, /hostedActiveSectionIds[\s\S]*heat-hosted-power-section/, "Selecting or hovering a component highlights hosted Power sections");
has(designer, /heat-flag-displacement[\s\S]*heat-flag-cable-heat[\s\S]*heat-flag-cable-overload[\s\S]*heat-flag-cable-peak[\s\S]*heat-flag-cable-risk/, "Overlay flags displacement, cable Heat, overload, peak and cable thermal risk");
has(css, /heat-flag-cable-heat[\s\S]*box-shadow[\s\S]*heat-flag-cable-risk[\s\S]*repeating-linear-gradient/, "Thermal overlays use outlines/patterns rather than replacing tier colour");
has(css, /prefers-reduced-motion[\s\S]*animation:none[\s\S]*heat-flag-cable-peak/, "Reduced-motion mode keeps static cues");
has(designer, /isPhysicalBlueprintEditMode\(mode = state\.blueprintView\) \{ return mode === "build" \|\| mode === "heat"; \}/, "Heat mode still permits component placement and rotation");
has(designer, /isBlueprintRemovalMode\(mode = state\.blueprintView\) \{ return mode === "build"; \}/, "Heat mode does not permit Build-only removal");
has(designer, /previousView === "wiring" && state\.blueprintView !== "wiring"\) resetWiringTransientState\(\)/, "Leaving Wiring only clears transient route state");
has(snapshots, /powerThermal = buildRuntimePowerThermalSnapshot\(ship\)/, "Runtime snapshot exposes authoritative compact Power/Heat diagnostics");
has(merge, /"powerThermal"/, "Snapshot merge safely carries optional runtime diagnostics");
has(damage, /Component Heat rate[\s\S]*Power cable Heat rate[\s\S]*Power gen \/ requested[\s\S]*Priority preset/, "Selected-ship panel renders runtime Heat/Power values");
has(damage, /powerDiag[\s\S]*Cable Heat[\s\S]*Sections[\s\S]*\|\| "None"/, "Runtime component readout degrades missing cable diagnostics safely");
has(runner, /verify-power-thermal-ui-browser\.js/, "New verifier is registered in the browser group");
assert(!/NaN|undefined/.test(designer.match(/blueprintHeatSummaryMarkup[\s\S]*?}\n/)?.[0] || ""), "Blueprint summary avoids literal NaN/undefined fallbacks");
console.log("Section 7D-4 Power thermal UI browser contract passed.");
