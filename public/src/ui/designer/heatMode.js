import { dom } from "../dom.js";
import { state, DEFAULT_THERMAL_LOAD_MODE } from "../../state.js";
import { PART_DEFS, PART_STATS } from "../../design/parts.js";
import { getOccupiedCells } from "../../design/footprint.js";
import { coolantNetworkAt } from "../../design/coolantLayout.js";
import { escapeHtml } from "../../shared/formatting.js";
import { analyzeDesignHeat, describeThermalComponent } from "../../design/thermalAnalysis.js";
import { buildHeatCardModel, heatCardMarkup } from "../../design/heatCardModel.js";
import { phaseLockOverlayAnimations } from "../overlayAnimation.js";
import { GRID_SIZE, findPartAt, restoreBlueprintCellTitle } from "./layout.js";

const THERMAL_SCENARIO_NAMES = { idle: "Idle", combat: "Typical Combat", full: "Maximum Sustained Load" };
const THERMAL_SCENARIO_EXPLANATIONS = {
  idle: "systems mostly at standby",
  combat: "expected mixed combat activity",
  full: "all applicable systems requesting full output"
};
const HEAT_FLOW_THRESHOLD = 0.05;
let cachedHeatAnalysis = null;

function heatDesignSignature(design, dataLinks, mode) {
  return `${mode}|${JSON.stringify(
    design.map(part => [
      part.type,
      part.x,
      part.y,
      part.rotation || 0,
      part.batteryMode || "",
      part.disabled || false
    ])
  )}|${JSON.stringify(dataLinks || [])}`;
}

function cachedPartReferencesMatch(design) {
  const references = cachedHeatAnalysis?.partReferences;

  return Boolean(
    references &&
    references.length === design.length &&
    references.every((part, index) => part === design[index])
  );
}

export function getScenarioHeatAnalysis(mode = state.thermalLoadMode || DEFAULT_THERMAL_LOAD_MODE) {
  const design = state.design;
  const signature = heatDesignSignature(design, state.dataLinks, mode);

  if (
    cachedHeatAnalysis?.signature === signature &&
    cachedPartReferencesMatch(design)
  ) {
    return cachedHeatAnalysis.result;
  }

  const result = analyzeDesignHeat(design, state.dataLinks, mode);
  cachedHeatAnalysis = {
    signature,
    partReferences: [...design],
    result
  };
  return result;
}

export function invalidateHeatAnalysisCache() { cachedHeatAnalysis = null; }

function heatAnalysisMatchesCurrentDesign(analysis) {
  if (!analysis) return false;

  return state.design.every(part =>
    analysis.predictions?.has(part) &&
    analysis.componentHeat?.has(part) &&
    analysis.componentClasses?.has(part)
  );
}

function freshCurrentHeatAnalysis() {
  let analysis = currentHeatAnalysis();

  if (!heatAnalysisMatchesCurrentDesign(analysis)) {
    invalidateHeatAnalysisCache();
    analysis = currentHeatAnalysis();
  }

  return analysis;
}

export function currentHeatAnalysis(mode = state.thermalLoadMode || DEFAULT_THERMAL_LOAD_MODE) {
  return getScenarioHeatAnalysis(mode);
}

export function suppressHeatGridNativeTooltips() {
  for (const cell of dom.grid.querySelectorAll(".build-cell")) {
    cell.removeAttribute("title");
  }
}


function migrateHeatFlowViewState() {
  if (state.heatFlowView === "total") state.showAllHeatFlows = true;
  if (state.heatFlowView === "local" || state.heatFlowView === "off") state.showAllHeatFlows = false;
  state.heatFlowView = undefined;
}

function heatLegendIsOpen() {
  return Boolean(dom.blueprintHeatLegend && !dom.blueprintHeatLegend.hidden);
}

function syncHeatLegendDisclosure() {
  const button = dom.blueprintHeatLegendButton;
  if (!button) return;
  button.setAttribute("aria-expanded", String(heatLegendIsOpen()));
}

function positionHeatLegend() {
  const button = dom.blueprintHeatLegendButton;
  const legend = dom.blueprintHeatLegend;
  if (!button || !legend || legend.hidden || typeof button.getBoundingClientRect !== "function") return;
  const buttonRect = button.getBoundingClientRect();
  const legendRect = legend.getBoundingClientRect?.() || { width: 360, height: 260 };
  const viewportWidth = Number(window.innerWidth) || document.documentElement?.clientWidth || 360;
  const viewportHeight = Number(window.innerHeight) || document.documentElement?.clientHeight || 360;
  const margin = 8;
  const gap = 6;
  const width = Math.min(legendRect.width || 360, viewportWidth - margin * 2);
  const height = Math.min(legendRect.height || 260, viewportHeight - margin * 2);
  let left = buttonRect.right - width;
  let top = buttonRect.bottom + gap;
  if (top + height > viewportHeight - margin) top = buttonRect.top - height - gap;
  left = Math.max(margin, Math.min(left, viewportWidth - width - margin));
  top = Math.max(margin, Math.min(top, viewportHeight - height - margin));
  legend.style.left = `${Math.round(left)}px`;
  legend.style.top = `${Math.round(top)}px`;
}

export function closeHeatLegend({ restoreFocus = false } = {}) {
  if (!dom.blueprintHeatLegend) return;
  dom.blueprintHeatLegend.hidden = true;
  syncHeatLegendDisclosure();
  if (restoreFocus) dom.blueprintHeatLegendButton?.focus();
}

function toggleHeatLegend() {
  if (!dom.blueprintHeatLegend) return;
  if (heatLegendIsOpen()) {
    closeHeatLegend({ restoreFocus: true });
    return;
  }
  dom.blueprintHeatLegend.hidden = false;
  syncHeatLegendDisclosure();
  positionHeatLegend();
}

export function ensureHeatLegendDisclosureBinding() {
  const button = dom.blueprintHeatLegendButton;
  const legend = dom.blueprintHeatLegend;
  if (!button || !legend) return;
  if (document.body && legend.parentElement !== document.body) document.body.appendChild(legend);
  if (button.dataset.hasDisclosure !== "true") {
    button.addEventListener("click", toggleHeatLegend);
    document.addEventListener("pointerdown", event => {
      if (!heatLegendIsOpen()) return;
      if (event.target === button || legend.contains?.(event.target)) return;
      closeHeatLegend();
    });
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || !heatLegendIsOpen()) return;
      event.preventDefault();
      closeHeatLegend({ restoreFocus: true });
    });
    window.addEventListener("resize", positionHeatLegend);
    document.addEventListener("scroll", positionHeatLegend, true);
    button.dataset.hasDisclosure = "true";
  }
  syncHeatLegendDisclosure();
}

