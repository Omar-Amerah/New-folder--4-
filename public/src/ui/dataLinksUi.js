// Data Links view: renders explicit direct Data-support links as dashed lines.
// This is not wiring; it uses the shared wiring overlay host to keep the grid
// uncluttered and to reuse the established designer overlay pattern.
import { state } from "../state.js";
import { dom } from "./dom.js";
import { PART_DEFS, PART_STATS, partIconMarkup } from "../design/parts.js";
import { getCachedDesignDataSupport, getDesignEffectiveWeaponProfile, getDesignSourceAllocation, getDesignWeaponSupport } from "../design/dataSupportAnalysis.js";
import { formatDataSupportValue, formatDataSupportEquation } from "../design/dataSupportPresentation.js";
import { escapeHtml } from "../shared/formatting.js";
import { persistDesign } from "../design/blueprintStorage.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const GRID_SIZE = 15;

const wRules = () => globalThis.WiringRules;
const rules = () => globalThis.DataSupportRules;

globalThis.DataLinksUi = { renderDataLinksOverlay, refreshDataLinksPresentation };

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}
function componentCenter(index) {
  const module = state.design?.[index];
  if (!module) return null;
  try {
    const c = wRules().componentCenter(module, PART_STATS);
    return { x: Number(c?.x), y: Number(c?.y) };
  } catch { return null; }
}

