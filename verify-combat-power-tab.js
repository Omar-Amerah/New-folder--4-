"use strict";

// Combat Power tab verifier (non-browser). Confirms the selected-ship panel
// exposes Damage/Heat/Power tabs with accessible semantics, that Power-specific
// diagnostics have moved out of the Heat tab, that the Power tab renders the
// required supply/distribution/protection groups and overlay, and that no
// Section 7 balance value or gameplay formula is duplicated in the UI.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const index = fs.readFileSync(path.join(__dirname, "public/index.html"), "utf8");
const panel = fs.readFileSync(path.join(__dirname, "public/src/ui/shipDamagePanelUi.js"), "utf8");

let count = 0;
function check(name, fn) { fn(); count += 1; console.log(`  ok  ${count}. ${name}`); }
// Body of the Heat-summary renderer (used to assert Power rows are gone).
function fnBody(source, marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, `marker present: ${marker}`);
  let depth = 0; let i = source.indexOf("{", start);
  const from = i;
  for (; i < source.length; i += 1) { if (source[i] === "{") depth += 1; else if (source[i] === "}") { depth -= 1; if (depth === 0) return source.slice(from, i + 1); } }
  return source.slice(from);
}

// 1. Panel exposes Damage, Heat and Power tabs.
check("panel exposes Damage, Heat and Power tabs", () => {
  assert(/id="shipDamageTab"[^>]*role="tab"/.test(index), "Damage tab is a tab");
  assert(/id="shipHeatTab"[^>]*role="tab"/.test(index), "Heat tab is a tab");
  assert(/id="shipPowerTab"[^>]*role="tab"/.test(index), "Power tab is a tab");
  assert(/>Power<\/button>/.test(index), "Power tab has a text label");
});

// 2. Accessible selected-tab semantics.
check("Power tab uses accessible selected-tab semantics", () => {
  assert(/id="shipPowerTab"[^>]*aria-selected="false"/.test(index), "Power tab has aria-selected");
  assert(/id="shipPowerTab"[^>]*aria-controls="shipStatusPanelBody"/.test(index), "Power tab owns the tabpanel");
  assert(/id="shipStatusPanelBody"[^>]*role="tabpanel"/.test(index), "a tabpanel exists");
  // Active state is toggled by class AND aria-selected (not colour only).
  assert(/shipPowerTab\?\.classList\.toggle\("active", powerView\)/.test(panel), "active class toggled");
  assert(/shipPowerTab\?\.setAttribute\("aria-selected", String\(powerView\)\)/.test(panel), "aria-selected toggled");
});

// 3-6. Heat tab no longer shows Power information.
check("Heat summary no longer shows Power generation/demand/delivery/spare/unmet", () => {
  const body = fnBody(panel, "function renderHeatSummary");
  for (const gone of ["Power gen / requested", "Power delivered", "Power spare / unmet", "powerGenerationMw", "deliveredDemandMw", "sparePowerMw", "unmetDemandMw"]) {
    assert(!body.includes(gone), `Heat summary must not contain: ${gone}`);
  }
});
check("Heat summary no longer shows Power-protection or Switchgear diagnostics", () => {
  const body = fnBody(panel, "function renderHeatSummary");
  for (const gone of ["Power protection", "protectionStateLabel", "switchgearSummaryText", "Tripped Switchgear", "Most stressed section", "activePriorityPreset", "aboveSustainedSectionCount", "Power cable Heat rate", "Hottest cable", "Overloaded / peak cables", "Throttled / disabled"]) {
    assert(!body.includes(gone), `Heat summary must not contain: ${gone}`);
  }
});
check("Heat component readout no longer appends Power information", () => {
  const body = fnBody(panel, "function renderComponentHeatReadout");
  for (const gone of ["powerThermal", "Cable Heat", "requestedMw", "hostedActiveSectionIds", "sectionProtectionText"]) {
    assert(!body.includes(gone), `Heat component readout must not contain: ${gone}`);
  }
});

// 7. Heat retains overall thermal totals.
check("Heat summary retains overall thermal totals", () => {
  const body = fnBody(panel, "function renderHeatSummary");
  for (const kept of ["Overall heat", "Stored", "Component Heat rate", "Total / net Heat rate", "Cooling", "Heat state", "Hottest component", "Hot parts", "Overheated"]) {
    assert(body.includes(kept), `Heat summary must still contain: ${kept}`);
  }
});