export function refreshHeatStateLegend() {
  const list = dom.blueprintHeatLegend?.querySelector(".heat-state-list");
  const rules = globalThis.HeatRules;
  if (!list || !rules) return;
  const percent = (ratio) => `${Math.round(ratio * 100)}%`;
  const output = (state) => percent(rules.activeOutputForState(rules.STATE[state]));
  const recovery = percent(rules.THRESHOLDS.overheated - rules.HYSTERESIS.overheated);
  const labels = rules.STATE_LABELS;
  const coolOutput = output("NORMAL");
  const warmOutput = output("WARM");
  const coolWarmOutput = coolOutput === warmOutput
    ? `${coolOutput} output`
    : `Cool ${coolOutput}; Warm ${warmOutput}`;
  const entries = {
    normal: { name: `${labels[0]} / ${labels[1]}`, rule: `${coolWarmOutput} \u00B7 ${labels[1]} at ${percent(rules.THRESHOLDS.warm)}` },
    hot: { name: labels[2], rule: `${output("HOT")} output \u00B7 Starts at ${percent(rules.THRESHOLDS.hot)}` },
    critical: { name: labels[3], rule: `${output("CRITICAL")} output \u00B7 Starts at ${percent(rules.THRESHOLDS.critical)}` },
    overheated: { name: labels[4], rule: `${output("OVERHEATED")} output \u00B7 Starts at ${percent(rules.THRESHOLDS.overheated)} \u00B7 Restart <${recovery}` }
  };
  for (const [key, entry] of Object.entries(entries)) {
    const element = list.querySelector(`[data-heat-state="${key}"]`);
    if (!element) continue;
    const name = element.querySelector(".heat-state-name");
    const rule = element.querySelector(".heat-state-rule");
    if (name) name.textContent = entry.name;
    if (rule) rule.textContent = entry.rule;
  }
}


function addClassString(element, classString) {
  const tokens = String(classString || "")
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length) element.classList.add(...tokens);
}

export function refreshHeatPresentationSafely() {
  clearHeatUiError();

  try {
    const analysis = freshCurrentHeatAnalysis();

    if (!heatAnalysisMatchesCurrentDesign(analysis)) {
      throw new Error("Thermal analysis does not match current design");
    }

    applyHeatPresentation(analysis);
    updateHeatInspectionOverlay(analysis);
    clearHeatUiError();
  } catch (error) {
    console.error("Heat presentation failed", error);
    showHeatUiError(error);
  }
}

function clearHeatUiError() {
  dom.grid?.classList.remove("heat-ui-error");
  dom.blueprintThermalHud?.querySelector(".heat-ui-error-message")?.remove();
  if (dom.blueprintThermalHud && !dom.blueprintThermalHud.childElementCount) dom.blueprintThermalHud.hidden = true;
}

function showHeatUiError(error) {
  clearHeatFlowOverlay();
  clearExteriorCoolingIndicators();
  clearHeatContextCard();
  dom.grid?.classList.add("heat-ui-error");
  if (!dom.blueprintThermalHud) return;
  dom.blueprintThermalHud.hidden = false;
  dom.blueprintThermalHud.querySelector(".heat-ui-error-message")?.remove();
  const message = document.createElement("div");
  message.className = "heat-ui-error-message";
  message.textContent = "Heat view could not be loaded. Please reopen the Heat tab.";
  dom.blueprintThermalHud.prepend(message);
}

function applyHeatPresentation(heatAnalysis) {
  clearInvalidHeatIndexes();
  const updates = [];
  for (const cell of dom.grid.querySelectorAll(".build-cell.occupied")) {
    const index = Number(cell.dataset.partIndex);
    const part = state.design[index];
    if (!part) continue;
    const heatClass = heatAnalysis.componentClasses.get(part) || "";
    const prediction = heatAnalysis.predictions.get(part);
    if (!prediction) {
      throw new Error(`Missing heat prediction for component ${index}`);
    }
    const displayedHeat = Math.max(0, Math.round(heatAnalysis.componentHeat.get(part) || 0));
    // Warning tiers come from the authoritative Heat state (shared runtime
    // thresholds), not from duplicated percentage cutoffs.
    const HeatState = globalThis.HeatRules.STATE;
    const meltdown = prediction?.meltdownTime != null;
    const overheated = !meltdown && (displayedHeat >= 100 || prediction.state >= HeatState.OVERHEATED);
    const critical = !meltdown && !overheated && prediction.state === HeatState.CRITICAL;
    const role = thermalRoleMarkup(part, prediction, heatAnalysis, index);
    const stateLabel = globalThis.HeatRules.STATE_LABELS[prediction.state] || "Cool";
    const powerThermal = heatAnalysis.powerThermal;
    const componentDiag = powerThermal?.components?.[index] || {};
    const flags = [];
    if ((componentDiag.operationalMultiplier ?? 1) < 1) flags.push((componentDiag.operationalMultiplier || 0) <= 0 ? "disabled component" : "throttled component");
    const flagClass = (componentDiag.operationalMultiplier ?? 1) < 1 ? "heat-flag-throttled" : "";
    const threeDigitHeat = displayedHeat >= 100;
    const heatBadge = `<span
      class="component-heat-value${threeDigitHeat
        ? " component-heat-value-three-digit"
        : ""}"
      title="Predicted heat capacity used"
      aria-label="Predicted heat capacity used: ${displayedHeat} percent"
    >
      <small class="heat-badge-icon" aria-hidden="true">♨</small>
      <span class="heat-badge-number">${displayedHeat}</span>
      <small class="heat-badge-percent">%</small>
    </span>`;
    const heatWarning = meltdown
      ? `<span class="component-overheat-warning" title="Reactor meltdown predicted : will explode at sustained load" aria-label="Reactor meltdown predicted">☢</span>`
      : overheated
      ? `<span class="component-overheat-warning" title="Overheated" aria-label="Overheated">▲</span>`
      : critical ? `<span class="component-critical-warning" title="Critical heat" aria-label="Critical heat">▲</span>` : "";
    updates.push({
      cell,
      heatClass: `${heatClass} ${flagClass}`,
      markup: `${role}${heatBadge}${heatWarning}`,
      ariaLabel:
        `${PART_DEFS[part.type].name}. ` +
        `${stateLabel}. ` +
        `${displayedHeat} percent heat capacity used.` +
        (flags.length ? ` ${flags.join("; ")}.` : "")
    });
  }
  clearHeatPresentation();
  for (const update of updates) {
    addClassString(update.cell, update.heatClass);
    update.cell.insertAdjacentHTML("beforeend", update.markup);
    update.cell.removeAttribute("title");
    update.cell.setAttribute("aria-label", update.ariaLabel);
  }
  // The badges above are new elements every refresh, so their pulse would
  // otherwise drift out of phase with the cell shell they sit on and with each
  // other. Anchoring to the document timeline keeps every layer of the
  // overheated presentation, on every cell, pulsing as one.
  phaseLockOverlayAnimations(dom.grid);
  renderFullLoadThermalPanel(currentHeatAnalysis("full"), heatAnalysis);
}

