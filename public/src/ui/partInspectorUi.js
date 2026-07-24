// Renders the Blueprint "Selected Component" inspector.
//
// The information architecture lives in design/componentInspectorModel.js; this
// module only turns that model into DOM. Layout is deliberately flat — one outer
// panel, lightweight specification cells, one capability group, warning panels
// where warranted, and accordion dividers — rather than boxes nested in boxes.

import { dom } from "./dom.js";
import { state, DEFAULT_THERMAL_LOAD_MODE } from "../state.js";
import { PART_DEFS, PART_STATS, isRotatablePart, partCategory, partDescription, partIconMarkup } from "../design/parts.js";
import { escapeHtml } from "../shared/formatting.js";
import { estimatePartEffectiveCost } from "../design/componentStats.js";
import { analyzeDesignHeat } from "../design/thermalAnalysis.js";
import { getOccupiedCells } from "../design/footprint.js";
import { GENERATED_BALANCE } from "../generatedBalance.js";
import { WIRING_INFRASTRUCTURE } from "../constants.js";
import { solveBlueprintPower } from "../design/powerAllocationAnalysis.js";
import { getCachedDesignDataSupport, getDesignSourceAllocation } from "../design/dataSupportAnalysis.js";
import { buildComponentInspectorModel, powerRequirementState, dataRequirementState } from "../design/componentInspectorModel.js";

export function renderPartInspector() {
  const type = state.selectedPart || selectedPlacedPart()?.type;
  if (!type) {
    dom.partInspector.innerHTML = `<p class="part-description part-inspector-empty">Select a component on the grid to inspect it.</p>`;
    return;
  }
  const def = PART_DEFS[type] || PART_DEFS.frame;
  const stat = PART_STATS[type] || PART_STATS.frame;
  const placed = selectedPlacedPartOfType(type);
  const model = buildComponentInspectorModel(type, stat, {
    name: def.name,
    description: enrichDescription(type, partDescription(type, stat)),
    category: partCategory(type),
    effectiveCost: `$${estimatePartEffectiveCost(type, state.design).toLocaleString()}`,
    prediction: thermalPredictionFor(type),
    droneType: placed?.droneType || globalThis.DroneBayRules?.normalizeDroneType?.(placed?.droneType) || null,
    thermalNote: thermalNoteFor(type),
    requirementStatus: requirementStatusFor(placed)
  });

  // Expanded accordions persist while the same component stays selected and
  // reset when the selection moves to a different component.
  const openState = openSectionsFor(type);

  const componentActions = placed && placed.type !== "core" ? `
    <div class="part-inspector-actions" aria-label="Selected component actions">
      ${isRotatablePart(type) ? `<button type="button" data-component-action="rotate">Rotate</button>` : ""}
      <button type="button" class="danger" data-component-action="remove">Remove</button>
    </div>` : "";

  dom.partInspector.innerHTML = `
    ${headerMarkup(type, model)}
    ${coreSpecMarkup(model)}
    ${capabilityMarkup(model)}
    ${requirementsMarkup(model)}
    ${thermalSummaryMarkup(model)}
    ${warningsMarkup(model)}
    ${switchgearControlsMarkup(type)}
    ${droneBayControlsMarkup(type)}
    ${componentActions}
    ${model.sections.map((section) => accordionMarkup(section, openState)).join("")}
    ${isRotatablePart(type) ? `<p class="part-inspector-tip">Hover a placed matching part and press R to rotate.</p>` : ""}
  `;

  attachSwitchgearControlHandlers();
  attachDroneBayControlHandlers();
  attachRequirementHandlers();
  dom.partInspector.querySelectorAll("[data-component-action]").forEach((button) => {
    button.addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent("blueprint-component-action", { detail: { action: button.dataset.componentAction } }));
    });
  });
  attachAccordionHandlers(type);
}

// ---------------------------------------------------------------------------
// Markup builders
// ---------------------------------------------------------------------------

function headerMarkup(type, model) {
  return `
    <header class="part-inspector-header">
      <div class="part-inspector-title">
        ${partIconMarkup(type, "inspector-glyph")}
        <div class="part-inspector-heading">
          <strong class="part-inspector-name">${escapeHtml(model.header.name)}</strong>
          <span class="part-category-label">${escapeHtml(model.header.badge)}</span>
        </div>
      </div>
      <p class="part-description">${escapeHtml(model.header.description)}</p>
    </header>`;
}