// 8-14. Power tab renders the compact operational hierarchy.
check("Power summary renders compact overall state and balance values", () => {
  const body = fnBody(panel, "function renderPowerSummary");
  for (const label of ["Power balance", "Generation", "Requested", "Delivered", "Spare", "Unmet", "Priority"]) {
    assert(body.includes(label), `Power summary shows: ${label}`);
  }
  assert(body.includes("power-overall"), "overall status uses the compact status header");
  assert(body.includes("power-kv-grid"), "balance uses compact key/value rows");
});
check("Power summary renders prioritized issues and healthy zero state", () => {
  const body = fnBody(panel, "function renderPowerSummary");
  assert(body.includes("powerIssueList"), "issues come from the prioritized issue helper");
  assert(body.includes("slice(0, 3)"), "only the first three issues are initially visible");
  assert(body.includes("No Power issues detected"), "healthy state avoids empty issue cards");
  assert(body.includes("power-more-issues"), "additional issues use progressive disclosure");
});
check("Power summary renders compact distribution incl. authoritative cable Heat", () => {
  const body = fnBody(panel, "function renderPowerSummary");
  for (const label of ["Distribution", "network", "broken/disabled", "overloaded", "Cable Heat"]) assert(body.includes(label), `Power distribution shows: ${label}`);
  // Cable Heat is read from powerThermal (authoritative), not recomputed.
  assert(/powerCableHeatRate/.test(body), "cable Heat sourced from powerThermal");
});
check("Power summary omits specialist protection diagnostics", () => {
  const body = fnBody(panel, "function renderPowerSummary");
  for (const gone of [">Protection<", "Advanced Power Diagnostics", "Switchgear", "powerAdvancedHtml"]) {
    assert(!body.includes(gone), `compact summary omits: ${gone}`);
  }
  const issues = fnBody(panel, "function powerIssueList");
  assert(!issues.includes("Switchgear tripped"), "issues use plain Power-route language");
});