function blueprintThermalStateLabel(result) {
  const a = result?.analysis || {};
  if ((a.overheatedCount || 0) > 0) return "Overheating";
  if ((a.net || 0) > 0 && a.firstOverheatTime != null) return "Unstable";
  if ((a.peakPredictedHeat || 0) >= 0.9) return "Near Capacity";
  if ((a.net || 0) > 0.05) return "Heating";
  return "Stable";
}

function fmtHeat(value) { return `${(Number(value) || 0).toFixed(1)} H/s`; }
function fmtMw(value) { return `${(Number(value) || 0).toFixed(1)} MW`; }
function fmtSeconds(value) { return value == null ? "Predicted equilibrium" : `${Number(value).toFixed(1)} s to overheat`; }

function blueprintHeatSummaryMarkup(result) {
  const a = result.analysis;
  const power = result.powerThermal?.powerSummary || {};
  const hottestComponent = a.firstOverheatIndex >= 0 ? a.firstOverheatIndex : state.design.reduce((best, part, i) => {
    const p = result.predictions.get(part);
    const b = result.predictions.get(state.design[best]);
    return (p?.ratio || 0) > (b?.ratio || 0) ? i : best;
  }, 0);
  const throttled = (result.powerThermal?.components || []).filter(c => (c.operationalMultiplier ?? 1) < 1).length;
  const disabled = (result.powerThermal?.components || []).filter(c => (c.operationalMultiplier ?? 1) <= 0).length;
  const totalCapacity = (result.powerThermal?.components || []).reduce((sum, c) => sum + (Number(c.finalHeatCapacity) || 0), 0);
  const row = (l, v) => `<span>${escapeHtml(l)}</span><strong>${escapeHtml(String(v))}</strong>`;
  return `<div class="heat-design-summary power-thermal-summary" aria-label="Blueprint Heat and Power summary">
    <strong>${escapeHtml(THERMAL_SCENARIO_NAMES[a.mode] || a.mode)} : ${escapeHtml(THERMAL_SCENARIO_EXPLANATIONS[a.mode] || "")}</strong>
    ${row("State", blueprintThermalStateLabel(result))}
    ${row("Final total Heat capacity", `${Math.round(totalCapacity)} H`)}
    ${row("Total Heat generation", fmtHeat(a.generation))}
    ${row("Cooling", fmtHeat(a.cooling))}
    ${row("Net Heat rate", `${a.net >= 0 ? "+" : ""}${fmtHeat(a.net)}`)}
    ${row("Prediction", a.equilibriumTime != null ? `Equilibrium in ${a.equilibriumTime.toFixed(1)} s` : fmtSeconds(a.firstOverheatTime))}
    ${row("Hottest component", describeThermalComponent(hottestComponent, state.design))}
    ${row("Throttled / disabled", `${throttled} / ${disabled}`)}
    ${row("Power requested", fmtMw(power.requestedDemandMw))}
    ${row("Power delivered", fmtMw(power.deliveredDemandMw))}
    ${row("Power spare / unmet", `${fmtMw(power.spareGenerationMw)} / ${fmtMw(power.unmetDemandMw)}`)}
  </div>`;
}

function clearHeatFlowOverlay() {
  dom.heatFlowOverlayHost?.replaceChildren();
  dom.grid.querySelector(".heat-flow-overlay")?.remove();
}

function clearExteriorCoolingIndicators() {
  (dom.heatFlowOverlayHost || dom.grid)?.querySelectorAll(".exterior-cooling-overlay").forEach(item => item.remove());
}

function clearHeatContextCard() {
  if (!dom.heatContextCard) return;
  dom.heatContextCard.hidden = true;
  dom.heatContextCard.innerHTML = "";
  dom.heatContextCard.className = "heat-context-card";
}

export function clearHeatPresentation() {
  clearHeatFlowOverlay();
  clearExteriorCoolingIndicators();
  clearHeatContextCard();
  if (dom.blueprintThermalHud) { dom.blueprintThermalHud.hidden = true; dom.blueprintThermalHud.innerHTML = ""; }
  dom.grid.classList.remove("heat-inspecting");
  const exhaustAnalysis = state.blueprintView === "build"
    ? globalThis.EngineExhaustRules.analyze(state.design, PART_STATS)
    : null;
  for (const cell of dom.grid.querySelectorAll(".build-cell")) {
    for (const className of [...cell.classList]) {
      if (className.startsWith("heat-") || className.startsWith("thermal-") || className.startsWith("radiator-exposed")) cell.classList.remove(className);
    }
    cell.querySelectorAll(".component-heat-value, .component-overheat-warning, .component-critical-warning, .thermal-role-indicator, .heat-status-markers").forEach(item => item.remove());
    const index = Number(cell.dataset.partIndex);
    const part = state.design[index];
    if (state.blueprintView === "build") {
      restoreBlueprintCellTitle(cell, part, index, exhaustAnalysis);
    } else {
      cell.removeAttribute("title");
    }
  }
}

function refreshHeatFlowOverlay(analysis) {
  clearHeatFlowOverlay();
  clearExteriorCoolingIndicators();
  if (state.blueprintView === "heat") {
    renderHeatFlows(analysis);
    renderExteriorCoolingIndicators(analysis);
  }
}


export function clearHeatInspectionState() {
  state.hoveredHeatPartIndex = null;
}

function validHeatIndex(index) {
  return Number.isInteger(index) && index >= 0 && index < state.design.length;
}

export function updateHoveredHeatPart(x, y) {
  if (state.blueprintView !== "heat") { clearHeatContextCard(); clearExteriorCoolingIndicators(); return; }
  const part = Number.isFinite(x) && Number.isFinite(y) ? findPartAt(x, y) : null;
  const next = part ? state.design.indexOf(part) : null;
  if (state.hoveredHeatPartIndex === next) return;
  state.hoveredHeatPartIndex = next;
  updateHeatInspectionOverlay(currentHeatAnalysis());
}

export function clearInvalidHeatIndexes() {
  if (!validHeatIndex(state.hoveredHeatPartIndex)) state.hoveredHeatPartIndex = null;
}

