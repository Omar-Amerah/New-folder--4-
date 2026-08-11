// Renders the Blueprint "Selected Component" inspector.
//
// The information architecture lives in design/componentInspectorModel.js; this
// module only turns that model into DOM. Layout is deliberately flat : one outer
// panel, lightweight specification cells, one capability group, warning panels
// where warranted, and accordion dividers : rather than boxes nested in boxes.

import { dom } from "./dom.js";
import { state, DEFAULT_THERMAL_LOAD_MODE } from "../state.js";
import { PART_DEFS, PART_STATS, isRotatablePart, partCategory, partDescription, partIconMarkup } from "../design/parts.js";
import { escapeHtml } from "../shared/formatting.js";
import { openArticle } from "../ledger/fleetLedgerUi.js";
import { analyzeDesignHeat } from "../design/thermalAnalysis.js";
import { getOccupiedCells } from "../design/footprint.js";
import { GENERATED_BALANCE } from "../generatedBalance.js";
import { formatPercent } from "../design/statFormatting.js";
import { getCachedDesignDataSupport, getDesignSourceAllocation } from "../design/dataSupportAnalysis.js";
import { buildComponentInspectorModel, powerRequirementState, dataRequirementState } from "../design/componentInspectorModel.js";
import { calculateUniversalPower } from "../shared/universalPower.js";
import { sortStatusCallouts } from "../design/statusCalloutOrder.js";

export function renderPartInspector() {
  const type = state.selectedPart || selectedPlacedPart()?.type;
  if (!type) {
    dom.partInspector.innerHTML = `<p class="part-description part-inspector-empty">Select a component on the grid to inspect it.</p>`;
    return;
  }
  const def = PART_DEFS[type] || PART_DEFS.frame;
  const stat = PART_STATS[type] || PART_STATS.frame;
  const placed = selectedPlacedPartOfType(type);
  let launchEdge = null;
  let preferredLaunchEdge = null;
  if (placed && placed.type === "droneBay") {
    const componentIndex = state.design.indexOf(placed);
    const droneConfig = PART_STATS.droneBay?.droneConfig || {};
    const validation = globalThis.DroneBayRules?.validateDroneBays(state.design, PART_STATS, { maximum: droneConfig.maxBaysPerShip });
    launchEdge = validation?.bays?.find((bay) => bay.componentIndex === componentIndex)?.launchEdge || null;
    preferredLaunchEdge = globalThis.DroneBayRules?.preferredLaunchEdgeStatus?.(state.design, componentIndex, PART_STATS) || null;
  }
  const model = buildComponentInspectorModel(type, stat, {
    name: def.name,
    description: partDescription(type, stat),
    category: partCategory(type),
    effectiveCost: `$${Number(stat.cost || 0).toLocaleString()}`,
    prediction: thermalPredictionFor(type),
    droneType: placed?.droneType || globalThis.DroneBayRules?.normalizeDroneType?.(placed?.droneType) || null,
    thermalNote: thermalNoteFor(type),
    requirementStatus: requirementStatusFor(placed),
    includePowerRequirements: true,
    includeDataRequirements: true,
    automaticDataLinks: false,
    launchEdge,
    preferredLaunchEdge
  });

  // Expanded accordions persist while the same component stays selected and
  // reset when the selection moves to a different component.
  const openState = openSectionsFor(type);


  dom.partInspector.innerHTML = `
    ${headerMarkup(type, model)}
    ${coreSpecMarkup(model)}
    ${capabilityMarkup(model)}
    ${commandAuraMarkup(model)}
    ${calloutStackMarkup(model)}
    ${droneBayControlsMarkup(type)}
    ${model.sections.map((section) => accordionMarkup(section, openState)).join("")}
    ${isRotatablePart(type) ? `<p class="part-inspector-tip">Hover a placed matching part and press R to rotate.</p>` : ""}
  `;

  attachDroneBayControlHandlers();
  attachRequirementHandlers();
  dom.partInspector.querySelectorAll("[data-component-action]").forEach((button) => {
    button.addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent("blueprint-component-action", { detail: { action: button.dataset.componentAction } }));
    });
  });
  attachAccordionHandlers(type);
  dom.partInspector.querySelectorAll("[data-ledger-link]").forEach((button) => {
    button.addEventListener("click", () => openArticle(button.dataset.ledgerLink));
  });
}

// ---------------------------------------------------------------------------
// Markup builders
// ---------------------------------------------------------------------------