function coreSpecMarkup(model) {
  if (!model.core.length) return "";
  return `
    <div class="part-core-specs" role="list" aria-label="Core specifications">
      ${model.core.map((row) => `
        <div class="part-spec-cell${row.tone ? ` is-${row.tone}` : ""}" role="listitem">
          <span class="part-spec-label">${escapeHtml(row.label)}</span>
          <strong class="part-spec-value">${escapeHtml(row.value)}</strong>
        </div>`).join("")}
    </div>`;
}

function capabilityMarkup(model) {
  if (!model.capability.length) return "";
  return `
    <section class="part-capability" aria-label="Primary capability">
      <h4 class="part-section-heading">Primary capability</h4>
      <div class="part-capability-grid">
        ${model.capability.map((row) => `
          <div class="part-capability-cell">
            <span class="part-spec-label">${escapeHtml(row.label)}</span>
            <strong class="part-spec-value">${escapeHtml(row.value)}</strong>
          </div>`).join("")}
      </div>
    </section>`;
}

// One consistent requirements area. Icons never sit beside individual stat
// values, and every chip is a real button that discloses a compact explanation.
// A currently-failing dependency is stated visibly on the row itself — never
// hidden behind the tooltip.
function requirementsMarkup(model) {
  if (!model.requirements.length) return "";
  const chips = model.requirements.map((requirement) => {
    const unmet = requirement.status === "unmet";
    const tipId = `partRequirementTip-${requirement.id}`;
    const ariaLabel = unmet
      ? `${requirement.label} requirement not met: ${requirement.failureText || "dependency unmet"}. Show details.`
      : `${requirement.label} requirement: ${requirement.summary}. Show details.`;
    return `
      <button type="button" class="part-requirement${unmet ? " is-unmet" : ""}"
              data-requirement="${escapeHtml(requirement.id)}"
              aria-expanded="false" aria-controls="${tipId}"
              aria-label="${escapeHtml(ariaLabel)}">
        <span class="part-requirement-icon" aria-hidden="true">${escapeHtml(requirement.icon)}</span>
        <span class="part-requirement-label">${escapeHtml(requirement.label)}</span>
        ${unmet ? `<span class="part-requirement-flag">Unmet</span>` : ""}
      </button>`;
  }).join("");

  const tips = model.requirements.map((requirement) => `
    <div class="part-requirement-tip" id="partRequirementTip-${escapeHtml(requirement.id)}" role="region"
         data-requirement-tip="${escapeHtml(requirement.id)}" hidden>
      <strong>${escapeHtml(requirement.label)} — ${escapeHtml(requirement.summary)}</strong>
      <span>${escapeHtml(requirement.detail)}</span>
    </div>`).join("");

  // Visible, non-tooltip statement of any active failure.
  const failures = model.requirements.filter((requirement) => requirement.status === "unmet" && requirement.failureText);
  const failureMarkup = failures.map((requirement) => `
    <p class="part-requirement-failure">
      <span class="part-requirement-failure-label">${escapeHtml(requirement.label)} unmet</span>
      <span>${escapeHtml(requirement.failureText)}</span>
    </p>`).join("");

  return `
    <section class="part-requirements" aria-label="Requirements">
      <div class="part-requirements-row">
        <h4 class="part-section-heading part-requirements-heading">Requirements</h4>
        <div class="part-requirement-chips">${chips}</div>
      </div>
      ${failureMarkup}
      ${tips}
    </section>`;
}

// Resolve whether the selected *placed* component currently meets its Power and
// Data dependencies, using the same authoritative Blueprint solvers the Power and
// Wiring analysis panels use. Unplaced palette components report no status.
function requirementStatusFor(placed) {
  if (!placed) return {};
  const design = Array.isArray(state.design) ? state.design : [];
  const index = design.indexOf(placed);
  if (index < 0) return {};
  const status = {};
  const stat = PART_STATS[placed.type] || PART_STATS.frame;

  if ((stat.powerUse || 0) > 0) {
    try {
      const flow = solveBlueprintPower(design, state.wiring || null, PART_STATS, WIRING_INFRASTRUCTURE);
      const entry = flow?.byComponentIndex?.find((item) => item.componentIndex === index) || null;
      status.power = powerRequirementState(entry);
    } catch { status.power = { state: "unplaced", reason: null }; }
  }

  if (stat.rangeBonus || stat.accuracyBonus || stat.fireRateBonus) {
    try {
      const analysis = getCachedDesignDataSupport(design, state.wiring || null, PART_STATS, {
        thermalLoadMode: state.thermalLoadMode || DEFAULT_THERMAL_LOAD_MODE
      });
      status.data = dataRequirementState(getDesignSourceAllocation(analysis, index));
    } catch { status.data = { state: "unplaced", reason: null }; }
  }

  return status;
}