function thermalRoleMarkup(part, prediction, result, index) {
  if (!prediction) return "";
  const pieces = [];
  if (prediction.generation > 0.05) pieces.push(`<span class="thermal-role-indicator heat-source" title="Active heat source: +${prediction.generation.toFixed(1)} H/s" aria-label="Active heat source generating ${prediction.generation.toFixed(1)} heat per second">✦</span>`);
  if (part.type === "heatSink") pieces.push(`<span class="thermal-role-indicator heat-sink-role" title="Storage: holds up to ${prediction.capacity} H of its own; removing ${prediction.cooling.toFixed(1)} H/s" aria-label="Heat Sink storing heat, removing ${prediction.cooling.toFixed(1)} H/s">▢</span>`);
  if (part.type === "radiator") {
    const exposed = result.exteriorDirections?.[index]?.size > 0;
    pieces.push(`<span class="thermal-role-indicator radiator-role" title="Strong external cooling: removing ${prediction.cooling.toFixed(1)} H/s; exterior exposure: ${exposed ? "yes" : "no"}" aria-label="Radiator removing ${prediction.cooling.toFixed(1)} H/s">⇱</span>`);
  }
  if (part.type === "heatVent") {
    const exposed = result.exteriorDirections?.[index]?.size > 0;
    pieces.push(`<span class="thermal-role-indicator heat-vent-role" title="Weak external cooling: removing ${prediction.cooling.toFixed(1)} H/s; ${exposed ? "exposed to space" : "enclosed : almost no cooling"}" aria-label="Heat Vent removing ${prediction.cooling.toFixed(1)} H/s">≡</span>`);
  }
  if (part.type === "heatPipe") pieces.push(`<span class="thermal-role-indicator heat-pipe-role" title="Coolant transport : moves heat between everything on this network, removes none itself" aria-label="Heat Pipe coolant transport, removes no heat">┄</span>`);
  return pieces.join("");
}

// The hover card is a decision aid, not a diagnostics dump: role-specific rows,
// a heat bar, and exceptions only. Engineering detail (capacities, Power
// allocation, accumulated simulation Heat totals) stays in the detailed Heat
// analysis panel. The contents themselves are built by the pure heatCardModel
// module so they can be unit-tested without a browser.
function renderHeatContextCard(result) {
  const index = validHeatIndex(state.hoveredHeatPartIndex) ? state.hoveredHeatPartIndex : null;
  if (!dom.heatContextCard || state.blueprintView !== "heat" || !validHeatIndex(index) || !result) { clearHeatContextCard(); return; }
  const part = state.design[index], prediction = result.predictions.get(part);
  if (!prediction) { clearHeatContextCard(); return; }
  const model = buildHeatCardModel({ design: state.design, index, prediction, result, partStats: PART_STATS });
  if (!model) { clearHeatContextCard(); return; }
  dom.heatContextCard.hidden = false;
  dom.heatContextCard.className = `heat-context-card heat-card-${model.stateClass}`;
  dom.heatContextCard.innerHTML = heatCardMarkup(model);
  positionHeatContextCard(index);
}

function positionHeatContextCard(index) {
  const card = dom.heatContextCard, stage = dom.gridStage || dom.grid;
  const cells = [...dom.grid.querySelectorAll(`.build-cell[data-part-index="${index}"]`)];
  if (!card || !stage || !cells.length || typeof stage.getBoundingClientRect !== "function") return;
  const sr = stage.getBoundingClientRect();
  const gridRect = dom.grid.getBoundingClientRect();
  const rects = cells.map(cell => cell.getBoundingClientRect());
  const cr = {
    left: Math.min(...rects.map(rect => rect.left)),
    right: Math.max(...rects.map(rect => rect.right)),
    top: Math.min(...rects.map(rect => rect.top)),
    bottom: Math.max(...rects.map(rect => rect.bottom))
  };
  const cardWidth = Math.min(260, Math.max(210, card.offsetWidth || 230));
  const cardHeight = Math.max(110, card.offsetHeight || 130);
  const cellSize = gridRect.width / GRID_SIZE;
  const clearance = cellSize + 14;
  const boundary = 8;
  const component = { left: cr.left - sr.left, right: cr.right - sr.left, top: cr.top - sr.top, bottom: cr.bottom - sr.top };
  const keepClear = { left: component.left - cellSize, right: component.right + cellSize, top: component.top - cellSize, bottom: component.bottom + cellSize };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const overlapArea = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const centredY = component.top + ((component.bottom - component.top) - cardHeight) / 2;
  const centredX = component.left + ((component.right - component.left) - cardWidth) / 2;
  const rawCandidates = [
    { side: "right", x: component.right + clearance, y: centredY },
    { side: "left", x: component.left - cardWidth - clearance, y: centredY },
    { side: "below", x: centredX, y: component.bottom + clearance },
    { side: "above", x: centredX, y: component.top - cardHeight - clearance }
  ];
  const candidates = rawCandidates.map((candidate, order) => {
    const x = clamp(candidate.x, boundary, sr.width - cardWidth - boundary);
    const y = clamp(candidate.y, boundary, sr.height - cardHeight - boundary);
    const rect = { left: x, right: x + cardWidth, top: y, bottom: y + cardHeight };
    const fits = candidate.x >= boundary && candidate.x + cardWidth <= sr.width - boundary && candidate.y >= boundary && candidate.y + cardHeight <= sr.height - boundary;
    return { ...candidate, order, x, y, fits, keepOverlap: overlapArea(rect, keepClear), componentOverlap: overlapArea(rect, component) };
  });
  const best = candidates
    .filter(candidate => candidate.fits && candidate.keepOverlap === 0 && candidate.componentOverlap === 0)[0]
    || [...candidates].sort((a, b) => (a.keepOverlap + a.componentOverlap * 3) - (b.keepOverlap + b.componentOverlap * 3) || Number(b.fits) - Number(a.fits) || a.order - b.order)[0];
  const x = best.x;
  const y = best.y;
  card.style.left = `${x}px`; card.style.top = `${y}px`; card.style.maxWidth = `${cardWidth}px`;
}

function thermalHoverText(prediction) {
  if (!prediction) return "";
  const labels = globalThis.HeatRules.STATE_LABELS;
  const overheat = prediction.timeToOverheat === null ? "Time until overheat: never" : `Time until overheat: ${prediction.timeToOverheat.toFixed(1)}s`;
  const meltdown = prediction.meltdownTime != null ? `\nREACTOR MELTDOWN predicted at ${prediction.meltdownTime.toFixed(1)}s : explodes, damaging nearby components` : "";
  return `\nPredicted heat: ${Math.max(0, Math.round(prediction.ratio * 100))}% (${prediction.heat.toFixed(1)} / ${prediction.capacity} H)\nThermal state: ${labels[prediction.state]}\nHeat generated: +${prediction.generation.toFixed(1)} H/s\nDirect heat received: +${prediction.received.toFixed(1)} H/s\nDirect heat transferred out: -${prediction.transferredOut.toFixed(1)} H/s\nHeat removed: -${prediction.cooling.toFixed(1)} H/s\n${overheat}${meltdown}`;
}