function headerMarkup(type, model) {
  return `
    <header class="part-inspector-header${type === "droneBay" ? " is-drone-bay" : ""}">
      <div class="part-inspector-title">
        ${partIconMarkup(type, "inspector-glyph")}
        <div class="part-inspector-heading">
          <strong class="part-inspector-name">${escapeHtml(model.header.name)}</strong>
          <span class="part-category-label">${escapeHtml(model.header.badge)}</span>
        </div>
      </div>
      <p class="part-description">${escapeHtml(model.header.description)}</p>
      <button type="button" class="part-inspector-ledger-link secondary" data-ledger-link="${escapeHtml(type)}">View in Fleet Ledger</button>
    </header>`;
}

function isNoOpModifier(row) {
  return row.kind === "modifier" && row.raw === 1;
}

function statLabelMarkup(row) {
  const hint = row.hint ? String(row.hint) : "";
  const hintAttributes = hint
    ? ` title="${escapeHtml(hint)}" aria-label="${escapeHtml(`${row.label}: ${hint}`)}"`
    : "";
  return `<span class="part-spec-label${hint ? " has-hint" : ""}"${hintAttributes}>${escapeHtml(row.label)}</span>`;
}

function coreSpecMarkup(model) {
  if (!model.core.length) return "";
  return `
    <div class="part-core-specs" role="list" aria-label="Core specifications">
      ${model.core.filter((row) => !isNoOpModifier(row)).map((row) => `
        <div class="part-spec-cell${row.tone ? ` is-${row.tone}` : ""}" role="listitem">
          ${statLabelMarkup(row)}
          <strong class="part-spec-value">${escapeHtml(row.value)}</strong>
        </div>`).join("")}
    </div>`;
}

function capabilityMarkup(model) {
  if (!model.capability.length) return "";
  return `
    <section class="part-capability${model.type === "droneBay" ? " is-drone-bay" : ""}" aria-label="Primary capability">
      <h4 class="part-section-heading">Primary capability</h4>
      <div class="part-capability-grid">
        ${model.capability.filter((row) => !isNoOpModifier(row)).map((row) => `
          <div class="part-capability-cell">
            ${statLabelMarkup(row)}
            <strong class="part-spec-value">${escapeHtml(row.value)}</strong>
          </div>`).join("")}
      </div>
    </section>`;
}

// One consistent requirements area. Icons never sit beside individual stat
// values, and every chip is a real button that discloses a compact explanation.
// A currently-failing dependency is stated visibly on the row itself : never
// hidden behind the tooltip.
function requirementsMarkup(model) {
  if (!model.requirements.length) return "";
  const orderedRequirements = sortStatusCallouts(model.requirements.map((requirement) => ({
    ...requirement,
    level: requirement.status === "met" ? "good" : requirement.status === "unmet" ? "bad" : "warning"
  })));
  const chips = orderedRequirements.map((requirement) => {
    const tipId = `partRequirementTip-${requirement.id}`;
    const unmet = requirement.status === "unmet";
    const met = requirement.status === "met";
    const stateText = unmet ? "not met" : "met";
    const ariaLabel = `${requirement.label} requirement ${stateText}: ${requirement.summary}. ${requirement.failureText || ""}`.trim();
    return `
      <button type="button" class="part-requirement${met ? " is-met" : ""}${unmet ? " is-unmet" : ""}"
              data-requirement="${escapeHtml(requirement.id)}"
              aria-expanded="false" aria-controls="${tipId}"
              aria-label="${escapeHtml(ariaLabel)}">
        <span class="part-requirement-icon" aria-hidden="true">${escapeHtml(requirement.icon)}</span>
        <span class="part-requirement-label">${escapeHtml(requirement.label)}</span>
      </button>`;
  }).join("");



  const tips = orderedRequirements.map((requirement) => `
    <div class="part-requirement-tip" id="partRequirementTip-${escapeHtml(requirement.id)}" role="region"
         data-requirement-tip="${escapeHtml(requirement.id)}" hidden>
      <strong>${escapeHtml(requirement.label)} : ${escapeHtml(requirement.summary)}</strong>
      <span>${escapeHtml(requirement.detail)}</span>
    </div>`).join("");

  const failures = orderedRequirements
    .filter((requirement) => requirement.status === "unmet" && requirement.failureText)
    .map((requirement) => `
    <span class="part-requirement-failure" data-requirement-failure="${escapeHtml(requirement.id)}">
      ${escapeHtml(requirement.label)} unmet: ${escapeHtml(requirement.failureText)}
    </span>`).join("");

  return `
    <section class="part-requirements" aria-label="Requirements">
      <div class="part-requirements-row">
        <h4 class="part-section-heading part-requirements-heading">Requirements</h4>
        <div class="part-requirement-chips">${chips}</div>
      </div>
      ${failures ? `<div class="part-requirement-failures">${failures}</div>` : ""}
      ${tips}
    </section>`;
}