// 15-17. Overlay draws all sections, tiers distinguishable, disabled distinct.
check("overlay draws every installed Power section with tier thickness and status", () => {
  const body = fnBody(panel, "function drawPowerWiringOverlay");
  assert(/powerSectionsView\(ship\)/.test(body), "overlay iterates all layout sections");
  assert(/tierStrokeWidth\(section\.tier/.test(body), "overlay uses per-tier thickness");
  assert(/sectionStatusStyle\(section\)/.test(body), "overlay applies status styling");
  assert(/setLineDash/.test(body), "disabled/broken sections render dashed");
  const tierBody = fnBody(panel, "function tierStrokeWidth");
  assert(/renderedThickness/.test(tierBody), "tier thickness reads authoritative renderedThickness");
});
check("disabled sections are visually distinct from overloaded sections", () => {
  const body = fnBody(panel, "function sectionStatusStyle");
  assert(/dashed: true, key: "disabled"/.test(body), "disabled → dashed");
  assert(/"at-peak"/.test(body) && /"above-sustained"/.test(body) && /"near-sustained"/.test(body) && /"working"/.test(body), "distinct status keys");
});

// 18. Overlay alignment: wire lines use the same cell→screen mapping as the
//     component HP-bar overlay (componentScreenRect), guaranteeing alignment.
check("overlay endpoints use the same cell→screen mapping as component geometry", () => {
  const cellCenter = fnBody(panel, "function cellCenterScreen");
  assert(/originX \+ \(cx - SHIP_DAMAGE_GRID_CENTER\) \* cellSize/.test(cellCenter), "x mapping matches componentScreenRect");
  assert(/originY \+ \(cy - SHIP_DAMAGE_GRID_CENTER\) \* cellSize/.test(cellCenter), "y mapping matches componentScreenRect");
});

// Component and generator hover readouts.
check("component hover shows Power-specific details", () => {
  const body = fnBody(panel, "function renderComponentPowerReadout");
  assert(/requested/.test(body) && /allocated/.test(body), "consumer shows requested/allocated");
  assert(/hosted sections/.test(body), "consumer shows hosted Power sections");
  assert(/No direct Power demand or generation/.test(body), "passive fallback text");
});
check("generator hover shows generation details", () => {
  const body = fnBody(panel, "function renderComponentPowerReadout");
  assert(/generator/.test(body) && /available/.test(body), "generator shows available generation");
});
// 22. Section inspection shows flow/capacity/utilisation/Heat/stress.
check("section inspection shows flow, capacity, utilisation, Heat and stress", () => {
  const body = fnBody(panel, "function renderPowerSectionReadout");
  for (const token of ["sustained", "peak", "stress", "Heat", "network", "hosts"]) {
    assert(body.includes(token), `section readout shows: ${token}`);
  }
  assert(/cableHeatForSection/.test(body), "section Heat read from authoritative components");
  assert(/No live flow on this section/.test(body), "no-flow interpretation");
  assert(/Disabled because a host component is destroyed/.test(body), "disabled interpretation");
});

// 23. Section hit-testing does not trigger battlefield movement.
check("section hit-testing stops event propagation (no battlefield command)", () => {
  const down = fnBody(panel, "function handleDiagramPointerDown");
  assert(/event\.preventDefault\?\.\(\)/.test(down) && /event\.stopPropagation\?\.\(\)/.test(down), "pointer down is stopped before any hit-test");
  assert(/sectionAtCanvasPoint/.test(down), "power view hit-tests sections");
});

// 24/25. Switching views and ships clears stale readouts/selection.
check("switching views clears stale readouts and selection", () => {
  const sw = fnBody(panel, "function switchStatusView");
  assert(/clearDiagramSelection\(\)/.test(sw) && /clearComponentReadout\(\)/.test(sw), "view switch clears selection + readout");
  const clear = fnBody(panel, "function clearDiagramSelection");
  assert(/sectionSelectedId = undefined/.test(clear) && /sectionHoverId = undefined/.test(clear), "section selection cleared too");
});
check("selecting a different ship drops stale section selection", () => {
  // drawDiagram only preserves section selection while sameShip is true.
  assert(/sameShip && sectionExists\(diagramInteraction\.sectionSelectedId\)/.test(panel), "section selection guarded by sameShip");
});

// 33/35. Finite/sanitised, no duplicated Section 7 formula.
check("Power UI sanitises values and duplicates no gameplay formula", () => {
  assert(/function safeText/.test(panel), "empty/undefined values fall back to text");
  assert(!/Math\.pow\([^)]*utilisation/i.test(panel), "no cable-Heat power curve in the UI");
  assert(!/baseStressPerSecond|additionalStressPerSecondAtPeak/.test(panel), "no overload stress formula in the UI");
  assert(!/maxflow|augmenting|residual/i.test(panel), "no allocation solver in the UI");
});

// 10 (empty states). Clear fallbacks for missing data.
check("Power tab uses clear empty/unavailable states", () => {
  const body = fnBody(panel, "function powerOverallState");
  assert(/No valid Power network/.test(body), "no-wiring fallback");
  assert(/Live Power details could not be read/.test(body), "missing snapshot fallback");
  assert(/No Power section selected|No live flow on this section/.test(panel), "section fallbacks present");
});

check("Power issue Locate action selects only an authoritative section", () => {
  const body = fnBody(panel, "function handlePowerSummaryClick");
  assert(/data-power-locate-section/.test(body), "Locate action is delegated from the summary");
  assert(/powerSectionsView\(ship\)\.some/.test(body), "section id is checked against snapshot layout");
  assert(/sectionSelectedId = sectionId/.test(body), "exact cable section is selected");
});

// 38. No touch/mobile-specific behaviour added.
check("no touch or mobile-specific behaviour is added to the panel", () => {
  const lower = panel.toLowerCase();
  // Event/API tokens for touch/mobile-specific behaviour (a "gesture" in a
  // prose comment is not a control; match listener/handler tokens instead).
  for (const token of ["touchstart", "touchend", "touchmove", "longpress", "long-press", "swipe", "gesturestart", "maxtouchpoints", "ontouch"]) {
    assert(!lower.includes(token), `panel must not add ${token}`);
  }
  // The pre-existing pointer diagram still guards against touch/pen dragging.
  assert(/pointerType && event\.pointerType !== "mouse"/.test(panel), "pointer readout stays mouse-only for hover");
});

console.log(`\nCombat Power tab verification passed (${count} checks).`);