export function renderFullLoadThermalPanel(fullLoadResult) {
  const panel = dom.fullLoadThermalPanel;
  if (!panel) return;
  panel.hidden = !fullLoadResult;
  if (!fullLoadResult) return;
  const analysis = fullLoadResult.analysis;
  const tone = analysis.balance.toLowerCase();
  const statusText = analysis.meltdownCount > 0 ? "Reactor meltdown predicted"
    : analysis.balance === "Stable" ? "Thermally stable" : analysis.balance === "Marginal" ? "Thermally marginal" : "Thermally unsustainable";
  const row = (label, value) => `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
  const actionRows = (analysis.actionItems || []).map(item => `<li>${escapeHtml(item)}</li>`).join("");
  const seconds = value => value === null ? "Never" : `${value.toFixed(1)} s`;
  const equilibrium = analysis.equilibriumTime === null ? "No equilibrium" : `${analysis.equilibriumTime.toFixed(1)} s`;
  const spareCooling = analysis.reserve >= 0;
  const totalCapacity = (fullLoadResult.powerThermal?.components || []).reduce((sum, component) => sum + (Number(component.finalHeatCapacity) || 0), 0);
  const hottestIndex = analysis.firstOverheatIndex >= 0 ? analysis.firstOverheatIndex : state.design.reduce((best, part, index) => {
    const prediction = fullLoadResult.predictions?.get(part);
    const bestPrediction = fullLoadResult.predictions?.get(state.design[best]);
    return (prediction?.ratio || 0) > (bestPrediction?.ratio || 0) ? index : best;
  }, 0);
  // Expected peak Heat state derived from the shared authoritative thresholds,
  // so the label matches the runtime Warm/Hot/Critical/Overheated bands. This is
  // a simulated peak, not current combat Heat : the wording says so explicitly.
  const HeatRules = globalThis.HeatRules;
  const peakPercent = Math.round(analysis.peakPredictedHeat * 100);
  const peakState = HeatRules.STATE_LABELS[HeatRules.stateFor(analysis.peakPredictedHeat, HeatRules.STATE.NORMAL)] || "Cool";
  const overheatForecast = analysis.firstOverheatTime === null
    ? null
    : `Predicted to overheat after ${analysis.firstOverheatTime.toFixed(0)} seconds`;
  panel.innerHTML = `
    <h3>Heat analysis</h3>
    <p>${escapeHtml(THERMAL_SCENARIO_NAMES[analysis.mode] || analysis.mode)} : ${escapeHtml(THERMAL_SCENARIO_EXPLANATIONS[analysis.mode] || "")}</p>
    <div class="thermal-analysis-status ${tone}">${escapeHtml(statusText)}</div>
    <div class="thermal-key-stats">
      <div><span>${spareCooling ? "Removal reserve" : "Net heat"}</span><strong class="${spareCooling ? "thermal-good" : "thermal-bad"}">${spareCooling ? `${analysis.reserve.toFixed(1)} H/s` : `+${analysis.net.toFixed(1)} H/s`}</strong></div>
      <div><span>Peak predicted Heat (simulated)</span><strong>${peakPercent}%</strong></div>
      <div><span>Expected state</span><strong>${escapeHtml(peakState)}</strong></div>
      <div><span>First overheat</span><strong class="${analysis.firstOverheatTime === null ? "thermal-good" : "thermal-bad"}">${seconds(analysis.firstOverheatTime)}</strong></div>
      <div><span>Reactor meltdown</span><strong class="${analysis.firstMeltdownTime === null ? "thermal-good" : "thermal-bad"}">${seconds(analysis.firstMeltdownTime)}</strong></div>
    </div>
    ${overheatForecast ? `<p class="thermal-overheat-forecast">${escapeHtml(overheatForecast)}</p>` : ""}
    <details class="thermal-detailed-analysis"${state.thermalDetailsOpen ? " open" : ""}>
      <summary>Detailed analysis</summary>
      <div class="thermal-analysis-rows">
        ${row("Scenario", THERMAL_SCENARIO_NAMES[analysis.mode] || analysis.mode)}
        ${row("Final total Heat capacity", `${Math.round(totalCapacity)} H`)}
        ${row("Total Heat generation", `+${analysis.generation.toFixed(1)} H/s`)}
        ${row("Cooling", `-${analysis.cooling.toFixed(1)} H/s`)}
        ${row("Actual heat removed", `-${analysis.actualCooling.toFixed(1)} H/s`)}
        ${row("Net Heat rate", `${analysis.net >= 0 ? "+" : ""}${analysis.net.toFixed(1)} H/s`)}
        ${row("Thermal equilibrium", equilibrium)}
        ${row("Hottest component", describeThermalComponent(hottestIndex, state.design))}
        ${row("Peak predicted Heat (simulated)", `${peakPercent}%`)}
        ${row("Expected state", peakState)}
        ${row("First overheat", seconds(analysis.firstOverheatTime))}
        ${row("Reactor meltdown", seconds(analysis.firstMeltdownTime))}
        ${row("Removal reserve", `${analysis.reserve.toFixed(1)} H/s`)}
        ${row("Hottest network", analysis.hottestNetwork)}
        ${row("Weapon uptime", `${Math.round(analysis.weaponUptime * 100)}%`)}
        ${row("Engine efficiency", `${Math.round(analysis.engineEfficiency * 100)}%`)}
        ${row("Shield recharge uptime", `${Math.round(analysis.shieldUptime * 100)}%`)}
        ${row("Radiator utilisation", `${Math.round(analysis.radiatorUtilisation * 100)}%`)}
        ${row("Heat-sink saturation", analysis.heatSinkSaturationTime === null ? "Never" : `${analysis.heatSinkSaturationTime.toFixed(1)} s`)}
      </div>
      ${actionRows ? `<ul class="thermal-action-list">${actionRows}</ul>` : ""}
    </details>`;
  panel.querySelector(".thermal-detailed-analysis")?.addEventListener("toggle", event => {
    state.thermalDetailsOpen = event.target.open;
  });
}

function updateHeatInspectionOverlay(analysis, options = {}) {
  clearInvalidHeatIndexes();
  if (!options.preserveOverlay) {
    clearHeatFlowOverlay();
    clearExteriorCoolingIndicators();
  }
  for (const cell of dom.grid.querySelectorAll(".build-cell")) {
    cell.classList.remove("heat-related", "heat-unrelated", "coolant-network-pipe", "coolant-network-endpoint");
  }
  dom.grid.classList.toggle("heat-inspecting", state.blueprintView === "heat" && validHeatIndex(state.hoveredHeatPartIndex));
  if (state.blueprintView !== "heat") { clearExteriorCoolingIndicators(); return; }
  const focus = validHeatIndex(state.hoveredHeatPartIndex) ? state.hoveredHeatPartIndex : null;
  const connected = new Set(validHeatIndex(focus) ? [focus] : []);
  for (const flow of analysis.flows || []) {
    if (flow.amount < HEAT_FLOW_THRESHOLD) continue;
    if (flow.from === focus || flow.to === focus) { connected.add(flow.from); connected.add(flow.to); }
  }
  // Hovering anything on a coolant network lights up the whole network: the
  // transport tiles and the endpoints attached to them get distinct classes, so
  // "what is plumbed to what" is readable without a dedicated plumbing editor.
  const coolantNetwork = focus == null ? null : coolantNetworkAt(state.design, focus, PART_STATS);
  if (coolantNetwork) {
    for (const index of coolantNetwork.pipes) connected.add(index);
    for (const index of coolantNetwork.attachments) connected.add(index);
  }
  for (const cell of dom.grid.querySelectorAll(".build-cell.occupied")) {
    const part = findPartAt(Number(cell.dataset.x), Number(cell.dataset.y));
    const index = part ? state.design.indexOf(part) : -1;
    cell.classList.toggle("heat-related", connected.has(index));
    cell.classList.toggle("heat-unrelated", connected.size > 0 && !connected.has(index));
    cell.classList.toggle("coolant-network-pipe", Boolean(coolantNetwork?.pipes.has(index)));
    cell.classList.toggle("coolant-network-endpoint", Boolean(coolantNetwork?.attachments.has(index)));
  }
  renderHeatContextCard(analysis);
  if (!options.preserveOverlay) {
    renderHeatFlows(analysis);
    renderExteriorCoolingIndicators(analysis);
  }
}

function renderExteriorCoolingIndicators(analysis) {
  clearExteriorCoolingIndicators();
  const focus = validHeatIndex(state.hoveredHeatPartIndex) ? state.hoveredHeatPartIndex : null;
  if (state.blueprintView !== "heat" || focus == null || !analysis) return;
  const part = state.design[focus];
  const prediction = part ? analysis.predictions?.get(part) : null;
  const directions = prediction?.exteriorDirections || [];
  if (!part || !["radiator", "heatVent"].includes(part.type) || !directions.length) return;
  const cells = [...dom.grid.querySelectorAll(`.build-cell[data-part-index="${focus}"]`)];
  if (!cells.length) return;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${GRID_SIZE} ${GRID_SIZE}`);
  svg.classList.add("exterior-cooling-overlay");
  const directionSet = new Set(directions);
  const titleText = part.type === "radiator" ? "Exposed radiator edge" : "Exposed Heat Vent edge";
  const byDirection = {
    left: { dx: -1, dy: 0, char: "←", x: cell => cell.x - 0.12, y: cell => cell.y + 0.5 },
    right: { dx: 1, dy: 0, char: "→", x: cell => cell.x + 1.12, y: cell => cell.y + 0.5 },
    top: { dx: 0, dy: -1, char: "↑", x: cell => cell.x + 0.5, y: cell => cell.y - 0.12 },
    bottom: { dx: 0, dy: 1, char: "↓", x: cell => cell.x + 0.5, y: cell => cell.y + 1.12 }
  };
  for (const cellEl of cells) {
    const cell = { x: Number(cellEl.dataset.x), y: Number(cellEl.dataset.y) };
    for (const direction of directionSet) {
      const meta = byDirection[direction];
      if (!meta || findPartAt(cell.x + meta.dx, cell.y + meta.dy)) continue;
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.classList.add("exterior-cooling-indicator", `exterior-cooling-${direction}`);
      text.setAttribute("x", String(meta.x(cell)));
      text.setAttribute("y", String(meta.y(cell)));
      text.setAttribute("aria-label", titleText);
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = titleText;
      text.appendChild(title);
      text.appendChild(document.createTextNode(meta.char));
      svg.appendChild(text);
    }
  }
  if (svg.children.length) (dom.heatFlowOverlayHost || dom.grid).appendChild(svg);
}