// Resolve whether the selected *placed* component currently meets its Power and
// explicit Data Link dependencies. Unplaced palette components report no status.
function requirementStatusFor(placed) {
  if (!placed) return {};
  const design = Array.isArray(state.design) ? state.design : [];
  const index = design.indexOf(placed);
  if (index < 0) return {};
  const status = {};
  const stat = PART_STATS[placed.type] || PART_STATS.frame;

  if ((stat.powerUse || 0) > 0) {
    const flow = calculateUniversalPower(design, PART_STATS);
    status.power = powerRequirementState(flow.byComponentIndex[index] || {
      componentIndex: index,
      requestedMw: Number(stat.powerUse) || 0,
      allocatedMw: 0,
      unmetMw: Number(stat.powerUse) || 0
    });
  }

  if (stat.rangeBonus || stat.accuracyBonus || stat.fireRateBonus) {
    try {
      const analysis = getCachedDesignDataSupport(design, PART_STATS, {
        thermalLoadMode: state.thermalLoadMode || DEFAULT_THERMAL_LOAD_MODE,
        dataLinks: state.dataLinks
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
  const rows = model.thermalSummary;
  if (!rows.length) return "";
  return `
    <div class="part-thermal-summary" aria-label="Thermal summary">
      ${rows.map((row) => `
        <p class="part-thermal-line${row.tone ? ` is-${row.tone}` : ""}">
          <span class="part-thermal-label">${escapeHtml(row.label)}</span>
          <span class="part-thermal-value">${escapeHtml(row.value)}</span>
        </p>`).join("")}
    </div>`;
}

function warningsMarkup(model) {
  if (!model.warnings.length) return "";
  return model.warnings.map((warning) => `
    <div class="part-warning is-${escapeHtml(warning.tone || "warning")}" role="note" data-warning="${escapeHtml(warning.id)}">
      <span class="part-warning-icon" aria-hidden="true">${warning.tone === "ok" ? "\u2713" : "!"}</span>
      <div class="part-warning-body">
        <strong class="part-warning-title">${escapeHtml(warning.title)}</strong>
        <span class="part-warning-text">${escapeHtml(warning.body)}</span>
      </div>
    </div>`).join("");
}

function calloutStackMarkup(model) {
  if (!model.callouts.length) return "";
  const groups = [];
  for (const callout of model.callouts) {
    let group = groups[groups.length - 1];
    if (!group || group.category !== callout.category) {
      group = { category: callout.category, callouts: [] };
      groups.push(group);
    }
    group.callouts.push(callout);
  }
  const markup = (callout) => {
    if (callout.renderType === "thermal") return thermalSummaryMarkup({ thermalSummary: [callout.row] });
    if (callout.renderType === "requirements") return requirementsMarkup({ requirements: callout.requirements });
    return warningsMarkup({ warnings: [callout.warning] });
  };
  return `<div class="part-callout-stack" data-callout-stack>
    ${groups.map((group) => `<div class="part-callout-group is-${escapeHtml(group.category)}" data-callout-category="${escapeHtml(group.category)}">
      ${group.callouts.map((callout) => `<div class="part-callout-item" data-callout-id="${escapeHtml(callout.id)}" data-callout-category="${escapeHtml(callout.category)}">${markup(callout)}</div>`).join("")}
    </div>`).join("")}
  </div>`;
}

function commandAuraMarkup(model) {
  const section = model.commandAura;
  if (!section) return "";
  return `
    <section class="part-command-aura${section.inactive ? " is-inactive" : ""}" aria-label="${escapeHtml(section.title)}">
      <h4 class="part-section-heading">${escapeHtml(section.title)}</h4>
      <div class="part-detail-list">
        ${section.rows.filter((row) => !isNoOpModifier(row)).map((row) => `
          <div class="part-detail-row${row.tone ? ` is-${row.tone}` : ""}">
            ${statLabelMarkup(row)}
            <strong class="part-detail-value">${escapeHtml(row.value)}</strong>
          </div>`).join("")}
      </div>
      ${section.note ? `<p class="part-accordion-note">${escapeHtml(section.note)}</p>` : ""}
    </section>`;
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
          ${section.rows.filter((row) => !isNoOpModifier(row)).map((row) => `
            <div class="part-detail-row${row.tone ? ` is-${row.tone}` : ""}">
              ${statLabelMarkup(row)}
              <strong class="part-detail-value">${escapeHtml(row.value)}</strong>
            </div>`).join("")}
        </div>
        ${section.note ? `<p class="part-accordion-note">${escapeHtml(section.note)}</p>` : ""}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Accordion state : remembered per selected component, reset on change
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
  const analysis = analyzeDesignHeat(state.design, state.dataLinks, state.thermalLoadMode || DEFAULT_THERMAL_LOAD_MODE);
  return placed
    .map((part) => analysis.predictions.get(part))
    .filter(Boolean)
    .reduce((hottest, candidate) => !hottest || candidate.ratio > hottest.ratio ? candidate : hottest, null);
}

function thermalNoteFor(type) {
  const placed = state.design.filter((part) => part.type === type);
  if (!placed.length) return "Not placed in this design yet : predictions use the catalogue profile.";
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

function droneBayControlsMarkup(type) {
  if (type !== "droneBay") return "";
  const placed = selectedPlacedPartOfType(type);
  if (!placed) return `<p class="part-inspector-tip">Place or select a Drone Bay to choose its squad.</p>`;
  const selected = globalThis.DroneBayRules?.normalizeDroneType(placed.droneType);
  const droneConfig = PART_STATS.droneBay?.droneConfig || GENERATED_BALANCE?.drones || {};
  const types = droneConfig.types || GENERATED_BALANCE?.drones?.types || {};
  const roles = {
    fighter: "Attacks the parent target and nearby hostile drones",
    defence: "Protects the parent and prioritises hostile drones",
    repair: "Repairs the parent, then nearby allies"
  };
  const icons = {
    fighter: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 3.2 6.2 5.8 2.6-5.8 2.2L12 21l-3.2-7L3 11.8l5.8-2.6L12 3Z"/></svg>`,
    defence: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 20 6v5c0 5.1-3.2 8.5-8 10-4.8-1.5-8-4.9-8-10V6l8-3Z"/><path d="M8 12h8"/></svg>`,
    repair: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6V3Z"/></svg>`
  };
  const button = (value) => {
    const config = types[value] || {};
    const label = config.label || value;
    const isSelected = selected === value;
    const statsList = [];
    const squadSize = config.squadSize ?? droneConfig.squadSize;
    const fuelSeconds = config.fuelSeconds ?? droneConfig.fuelSeconds;
    if (squadSize) statsList.push(`${squadSize} drones`);
    if (fuelSeconds) statsList.push(`${fuelSeconds}s fuel`);
    if (config.hull) statsList.push(`${config.hull} HP`);
    if (config.speed) statsList.push(`${config.speed} m/s`);
    if (config.commandRange) statsList.push(`${config.commandRange} m`);
    if (config.productionSeconds) statsList.push(`${config.productionSeconds}s rebuild`);
    if (config.damage) statsList.push(`${config.damage} dmg`);
    if (config.repairPerSecond) statsList.push(`${config.repairPerSecond} HP/s rep`);
    const evasionSpeedBoost = Number(config.evasionSpeedBoost);
    const projectileEvasion = Number.isFinite(evasionSpeedBoost) && evasionSpeedBoost > 0
      ? `Projectile Evasion: Yes, up to +${formatPercent(evasionSpeedBoost)} speed while dodging`
      : "Projectile Evasion: None";

    const statChipsMarkup = statsList.map((stat) => `<span class="drone-stat-tag">${escapeHtml(stat)}</span>`).join("");

    return `<button type="button" role="radio" class="drone-type-choice drone-type-${value}${isSelected ? " is-selected" : ""}" data-drone-type="${value}" aria-checked="${String(isSelected)}" aria-pressed="${String(isSelected)}">
      <span class="drone-choice-topline">
        <span class="drone-choice-icon">${icons[value]}</span>
        ${isSelected ? `<span class="drone-choice-selected">Selected</span>` : ""}
      </span>
      <strong class="drone-choice-name">${escapeHtml(label)}</strong>
      <div class="drone-choice-stats">${statChipsMarkup}</div>
      <small class="drone-choice-role">${escapeHtml(roles[value])}</small>
      <small class="drone-choice-evasion">${escapeHtml(projectileEvasion)}</small>
    </button>`;
  };
  const selectedConfig = selected ? types[selected] : null;
  const squadStatus = !selectedConfig
    ? `<div class="drone-config-warning" role="note"><span class="drone-config-warning-icon" aria-hidden="true">!</span><span><strong>Squad Type Required: </strong>Choose Fighter, Defence or Repair before saving or deploying.</span></div>`
    : "";
  return `<section class="part-inspector-config drone-bay-config" aria-label="Drone Bay configuration">
    <h4 class="part-section-heading">Drone squad</h4>
    ${squadStatus}
    <div class="drone-type-choices" role="radiogroup" aria-label="Drone type">${["fighter", "defence", "repair"].map(button).join("")}</div>
  </section>`;
}

function attachDroneBayControlHandlers() {
  dom.partInspector.querySelectorAll("[data-drone-type]").forEach((button) => {
    button.addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent("blueprint-drone-config", { detail: { droneType: button.dataset.droneType } }));
    });
  });
}