export function renderDataLinksOverlay() {
  const host = dom.wiringOverlayHost;
  if (!host) return;
  if (state.blueprintView !== "dataLinks") { host.replaceChildren(); return; }
  host.replaceChildren();
  host.classList.add("wiring-overlay-active");

  const svg = svgEl("svg", {
    viewBox: `0 0 ${GRID_SIZE} ${GRID_SIZE}`,
    class: "data-links-overlay",
    preserveAspectRatio: "none",
    "aria-hidden": "true"
  });
  svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;";

  const analysis = currentDataSupportAnalysis();

  const selected = state.selectedCell ? state.design.indexOf(state.design.find((m) => m.x === state.selectedCell.x && m.y === state.selectedCell.y)) : null;
  const hoverIndex = state.hoveredCell ? state.design.indexOf(state.design.find((m) => m.x === state.hoveredCell.x && m.y === state.hoveredCell.y)) : null;
  const focused = selected ?? hoverIndex ?? null;

  const linkPaths = [];
  for (const link of (analysis?.links || [])) {
    const from = componentCenter(link.sourceIndex);
    const to = componentCenter(link.targetIndex);
    if (!from || !to) continue;
    const key = `${link.sourceIndex}:${link.targetIndex}`;
    const isRelevant = focused === null || link.sourceIndex === focused || link.targetIndex === focused;
    const isSelected = dataLinksUiState.selectedLinkKey === key;
    const dim = focused !== null && !isRelevant;
    const line = svgEl("line", {
      x1: from.x, y1: from.y, x2: to.x, y2: to.y,
      stroke: isSelected ? "#f472b6" : "#22d3ee",
      "stroke-width": isSelected ? "0.16" : "0.1",
      "stroke-dasharray": "0.25 0.15",
      opacity: dim ? "0.25" : (isSelected ? "1" : "0.95"),
      "data-link-key": key,
      "pointer-events": "all",
      style: "cursor:pointer"
    });
    linkPaths.push(line);
  }

  // Draw source output and weapon target ports for visible support types.
  for (let i = 0; i < state.design.length; i += 1) {
    const module = state.design[i];
    const center = componentCenter(i);
    if (!center) continue;
    if (rules().isDataSupportSource(module?.type)) {
      const isPending = dataLinksUiState.drag?.sourceIndex === i;
      const port = svgEl("circle", { cx: center.x, cy: center.y, r: isPending ? "0.22" : "0.18", fill: "#22d3ee", opacity: focused === i || focused === null ? (isPending ? "1" : "0.9") : "0.25", "data-source-index": String(i), "pointer-events": "all", style: isPending ? "cursor:grabbing" : "cursor:grab" });
      svg.appendChild(port);
    } else if (rules().isWeapon(module, PART_STATS)) {
      const isLinked = (analysis?.links || []).some((l) => l.targetIndex === i);
      const isPending = dataLinksUiState.drag?.sourceIndex != null && isDataLinksWeaponTargetValid(dataLinksUiState.drag.sourceIndex, i);
      const port = svgEl("circle", { cx: center.x, cy: center.y, r: isPending ? "0.18" : (isLinked ? "0.14" : "0.1"), fill: isPending ? "#86efac" : "none", stroke: "#22d3ee", "stroke-width": "0.08", opacity: focused === i || focused === null ? (isPending ? "1" : "0.9") : "0.25", "data-target-index": String(i), "pointer-events": "all", style: isPending ? "cursor:copy" : "cursor:pointer" });
      svg.appendChild(port);
    }
  }

  for (const line of linkPaths) svg.appendChild(line);

  if (dataLinksUiState.drag?.pointer) {
    const from = componentCenter(dataLinksUiState.drag.sourceIndex);
    const to = dataLinksUiState.drag.pointer;
    if (from && to) svg.appendChild(svgEl("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, stroke: "#22d3ee", "stroke-width": "0.08", "stroke-dasharray": "0.2 0.1", opacity: "0.6", "pointer-events": "none" }));
  }

  host.appendChild(svg);
}

// Each host keeps its own last-rendered markup so the Data Links view and the
// Data analysis tab can share one builder without starving each other's cache.
const lastPanelMarkup = new WeakMap();
function setPanelMarkup(panel, markup) {
  if (lastPanelMarkup.get(panel) === markup) return;
  lastPanelMarkup.set(panel, markup);
  panel.innerHTML = markup;
}

function moduleLabel(index) {
  const module = state.design?.[index];
  if (!module) return "Unknown";
  return escapeHtml(PART_DEFS[module.type]?.name || module.type);
}

function partName(type) {
  return PART_DEFS[type]?.name || type;
}

const WARNING_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2L1 14h14L8 2z"/><line x1="8" y1="6" x2="8" y2="9"/><circle cx="8" cy="11.5" r="0.5" fill="currentColor"/></svg>`;

// One cached prediction backs every Data presentation, so the grid overlay and
// the analysis tab can never report different numbers for the same blueprint.
export function currentDataSupportAnalysis(options = {}) {
  return getCachedDesignDataSupport(state.design, state.wiring, PART_STATS, {
    thermalLoadMode: state.thermalLoadMode || "full",
    dataLinks: state.dataLinks,
    ...options
  });
}

function sourceRowStatus(source) {
  if (source.status === "active" || source.effectiveBudget > 0) {
    return { label: `ACTIVE (${formatDataSupportValue({ bonusField: source.bonusField, amount: source.effectiveBudget })})`, tone: "badge-active" };
  }
  if (source.powerMultiplier <= 0) return { label: "UNPOWERED", tone: "badge-offline" };
  if (source.thermalMultiplier < 1) return { label: "THERMALLY REDUCED", tone: "badge-reduced" };
  if (source.recipientCount === 0) return { label: "NO RECIPIENTS", tone: "badge-neutral" };
  return { label: String(source.status).toUpperCase(), tone: "badge-neutral" };
}

function weaponRowStatus(weapon) {
  if (weapon.status !== "supported") return { label: "NO SUPPORT", tone: "badge-neutral" };
  const parts = [];
  if (weapon.rangeBonus > 0) parts.push(formatDataSupportValue({ bonusField: "rangeBonus", amount: weapon.rangeBonus }));
  if (weapon.accuracyBonus > 0) parts.push(formatDataSupportValue({ bonusField: "accuracyBonus", amount: weapon.accuracyBonus }));
  if (weapon.fireRateBonus > 0) parts.push(formatDataSupportValue({ bonusField: "fireRateBonus", amount: weapon.fireRateBonus }));
  return { label: parts.length ? `SUPPORTED (${parts.join(", ")})` : "SUPPORTED", tone: "badge-active" };
}

// Keep the arithmetic on the row: a fixed budget divided by the linked weapon
// count is the whole reason a design gains or loses per-weapon support.
function sourceRowDetail(source) {
  if (!source.recipientCount) return "No weapons linked";
  const total = formatDataSupportValue({ bonusField: source.bonusField, amount: source.effectiveBudget });
  const each = formatDataSupportValue({ bonusField: source.bonusField, amount: source.bonusPerWeapon });
  return `${total} ${source.effect} shared across ${source.recipientCount} linked weapon${source.recipientCount === 1 ? "" : "s"} = ${each} each`;
}

function weaponRowDetail(weapon) {
  const sourceIndices = weapon.sourceIndices || [];
  if (!sourceIndices.length) return "No Data source linked";
  return `Fed by ${sourceIndices.map((index) => partName(state.design?.[index]?.type)).join(", ")}`;
}

function componentRowHtml(kind, index, type, { label, tone }, detail) {
  const module = state.design?.[index];
  const coords = module ? `(${module.x},${module.y})` : "";
  const icon = partIconMarkup ? partIconMarkup(type, "data-component-icon", module?.rotation || 0) : "";
  return `<div class="wiring-summary-line wiring-component-row data-component-row data-component-row-stacked data-row-${kind} data-row-${tone}" data-data-inspector="${kind}">
    <div class="data-row-head">
      <div class="data-row-main">
        ${icon}
        <span class="data-component-name">${escapeHtml(partName(type))}</span>
        <span class="data-component-coords">${escapeHtml(coords)}</span>
      </div>
      <div class="data-row-actions">
        <span class="data-status-badge ${tone}">${escapeHtml(label)}</span>
      </div>
    </div>
    <span class="data-component-detail">${escapeHtml(detail)}</span>
  </div>`;
}

// Shared Data-support presentation. The Data Links view and the Blueprint's
// Data analysis tab render the same cards so one design reads identically in
// both places.
export function dataSupportPanelMarkup(analysis, { selectedLinkKey = null } = {}) {
  const sources = analysis?.sources || [];
  const weapons = analysis?.weapons || [];
  const activeSources = sources.filter((s) => s.status === "active" || s.effectiveBudget > 0);
  const supportedWeapons = weapons.filter((w) => w.status === "supported");

  let totalRange = 0, totalAccuracy = 0, totalFireRate = 0;
  activeSources.forEach((s) => {
    if (s.bonusField === "rangeBonus") totalRange += s.effectiveBudget;
    if (s.bonusField === "accuracyBonus") totalAccuracy += s.effectiveBudget;
    if (s.bonusField === "fireRateBonus") totalFireRate += s.effectiveBudget;
  });

  const unpoweredSources = sources.filter((s) => s.powerMultiplier <= 0);
  const reducedSources = sources.filter((s) => s.thermalMultiplier < 1 && s.powerMultiplier > 0);

  let statusText = "ACTIVE";
  let statusClass = "data-badge-active";
  if (sources.length === 0) {
    statusText = "OFFLINE · NO SOURCES";
    statusClass = "data-badge-offline";
  } else if (unpoweredSources.length > 0) {
    statusText = unpoweredSources.length === sources.length ? "OFFLINE · SOURCE UNPOWERED" : "PARTIALLY ACTIVE · SOURCE UNPOWERED";
    statusClass = unpoweredSources.length === sources.length ? "data-badge-offline" : "data-badge-partially-active";
  } else if (reducedSources.length > 0) {
    statusText = "PARTIALLY ACTIVE · SOURCE REDUCED";
    statusClass = "data-badge-partially-active";
  } else if (activeSources.length === 0) {
    statusText = "IDLE · NO LINKS";
    statusClass = "data-badge-partially-active";
  }

  const deliveredParts = [];
  if (totalRange > 0) deliveredParts.push(`${formatDataSupportValue({ bonusField: "rangeBonus", amount: totalRange })} Range`);
  if (totalAccuracy > 0) deliveredParts.push(`${formatDataSupportValue({ bonusField: "accuracyBonus", amount: totalAccuracy })} Accuracy`);
  if (totalFireRate > 0) deliveredParts.push(`${formatDataSupportValue({ bonusField: "fireRateBonus", amount: totalFireRate })} Fire Rate`);
  const deliveredSummaryText = deliveredParts.length ? deliveredParts.join(", ") : "None";

  const warningCallouts = [];
  sources.forEach((s) => {
    if (s.powerMultiplier <= 0) {
      warningCallouts.push({
        title: `${partName(s.sourceType)} is unpowered`,
        message: `Its ${formatDataSupportValue({ bonusField: s.bonusField, amount: s.nominalBudget })} ${s.effect} is not being distributed.`
      });
    } else if (s.thermalMultiplier < 1) {
      warningCallouts.push({
        title: `${partName(s.sourceType)} is thermally reduced`,
        message: "Predicted heat is limiting support distribution."
      });
    } else if (s.recipientCount === 0) {
      warningCallouts.push({
        title: `${partName(s.sourceType)} has no weapon recipients`,
        message: "No eligible weapons are linked to receive support."
      });
    }
  });
  if (sources.length === 0 && weapons.length > 0) {
    warningCallouts.push({
      title: "No Data support source fitted",
      message: `There ${weapons.length === 1 ? "is" : "are"} ${weapons.length} weapon${weapons.length === 1 ? "" : "s"} but no active Data source.`
    });
  }

  let body = `<div id="data-support-live" aria-live="polite" class="sr-only">Data support prediction refreshed.</div>`;

  body += `<section class="wiring-summary-section data-inspection-card" data-data-inspector="overview">
    <div class="data-card-header">
      <span class="data-network-title">DATA SUPPORT</span>
      <span class="data-badge ${statusClass}">${escapeHtml(statusText)}</span>
    </div>
    <div class="data-summary-stats" data-data-inspector="status">
      <div class="data-stat-cell"><span class="data-stat-label">Sources</span><strong class="data-stat-value">${activeSources.length} / ${sources.length} active</strong></div>
      <div class="data-stat-cell"><span class="data-stat-label">Weapons</span><strong class="data-stat-value">${supportedWeapons.length} / ${weapons.length} supported</strong></div>
      <div class="data-stat-cell"><span class="data-stat-label">Delivered</span><strong class="data-stat-value ${deliveredSummaryText === "None" ? "data-stat-none" : "data-stat-active"}">${escapeHtml(deliveredSummaryText)}</strong></div>
    </div>
    <div class="data-infra-note">Each Data source divides one fixed support budget across its linked weapons, so linking more weapons gives every weapon a smaller share.</div>
  </section>`;

  body += `<div class="data-components-card" data-data-inspector="components-card">
    <h5 class="data-section-heading">NETWORK COMPONENTS</h5>
    <div class="data-component-list">`;
  if (!sources.length && !weapons.length) {
    body += `<div class="data-delivered-empty">Add a Data-support component and a weapon to predict Data support.</div>`;
  }
  sources.forEach((s) => { body += componentRowHtml("source", s.sourceIndex, s.sourceType, sourceRowStatus(s), sourceRowDetail(s)); });
  weapons.forEach((w) => { body += componentRowHtml("weapon", w.weaponIndex, w.weaponType, weaponRowStatus(w), weaponRowDetail(w)); });
  body += `  </div></div>`;

  body += `<div class="data-delivered-card" data-data-inspector="delivered-support">
    <h5 class="data-section-heading">DELIVERED SUPPORT</h5>`;
  if (!deliveredParts.length) {
    body += `<div class="data-delivered-empty">No Data bonuses are currently being delivered.</div>`;
  } else {
    body += `<div class="data-delivered-chips">`;
    if (totalRange > 0) body += `<span class="data-effect-chip">${formatDataSupportValue({ bonusField: "rangeBonus", amount: totalRange })} Range</span>`;
    if (totalAccuracy > 0) body += `<span class="data-effect-chip">${formatDataSupportValue({ bonusField: "accuracyBonus", amount: totalAccuracy })} Accuracy</span>`;
    if (totalFireRate > 0) body += `<span class="data-effect-chip">${formatDataSupportValue({ bonusField: "fireRateBonus", amount: totalFireRate })} Fire Rate</span>`;
    body += `</div>`;
  }
  body += `</div>`;

  if (warningCallouts.length > 0) {
    body += `<div class="data-warnings-container" data-data-inspector="warnings">`;
    warningCallouts.forEach((warn) => {
      body += `<div class="data-warning-callout">
        <div class="data-warning-title">${WARNING_ICON} ${escapeHtml(warn.title)}</div>
        <div class="data-warning-msg">${escapeHtml(warn.message)}</div>
      </div>`;
    });
    body += `</div>`;
  }

  body += `<details class="wiring-analysis-expander wiring-advanced-details" data-wiring-details="advanced">
    <summary aria-expanded="false" aria-controls="data-infra-content"><span>Infrastructure details</span></summary>
    <div id="data-infra-content" class="wiring-summary-subsection data-infra-details">
      <div class="data-infra-row"><span>Direct links</span><strong>${(analysis?.links || []).length}</strong></div>
      <div class="data-infra-row"><span>Wiring cost</span><strong>$0.00</strong></div>
      <div class="data-infra-row"><span>Heat-capacity displacement</span><strong>0</strong></div>
      <div class="data-infra-note">Direct Data Links do not use physical cable and have no capacity, flow or overload limits.</div>
    </div>
  </details>`;

  if (selectedLinkKey) {
    const [s, t] = selectedLinkKey.split(":").map(Number);
    body += `<section class="wiring-summary-section data-inspection-card" data-data-inspector="selected-link">
      <h5>Selected link</h5>
      <div class="wiring-summary-line">${moduleLabel(s)} → ${moduleLabel(t)}</div>
      <div class="wiring-summary-line wiring-muted-text">Press Delete or Backspace to remove this link.</div>
    </section>`;
  }

  return body;
}

// Blueprint inspector host for the Data analysis tab. `heat` is the designer's
// already-computed thermal prediction so the tab does not re-run it.
export function renderDataAnalysisPanel(host, { thermalAnalysis } = {}) {
  if (!host) return;
  let analysis;
  try {
    analysis = currentDataSupportAnalysis(thermalAnalysis ? { thermalAnalysis } : {});
  } catch (_) {
    setPanelMarkup(host, `<div role="status" class="wiring-summary-line">Data support analysis could not be produced.</div>`);
    return;
  }
  setPanelMarkup(host, dataSupportPanelMarkup(analysis));
}

export function renderDataLinksPanel() {
  const panel = dom.wiringStatusPanel;
  if (!panel) return;
  if (state.blueprintView !== "dataLinks") { panel.hidden = true; return; }
  panel.hidden = false;
  panel.tabIndex = -1;

  let analysis;
  try {
    analysis = currentDataSupportAnalysis();
  } catch (_) {
    setPanelMarkup(panel, `<div role="status" class="wiring-summary-line">Data Links analysis could not be produced.</div>`);
    return;
  }

  setPanelMarkup(panel, dataSupportPanelMarkup(analysis, { selectedLinkKey: dataLinksUiState.selectedLinkKey }));
}

export function refreshDataLinksPresentation() {
  if (state.blueprintView !== "dataLinks") return;
  renderDataLinksOverlay();
  renderDataLinksPanel();
}

const dataLinksUiState = { drag: null, selectedLinkKey: null };

function isDataLinksWeaponTargetValid(sourceIndex, targetIndex) {
  const s = state.design?.[sourceIndex]; const t = state.design?.[targetIndex];
  return s && t && sourceIndex !== targetIndex && rules().isDataSupportSource(s.type) && rules().isWeapon(t, PART_STATS);
}

function addDataLink(sourceIndex, targetIndex) {
  if (!isDataLinksWeaponTargetValid(sourceIndex, targetIndex)) return false;
  if (state.dataLinks.some((l) => l.sourceIndex === sourceIndex && l.targetIndex === targetIndex)) return false;
  state.dataLinks = [...state.dataLinks, { sourceIndex, targetIndex }];
  state.dataLinks = rules().normalizeDataLinks(state.design, state.dataLinks, PART_STATS);
  persistDesign(state.design, state.wiring, state.dataLinks, state.combatStyle);
  refreshDataLinksPresentation();
  return true;
}

function removeDataLink(sourceIndex, targetIndex) {
  state.dataLinks = state.dataLinks.filter((l) => l.sourceIndex !== sourceIndex || l.targetIndex !== targetIndex);
  state.dataLinks = rules().normalizeDataLinks(state.design, state.dataLinks, PART_STATS);
  persistDesign(state.design, state.wiring, state.dataLinks, state.combatStyle);
  refreshDataLinksPresentation();
}

function pointerGridPoint(clientX, clientY) {
  const rect = dom.grid?.getBoundingClientRect();
  if (!rect || !rect.width || !rect.height) return null;
  const style = getComputedStyle(dom.grid);
  const px = (s, d) => Math.max(0, Number.parseFloat(s) || d);
  const left = px(style.borderLeftWidth) + px(style.paddingLeft, 8);
  const top = px(style.borderTopWidth) + px(style.paddingTop, 8);
  const right = px(style.borderRightWidth) + px(style.paddingRight, 8);
  const bottom = px(style.borderBottomWidth) + px(style.paddingBottom, 8);
  const gapX = px(style.columnGap || style.gap, 2);
  const gapY = px(style.rowGap || style.gap, 2);
  const cellWidth = (rect.width - left - right - gapX * (GRID_SIZE - 1)) / GRID_SIZE;
  const cellHeight = (rect.height - top - bottom - gapY * (GRID_SIZE - 1)) / GRID_SIZE;
  const stepX = cellWidth + gapX;
  const stepY = cellHeight + gapY;
  if (!(cellWidth > 0 && cellHeight > 0)) return null;
  const localX = clientX - rect.left - left;
  const localY = clientY - rect.top - top;
  const x = Math.floor(localX / stepX);
  const y = Math.floor(localY / stepY);
  const fx = (localX - x * stepX) / cellWidth;
  const fy = (localY - y * stepY) / cellHeight;
  return { x: Math.max(0, Math.min(GRID_SIZE, x + fx)), y: Math.max(0, Math.min(GRID_SIZE, y + fy)) };
}

function onDataLinksPointerDown(event) {
  if (state.blueprintView !== "dataLinks") return;
  const source = event.target.closest("[data-source-index]");
  const link = event.target.closest("[data-link-key]");
  if (source) {
    event.preventDefault();
    dataLinksUiState.drag = { sourceIndex: Number(source.dataset.sourceIndex) };
    dataLinksUiState.selectedLinkKey = null;
    dom.wiringOverlayHost?.setPointerCapture?.(event.pointerId);
    renderDataLinksOverlay();
  } else if (link) {
    dataLinksUiState.selectedLinkKey = link.dataset.linkKey;
    dataLinksUiState.drag = null;
    renderDataLinksOverlay();
    renderDataLinksPanel();
  }
}

function onDataLinksPointerMove(event) {
  if (state.blueprintView !== "dataLinks" || !dataLinksUiState.drag) return;
  const p = pointerGridPoint(event.clientX, event.clientY);
  dataLinksUiState.drag.pointer = p;
  renderDataLinksOverlay();
}

function onDataLinksPointerUp(event) {
  if (state.blueprintView !== "dataLinks" || !dataLinksUiState.drag) return;
  const target = event.target.closest("[data-target-index]");
  if (target) {
    const t = Number(target.dataset.targetIndex);
    if (isDataLinksWeaponTargetValid(dataLinksUiState.drag.sourceIndex, t)) addDataLink(dataLinksUiState.drag.sourceIndex, t);
  }
  dataLinksUiState.drag = null;
  renderDataLinksOverlay();
  renderDataLinksPanel();
}

function onDataLinksKeyDown(event) {
  if (state.blueprintView !== "dataLinks") return;
  if (event.key === "Escape") {
    dataLinksUiState.drag = null;
    dataLinksUiState.selectedLinkKey = null;
    renderDataLinksOverlay();
    renderDataLinksPanel();
  }
  if ((event.key === "Delete" || event.key === "Backspace") && dataLinksUiState.selectedLinkKey) {
    const [s, t] = dataLinksUiState.selectedLinkKey.split(":").map(Number);
    removeDataLink(s, t);
    dataLinksUiState.selectedLinkKey = null;
  }
}

export function initDataLinksUi() {
  if (dom.wiringOverlayHost?.dataset.dataLinksBound) return;
  dom.wiringOverlayHost?.addEventListener("pointerdown", onDataLinksPointerDown);
  dom.wiringOverlayHost?.addEventListener("pointermove", onDataLinksPointerMove);
  dom.wiringOverlayHost?.addEventListener("pointerup", onDataLinksPointerUp);
  document.addEventListener("keydown", onDataLinksKeyDown);
  if (dom.wiringOverlayHost) dom.wiringOverlayHost.dataset.dataLinksBound = "1";
}