function renderHeatFlows(analysis) {
  migrateHeatFlowViewState();
  const focus = validHeatIndex(state.hoveredHeatPartIndex)
    ? state.hoveredHeatPartIndex
    : null;
  // Heat flows are always shown; hovering a component just adds its H/s labels.
  const showAll = true;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 15 15");
  svg.classList.add("heat-flow-overlay");
  svg.innerHTML = `<defs><marker id="heat-flow-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="3.4" markerHeight="3.4" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#ff9a3d"/></marker><marker id="heat-flow-arrow-incoming" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="3.4" markerHeight="3.4" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#38d9ff"/></marker><marker id="heat-flow-arrow-outgoing" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="3.4" markerHeight="3.4" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#ff9a3d"/></marker></defs>`;
  const owner = new Map();
  const occupiedByIndex = state.design.map((part, i) => {
    const stat = PART_STATS[part.type] || PART_STATS.frame;
    const occupied = getOccupiedCells(part.x, part.y, stat.footprint || { width:1, height:1 }, part.rotation || 0, part.flipped === true);
    for (const cell of occupied) owner.set(`${cell.x},${cell.y}`, i);
    return occupied;
  });
  const renderedEdges = new Set();
  const labeledEdges = new Set();
  const labelRequests = [];
  for (const flow of analysis.flows || []) {
    if (flow.amount < HEAT_FLOW_THRESHOLD) continue;
    const focusedFlow = focus != null && (flow.from === focus || flow.to === focus);
    if (!showAll && !focusedFlow) continue;
    const from = state.design[flow.from];
    const to = state.design[flow.to];
    if (!from || !to) continue;
    const isHeatPipeFlow = from.type === "heatPipe" || to.type === "heatPipe";
    const isFrameFlow = /frame/i.test(from.type) || /frame/i.test(to.type) || isHeatPipeFlow;
    let drewFlow = false;
    for (const cell of occupiedByIndex[flow.from] || []) for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      if (owner.get(`${cell.x + dx},${cell.y + dy}`) !== flow.to) continue;
      const edgeKey = `${flow.from}>${flow.to}:${cell.x},${cell.y}:${dx},${dy}`;
      if (renderedEdges.has(edgeKey)) continue;
      renderedEdges.add(edgeKey);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(cell.x + 0.5 - dx * 0.12));
      line.setAttribute("y1", String(cell.y + 0.5 - dy * 0.12));
      line.setAttribute("x2", String(cell.x + 0.5 + dx * 0.72));
      line.setAttribute("y2", String(cell.y + 0.5 + dy * 0.72));
      const directionalClass = focusedFlow ? (flow.to === focus ? "heat-flow-incoming" : "heat-flow-outgoing") : "";
      line.setAttribute("marker-end", directionalClass === "heat-flow-incoming" ? "url(#heat-flow-arrow-incoming)" : directionalClass === "heat-flow-outgoing" ? "url(#heat-flow-arrow-outgoing)" : "url(#heat-flow-arrow)");
      const strength = Math.min(1, flow.amount / 5);
      line.classList.add(isFrameFlow ? "frame-heat-flow" : "component-heat-flow", isHeatPipeFlow ? "heat-pipe-heat-flow" : "frame-route-heat-flow", strength >= 0.9 ? "critical-heat-flow" : strength >= 0.58 ? "high-heat-flow" : strength >= 0.28 ? "moderate-heat-flow" : "low-heat-flow");
      if (directionalClass) line.classList.add(directionalClass);
      if (showAll && focus != null && !focusedFlow) line.classList.add("heat-flow-muted");
      if (focusedFlow) line.classList.add("heat-flow-focus");
      let opacity = 0.44 + strength * 0.46;
      let width = 0.032 + strength * 0.065;
      if (focusedFlow) {
        opacity = Math.min(1, opacity + 0.22);
        width = Math.min(0.12, width + 0.018);
      } else if (showAll && focus != null) {
        opacity *= 0.55;
      }
      line.style.opacity = String(opacity);
      line.style.strokeWidth = String(width);
      svg.appendChild(line);
      const labelEdgeKey = `${flow.from}>${flow.to}`;
      const shouldLabel = focusedFlow && !labeledEdges.has(labelEdgeKey);
      if (shouldLabel) {
        labeledEdges.add(labelEdgeKey);
        labelRequests.push({
          flow,
          cell,
          dx,
          dy,
          edgeKey,
          text: `${flow.amount.toFixed(1)} H/s`,
          incoming: flow.to === focus
        });
      }
      drewFlow = true;
    }
    if (drewFlow) continue;
  }
  renderHeatFlowLabels(svg, labelRequests, focus, occupiedByIndex[focus] || []);
  if (svg.children.length > 1) {
    (dom.heatFlowOverlayHost || dom.grid).appendChild(svg);
    // Hovering a different component tears this overlay down and rebuilds it, so
    // the marching frame-route dashes would restart on every hover step.
    phaseLockOverlayAnimations(dom.heatFlowOverlayHost || dom.grid);
  }
}