// Hover, keyboard focus and tap all disclose the explanation; Escape, an outside
// click and moving focus away all close it.
function attachRequirementHandlers() {
  const root = dom.partInspector;
  const chips = Array.from(root.querySelectorAll("[data-requirement]"));
  if (!chips.length) return;

  const tipFor = (chip) => root.querySelector(`[data-requirement-tip="${chip.dataset.requirement}"]`);
  // Hover and focus open the tip transiently; a click or tap pins it open so it
  // survives the pointer leaving, and a second click dismisses it.
  const setOpen = (chip, open, { pinned = false } = {}) => {
    const tip = tipFor(chip);
    if (!tip) return;
    chip.setAttribute("aria-expanded", open ? "true" : "false");
    tip.hidden = !open;
    if (open && pinned) chip.dataset.requirementPinned = "true";
    if (!open) delete chip.dataset.requirementPinned;
  };
  const closeAll = (except = null) => chips.forEach((chip) => { if (chip !== except) setOpen(chip, false); });

  for (const chip of chips) {
    chip.addEventListener("click", () => {
      const pinned = chip.dataset.requirementPinned === "true";
      closeAll(chip);
      setOpen(chip, !pinned, { pinned: !pinned });
    });
    chip.addEventListener("mouseenter", () => { closeAll(chip); setOpen(chip, true); });
    chip.addEventListener("focus", () => { closeAll(chip); setOpen(chip, true); });
    chip.addEventListener("mouseleave", () => {
      if (document.activeElement !== chip && chip.dataset.requirementPinned !== "true") setOpen(chip, false);
    });
    chip.addEventListener("blur", () => { if (chip.dataset.requirementPinned !== "true") setOpen(chip, false); });
    chip.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { setOpen(chip, false); chip.blur(); }
    });
  }

  installGlobalRequirementDismissal();
}

// Outside-click and Escape dismissal live on the document and are installed once,
// so repeated inspector renders never stack duplicate listeners.
let globalRequirementDismissalInstalled = false;
function installGlobalRequirementDismissal() {
  if (globalRequirementDismissalInstalled) return;
  globalRequirementDismissalInstalled = true;
  const closeEverything = () => {
    dom.partInspector?.querySelectorAll("[data-requirement][aria-expanded='true']").forEach((chip) => {
      chip.setAttribute("aria-expanded", "false");
      delete chip.dataset.requirementPinned;
      const tip = dom.partInspector.querySelector(`[data-requirement-tip="${chip.dataset.requirement}"]`);
      if (tip) tip.hidden = true;
    });
  };
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest?.("[data-requirement]")) closeEverything();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeEverything();
  });
}

function thermalSummaryMarkup(model) {
  if (!model.thermalSummary.length) return "";
  return `
    <div class="part-thermal-summary" aria-label="Thermal summary">
      ${model.thermalSummary.map((row) => `
        <p class="part-thermal-line${row.tone ? ` is-${row.tone}` : ""}">
          <span class="part-thermal-label">${escapeHtml(row.label)}</span>
          <span class="part-thermal-value">${escapeHtml(row.value)}</span>
        </p>`).join("")}
    </div>`;
}

function warningsMarkup(model) {
  if (!model.warnings.length) return "";
  return model.warnings.map((warning) => `
    <div class="part-warning" role="note" data-warning="${escapeHtml(warning.id)}">
      <span class="part-warning-icon" aria-hidden="true">!</span>
      <div class="part-warning-body">
        <strong class="part-warning-title">${escapeHtml(warning.title)}</strong>
        <span class="part-warning-text">${escapeHtml(warning.body)}</span>
      </div>
    </div>`).join("");
}