const MAX_LABEL_ALONG_DISPLACEMENT = 0.20;
const MAX_LABEL_PERPENDICULAR_DISPLACEMENT = 0.42;
const LABEL_CLEARANCES = [0.20, 0.29, 0.38];
const LABEL_ALONG_ADJUSTMENTS = [0, -0.10, 0.10];
const LABEL_BOUNDARY_PADDING = 0.12;
const MIN_ARROWHEAD_LABEL_DISTANCE = 0.20;
const LABEL_TEXT_PADDING_X = 0.055;
const LABEL_TEXT_PADDING_Y = 0.026;
const LABEL_MAX_WIDTH = 0.86;

function canonicalEdgeKey(a, b) {
  const first = a.x < b.x || (a.x === b.x && a.y <= b.y) ? a : b;
  const second = first === a ? b : a;
  return `${first.x},${first.y}:${second.x},${second.y}`;
}

function canonicalEdgeNormal(a, b) {
  const first = a.x < b.x || (a.x === b.x && a.y <= b.y) ? a : b;
  const second = first === a ? b : a;
  const edgeDx = second.x - first.x;
  const edgeDy = second.y - first.y;
  return { x: -edgeDy, y: edgeDx };
}

function clampLabelCenter(value, halfSize) {
  return Math.min(GRID_SIZE - LABEL_BOUNDARY_PADDING - halfSize, Math.max(LABEL_BOUNDARY_PADDING + halfSize, value));
}

function labelBox(cx, cy, width, height) {
  return { left: cx - width / 2, right: cx + width / 2, top: cy - height / 2, bottom: cy + height / 2, width, height };
}

function overlapArea(a, b) {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return width * height;
}