function accordionMarkup(section, openState) {
  const open = Boolean(openState[section.id]);
  const panelId = `partInspectorSection-${section.id}`;
  const triggerId = `${panelId}-trigger`;
  return `
    <div class="part-accordion${open ? " is-open" : ""}" data-accordion="${escapeHtml(section.id)}">
      <button type="button" class="part-accordion-trigger" id="${triggerId}"
              aria-expanded="${open ? "true" : "false"}" aria-controls="${panelId}"
              data-inspector-section="${escapeHtml(section.id)}">
        <span class="part-accordion-marker" aria-hidden="true"></span>
        <span class="part-accordion-title">${escapeHtml(section.title)}</span>
      </button>
      <div class="part-accordion-panel" id="${panelId}" role="region" aria-labelledby="${triggerId}"${open ? "" : " hidden"}>
        <div class="part-detail-list">
          ${section.rows.map((row) => `
            <div class="part-detail-row${row.tone ? ` is-${row.tone}` : ""}">
              <span class="part-spec-label">${escapeHtml(row.label)}</span>
              <strong class="part-detail-value">${escapeHtml(row.value)}</strong>
            </div>`).join("")}
        </div>
        ${section.note ? `<p class="part-accordion-note">${escapeHtml(section.note)}</p>` : ""}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Accordion state — remembered per selected component, reset on change
// ---------------------------------------------------------------------------

function openSectionsFor(type) {
  const store = state.partInspectorOpen;
  if (!store || store.forType !== type) {
    state.partInspectorOpen = { forType: type, sections: {} };
    return state.partInspectorOpen.sections;
  }
  return store.sections;
}

function attachAccordionHandlers(type) {
  dom.partInspector.querySelectorAll("[data-inspector-section]").forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const wrapper = trigger.closest(".part-accordion");
      const panel = wrapper?.querySelector(".part-accordion-panel");
      if (!panel) return;
      const next = trigger.getAttribute("aria-expanded") !== "true";
      trigger.setAttribute("aria-expanded", next ? "true" : "false");
      panel.hidden = !next;
      wrapper.classList.toggle("is-open", next);
      const store = openSectionsFor(type);
      store[trigger.dataset.inspectorSection] = next;
    });
  });
}

// ---------------------------------------------------------------------------
// Design-specific thermal prediction for the selected component type
// ---------------------------------------------------------------------------

function thermalPredictionFor(type) {
  const placed = state.design.filter((part) => part.type === type);
  if (!placed.length) return null;
  const analysis = analyzeDesignHeat(state.design, state.wiring || null, state.thermalLoadMode || DEFAULT_THERMAL_LOAD_MODE);
  return placed
    .map((part) => analysis.predictions.get(part))
    .filter(Boolean)
    .reduce((hottest, candidate) => !hottest || candidate.ratio > hottest.ratio ? candidate : hottest, null);
}

function thermalNoteFor(type) {
  const placed = state.design.filter((part) => part.type === type);
  if (!placed.length) return "Not placed in this design yet — predictions use the catalogue profile.";
  if (placed.length > 1) return `Showing the hottest of ${placed.length} placed ${PART_DEFS[type]?.name || type} components.`;
  return null;
}

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

function selectedPlacedPart() {
  const cell = state.selectedCell;
  if (!cell) return null;
  return state.design.find((part) => {
    const footprint = (PART_STATS[part.type] || PART_STATS.frame).footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(part.x, part.y, footprint, part.rotation || 0);
    return cells.some((candidate) => candidate.x === cell.x && candidate.y === cell.y) || (part.x === cell.x && part.y === cell.y);
  }) || null;
}

function selectedPlacedPartOfType(type) {
  const placed = selectedPlacedPart();
  return placed?.type === type ? placed : null;
}

// ---------------------------------------------------------------------------
// Interactive component configuration (not statistics)
// ---------------------------------------------------------------------------

function switchgearControlsMarkup(type) {
  if (type !== "switchgear") return "";
  const placed = selectedPlacedPartOfType(type);
  if (!placed) return `<p class="part-inspector-tip">Place or select a Switchgear component to configure its saved mode and rating.</p>`;
  const mode = placed.switchgearMode || "closed";
  const rating = placed.switchgearRatingTier || "standard";
  const button = (kind, value, label) => `<button type="button" data-switchgear-config="${kind}" data-switchgear-value="${value}" aria-pressed="${String((kind === "mode" ? mode : rating) === value)}">${label}</button>`;
  return `<section class="part-inspector-config switchgear-config" aria-label="Switchgear Blueprint configuration">
    <h4 class="part-section-heading">Switchgear settings</h4>
    <div class="switchgear-control-row"><span>Default mode</span>${button("mode", "open", "Open")}${button("mode", "closed", "Closed")}${button("mode", "automatic", "Automatic")}</div>
    <div class="switchgear-control-row"><span>Rating</span>${button("rating", "light", "Light")}${button("rating", "standard", "Standard")}${button("rating", "heavy", "Heavy")}</div>
  </section>`;
}

function attachSwitchgearControlHandlers() {
  dom.partInspector.querySelectorAll("[data-switchgear-config]").forEach((button) => {
    button.addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent("blueprint-switchgear-config", { detail: { kind: button.dataset.switchgearConfig, value: button.dataset.switchgearValue } }));
    });
  });
}

function droneBayControlsMarkup(type) {
  if (type !== "droneBay") return "";
  const placed = selectedPlacedPartOfType(type);
  if (!placed) return `<p class="part-inspector-tip">Place or select a Drone Bay to choose its squad.</p>`;
  const selected = globalThis.DroneBayRules?.normalizeDroneType(placed.droneType);
  const droneConfig = PART_STATS.droneBay?.droneConfig || GENERATED_BALANCE?.drones || {};
  const types = droneConfig.types || GENERATED_BALANCE?.drones?.types || {};
  const button = (value) => {
    const config = types[value] || {};
    const label = config.label || value;
    return `<button type="button" class="drone-type-choice drone-type-${value}" data-drone-type="${value}" aria-pressed="${String(selected === value)}">
      <strong>${escapeHtml(label)}</strong>
      <span>${Number(config.productionSeconds) || 0}s rebuild</span>
      <small>${escapeHtml(config.intendedUse || "")}</small>
    </button>`;
  };
  const launch = globalThis.DroneBayRules?.exposedLaunchEdges(state.design, state.design.indexOf(placed), PART_STATS)?.[0];
  return `<section class="part-inspector-config drone-bay-config" aria-label="Drone Bay configuration">
    <h4 class="part-section-heading">Drone squad</h4>
    <p class="drone-config-status ${selected ? "is-configured" : "is-required"}">${selected ? `${types[selected]?.label || selected} squad selected` : "Choose a drone type before saving or deploying."}</p>
    <div class="drone-type-choices" role="radiogroup" aria-label="Drone type">${["fighter", "defence", "repair"].map(button).join("")}</div>
    <p class="drone-launch-status ${launch ? "is-valid" : "is-blocked"}">${launch ? `Launch edge: ${launch.side}` : "Blocked: one complete two-cell edge must face open space."}</p>
  </section>`;
}

function attachDroneBayControlHandlers() {
  dom.partInspector.querySelectorAll("[data-drone-type]").forEach((button) => {
    button.addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent("blueprint-drone-config", { detail: { droneType: button.dataset.droneType } }));
    });
  });
}

// ---------------------------------------------------------------------------
// Description enrichment (unchanged gameplay copy)
// ---------------------------------------------------------------------------

function enrichDescription(type, baseDescription) {
  if (type === "railgun" || type === "lightRailgun" || type === "heavyRailgun") {
    return `${baseDescription} Long-range kinetic weapon. Weak into shields, strong against exposed hull. Narrow arc and slow fire rate.`;
  }
  if (type === "beamEmitter") {
    return "Sustained shield-breaking beam that aims towards the enemy Core. It strikes the first obstruction and can carry part of its excess damage into one component directly behind a destroyed module.";
  }
  if (type === "autocannon") {
    return `${baseDescription} Rapid kinetic weapon. Poor against shields, better against exposed hull and light ships.`;
  }
  if (type === "torpedo") {
    return `${baseDescription} Heavy explosive missile. Devastating to hull but vulnerable to point defence.`;
  }
  if (type === "swarmMissile") {
    return `${baseDescription} Fires many lighter missiles. Good at overwhelming defences but weaker per hit.`;
  }
  if (type === "pointDefense" || type === "flakCannon" || type === "interceptorPod") {
    return `${baseDescription} Defensive weapon that intercepts incoming missiles and torpedoes. Weak against ships.`;
  }
  return baseDescription;
}