function renderHeatFlowLabels(svg, labelRequests, focus, focusCells) {
  if (!labelRequests.length || focus == null) return;
  labelRequests.sort((a, b) =>
    b.flow.amount - a.flow.amount ||
    Number(b.incoming) - Number(a.incoming) ||
    a.edgeKey.localeCompare(b.edgeKey) ||
    a.flow.from - b.flow.from ||
    a.flow.to - b.flow.to
  );
  const placedLabelBoxes = [];
  const focusBox = focusCells.length ? {
    left: Math.min(...focusCells.map(cell => cell.x)) + 0.18,
    right: Math.max(...focusCells.map(cell => cell.x)) + 0.82,
    top: Math.min(...focusCells.map(cell => cell.y)) + 0.18,
    bottom: Math.max(...focusCells.map(cell => cell.y)) + 0.82
  } : null;

  function measureLabel(text) {
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.classList.add("heat-flow-label-group");
    group.style.opacity = "0";
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.classList.add("heat-flow-label", "focused-flow-label");
    label.setAttribute("x", "0");
    label.setAttribute("y", "0");
    label.textContent = text;
    group.appendChild(label);
    svg.appendChild(group);
    const fallbackWidth = Math.min(LABEL_MAX_WIDTH, Math.max(0.56, text.length * 0.092 + LABEL_TEXT_PADDING_X * 2));
    const fallbackHeight = 0.24;
    let textBox = { x: -fallbackWidth / 2 + LABEL_TEXT_PADDING_X, y: -fallbackHeight / 2 + LABEL_TEXT_PADDING_Y, width: fallbackWidth - LABEL_TEXT_PADDING_X * 2, height: fallbackHeight - LABEL_TEXT_PADDING_Y * 2 };
    try {
      const measured = label.getBBox?.();
      if (measured && measured.width > 0 && measured.height > 0) {
        textBox = { x: measured.x, y: measured.y, width: measured.width, height: measured.height };
      }
    } catch (error) {
      // Browsers without SVG text measurement use the deterministic estimate above.
    }
    group.remove();
    const backgroundBox = {
      x: textBox.x - LABEL_TEXT_PADDING_X,
      y: textBox.y - LABEL_TEXT_PADDING_Y,
      width: Math.min(LABEL_MAX_WIDTH, textBox.width + LABEL_TEXT_PADDING_X * 2),
      height: textBox.height + LABEL_TEXT_PADDING_Y * 2
    };
    return { backgroundBox, width: backgroundBox.width, height: backgroundBox.height };
  }

  for (const request of labelRequests) {
    const { cell, dx, dy, text, incoming, flow } = request;
    const x1 = cell.x + 0.5 - dx * 0.12;
    const y1 = cell.y + 0.5 - dy * 0.12;
    const x2 = cell.x + 0.5 + dx * 0.72;
    const y2 = cell.y + 0.5 + dy * 0.72;
    const midpointX = (x1 + x2) / 2;
    const midpointY = (y1 + y2) / 2;
    const directionOffset = incoming ? -0.06 : 0.06;
    const baseX = midpointX + dx * directionOffset;
    const baseY = midpointY + dy * directionOffset;
    const fromCell = { x: cell.x, y: cell.y };
    const toCell = { x: cell.x + dx, y: cell.y + dy };
    const edgeKey = canonicalEdgeKey(fromCell, toCell);
    const canonicalNormal = canonicalEdgeNormal(fromCell, toCell);
    const preferredSide = incoming ? 1 : -1;
    const { backgroundBox, width, height } = measureLabel(text);
    let best = null;
    const orderedCandidates = [
      { side: preferredSide, distance: LABEL_CLEARANCES[0], alongAdjust: 0 },
      { side: preferredSide, distance: LABEL_CLEARANCES[1], alongAdjust: 0 },
      { side: -preferredSide, distance: LABEL_CLEARANCES[0], alongAdjust: 0 }
    ];
    for (const side of [preferredSide, -preferredSide]) {
      for (const distance of LABEL_CLEARANCES) {
        for (const alongAdjust of LABEL_ALONG_ADJUSTMENTS) {
          if (!orderedCandidates.some(candidate => candidate.side === side && candidate.distance === distance && candidate.alongAdjust === alongAdjust)) {
            orderedCandidates.push({ side, distance, alongAdjust });
          }
        }
      }
    }

    for (const { side, distance, alongAdjust } of orderedCandidates) {
      const rawX = baseX + canonicalNormal.x * distance * side + dx * alongAdjust;
      const rawY = baseY + canonicalNormal.y * distance * side + dy * alongAdjust;
      const cx = clampLabelCenter(rawX, width / 2);
      const cy = clampLabelCenter(rawY, height / 2);
      const alongDisplacement = Math.abs((cx - midpointX) * dx + (cy - midpointY) * dy);
      const perpendicularDisplacement = Math.abs((cx - midpointX) * canonicalNormal.x + (cy - midpointY) * canonicalNormal.y);
      if (alongDisplacement > MAX_LABEL_ALONG_DISPLACEMENT || perpendicularDisplacement > MAX_LABEL_PERPENDICULAR_DISPLACEMENT) continue;
      const box = labelBox(cx, cy, width, height);
      const arrowheadDistance = Math.hypot(cx - x2, cy - y2);
      if (arrowheadDistance < MIN_ARROWHEAD_LABEL_DISTANCE) continue;
      const midpointDistance = Math.hypot(cx - midpointX, cy - midpointY);
      const placedOverlap = placedLabelBoxes.reduce((total, placed) => total + overlapArea(box, placed.box), 0);
      const focusOverlap = focusBox ? overlapArea(box, focusBox) : 0;
      const outsideDistance = Math.abs(cx - rawX) + Math.abs(cy - rawY);
      const score =
        placedOverlap * 10000 +
        midpointDistance * 500 +
        focusOverlap * 900 +
        outsideDistance * 120 +
        (side === preferredSide ? 0 : 40) +
        Math.abs(alongAdjust) * 8 +
        distance * 0.1;
      if (!best || score < best.score) best = { cx, cy, box, score, edgeKey, side, backgroundBox };
    }

    if (!best) continue;
    placedLabelBoxes.push(best);
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.classList.add("heat-flow-label-group", incoming ? "incoming-flow-label-group" : "outgoing-flow-label-group");
    group.setAttribute("data-physical-edge", best.edgeKey);
    group.setAttribute("data-label-side", String(best.side));
    group.setAttribute("data-flow-from", String(flow.from));
    group.setAttribute("data-flow-to", String(flow.to));
    group.setAttribute("data-flow-amount", String(flow.amount));
    group.setAttribute("data-midpoint-x", String(midpointX));
    group.setAttribute("data-midpoint-y", String(midpointY));
    group.setAttribute("data-label-x", String(best.cx));
    group.setAttribute("data-label-y", String(best.cy));
    group.setAttribute("transform", `translate(${best.cx} ${best.cy})`);

    const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    background.classList.add("heat-flow-label-background");
    background.setAttribute("x", String(best.backgroundBox.x));
    background.setAttribute("y", String(best.backgroundBox.y));
    background.setAttribute("width", String(best.backgroundBox.width));
    background.setAttribute("height", String(best.backgroundBox.height));
    background.setAttribute("rx", ".045");
    background.setAttribute("ry", ".045");
    group.appendChild(background);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.classList.add("heat-flow-label", "focused-flow-label", incoming ? "incoming-flow-label" : "outgoing-flow-label");
    label.setAttribute("x", "0");
    label.setAttribute("y", "0");
    label.textContent = text;
    group.appendChild(label);
    svg.appendChild(group);
  }
}

export function heatInteractionDiagnostics() {
  const activeScenarioButton = dom.thermalLoadModes?.querySelector("[data-thermal-load].active")?.dataset.thermalLoad || null;
  return {
    blueprintView: state.blueprintView,
    thermalLoadMode: state.thermalLoadMode || DEFAULT_THERMAL_LOAD_MODE,
    activeScenarioButton,
    percentageBadgeCount: dom.grid.querySelectorAll(".component-heat-value").length,
    occupiedCellCount: dom.grid.querySelectorAll(".build-cell.occupied").length,
    previewCount: dom.grid.querySelectorAll(".build-preview, .engine-exhaust-preview, .engine-thrust-arrow, .maneuver-preview-plume, .maneuver-preview-weak").length,
    heatFlowOverlayCount: (dom.heatFlowOverlayHost || dom.grid).querySelectorAll(".heat-flow-overlay").length,
    heatCacheSignature: cachedHeatAnalysis?.signature || null,
    heatCachePartReferencesMatch: cachedPartReferencesMatch(state.design),
    heatAnalysisMatchesCurrentDesign: heatAnalysisMatchesCurrentDesign(cachedHeatAnalysis?.result),
    heatUiErrorVisible: Boolean(dom.blueprintThermalHud?.querySelector(".heat-ui-error-message") || dom.grid?.classList.contains("heat-ui-error"))
  };
}
