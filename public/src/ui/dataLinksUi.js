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

  const analysis = getCachedDesignDataSupport(state.design, state.wiring, PART_STATS, {
    thermalLoadMode: state.thermalLoadMode || "full",
    dataLinks: state.dataLinks
  });

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

let lastDataLinksMarkup = "";
function setDataLinksMarkup(panel, markup) {
  if (markup === lastDataLinksMarkup) return;
  lastDataLinksMarkup = markup;
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

export function renderDataLinksPanel() {
  const panel = dom.wiringStatusPanel;
  if (!panel) return;
  if (state.blueprintView !== "dataLinks") { panel.hidden = true; return; }
  panel.hidden = false;
  panel.tabIndex = -1;

  let analysis;
  try {
    analysis = getCachedDesignDataSupport(state.design, state.wiring, PART_STATS, {
      thermalLoadMode: state.thermalLoadMode || "full",
      dataLinks: state.dataLinks
    });
  } catch (_) {
    setDataLinksMarkup(panel, `<div role="status" class="wiring-summary-line">Data Links analysis could not be produced.</div>`);
    return;
  }

  const netSources = analysis.sources || [];
  const netWeapons = analysis.weapons || [];
  const activeSources = netSources.filter((s) => s.status === "active" || s.effectiveBudget > 0);
  const supportedWeapons = netWeapons.filter((w) => w.status === "supported");

  let totalRange = 0, totalAccuracy = 0, totalFireRate = 0;
  activeSources.forEach((s) => {
    if (s.bonusField === "rangeBonus") totalRange += s.effectiveBudget;
    if (s.bonusField === "accuracyBonus") totalAccuracy += s.effectiveBudget;
    if (s.bonusField === "fireRateBonus") totalFireRate += s.effectiveBudget;
  });

  const unpoweredSources = netSources.filter((s) => s.powerMultiplier <= 0);
  const reducedSources = netSources.filter((s) => s.thermalMultiplier < 1 && s.powerMultiplier > 0);

  let statusText = "ACTIVE";
  let statusClass = "data-badge-active";
  if (netSources.length === 0) {
    statusText = "OFFLINE · NO SOURCES";
    statusClass = "data-badge-offline";
  } else if (unpoweredSources.length > 0) {
    statusText = unpoweredSources.length === netSources.length ? "OFFLINE · SOURCE UNPOWERED" : "PARTIALLY ACTIVE · SOURCE UNPOWERED";
    statusClass = unpoweredSources.length === netSources.length ? "data-badge-offline" : "data-badge-partially-active";
  } else if (reducedSources.length > 0) {
    statusText = "PARTIALLY ACTIVE · SOURCE REDUCED";
    statusClass = "data-badge-partially-active";
  }

  let deliveredSummaryText = "None";
  const deliveredParts = [];
  if (totalRange > 0) deliveredParts.push(`${formatDataSupportValue({ bonusField: "rangeBonus", amount: totalRange })} Range`);
  if (totalAccuracy > 0) deliveredParts.push(`${formatDataSupportValue({ bonusField: "accuracyBonus", amount: totalAccuracy })} Accuracy`);
  if (totalFireRate > 0) deliveredParts.push(`${formatDataSupportValue({ bonusField: "fireRateBonus", amount: totalFireRate })} Fire Rate`);
  if (deliveredParts.length > 0) deliveredSummaryText = deliveredParts.join(", ");

  const warningCallouts = [];
  netSources.forEach((s) => {
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
        message: "No eligible weapons are directly linked to receive support."
      });
    }
  });
  if (netSources.length === 0 && netWeapons.length > 0) {
    warningCallouts.push({
      title: "No Data support source connected",
      message: `There ${netWeapons.length === 1 ? "is" : "are"} ${netWeapons.length} weapon${netWeapons.length === 1 ? "" : "s"} but no active Data source.`
    });
  }

  const locateIconSvg = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5"/><line x1="8" y1="1" x2="8" y2="3"/><line x1="8" y1="13" x2="8" y2="15"/><line x1="1" y1="8" x2="3" y2="8"/><line x1="13" y1="8" x2="15" y2="8"/></svg>`;
  const warningIconSvg = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2L1 14h14L8 2z"/><line x1="8" y1="6" x2="8" y2="9"/><circle cx="8" cy="11.5" r="0.5" fill="currentColor"/></svg>`;

  let body = `<div id="data-links-live" aria-live="polite" class="sr-only">Data Links prediction refreshed.</div>`;

  body += `<section class="wiring-summary-section data-inspection-card" data-data-inspector="overview">
    <div class="data-card-header">
      <span class="data-network-title">DATA SUPPORT</span>
      <span class="data-badge ${statusClass}">${escapeHtml(statusText)}</span>
    </div>
    <div class="data-summary-stats" data-data-inspector="status" style="margin-top:8px;">
      <div class="data-stat-cell"><span class="data-stat-label">Sources</span><strong class="data-stat-value">${activeSources.length} / ${netSources.length}</strong></div>
      <div class="data-stat-cell"><span class="data-stat-label">Weapons</span><strong class="data-stat-value">${supportedWeapons.length} / ${netWeapons.length}</strong></div>
      <div class="data-stat-cell"><span class="data-stat-label">Delivered</span><strong class="data-stat-value ${deliveredSummaryText === "None" ? "data-stat-none" : "data-stat-active"}">${escapeHtml(deliveredSummaryText)}</strong></div>
    </div>
  </section>`;

  body += `<div class="data-components-card" data-data-inspector="components-card">
    <h5 class="data-section-heading">NETWORK COMPONENTS</h5>
    <div class="data-component-list">`;

  netSources.forEach((s) => {
    const mod = state.design[s.sourceIndex];
    const coords = mod ? `(${mod.x},${mod.y})` : "";
    let statusLabel = "";
    let statusTone = "";
    if (s.status === "active" || s.effectiveBudget > 0) {
      statusLabel = `ACTIVE (${formatDataSupportValue({ bonusField: s.bonusField, amount: s.effectiveBudget })})`;
      statusTone = "badge-active";
    } else if (s.powerMultiplier <= 0) {
      statusLabel = "UNPOWERED";
      statusTone = "badge-offline";
    } else if (s.thermalMultiplier < 1) {
      statusLabel = "THERMALLY REDUCED";
      statusTone = "badge-reduced";
    } else if (s.recipientCount === 0) {
      statusLabel = "NO RECIPIENTS";
      statusTone = "badge-neutral";
    } else {
      statusLabel = s.status.toUpperCase();
      statusTone = "badge-neutral";
    }
    const iconHtml = partIconMarkup ? partIconMarkup(s.sourceType, "data-component-icon", mod?.rotation || 0) : "";
    body += `<div class="wiring-summary-line wiring-component-row data-component-row data-row-source data-row-${statusTone}" data-data-inspector="source">
      <div class="data-row-main">
        ${iconHtml}
        <span class="data-component-name">${escapeHtml(partName(s.sourceType))}</span>
        <span class="data-component-coords">${escapeHtml(coords)}</span>
      </div>
      <div class="data-row-actions">
        <span class="data-status-badge ${statusTone}">${escapeHtml(statusLabel)}</span>
      </div>
    </div>`;
  });

  netWeapons.forEach((w) => {
    const mod = state.design[w.weaponIndex];
    const coords = mod ? `(${mod.x},${mod.y})` : "";
    let statusLabel = "";
    let statusTone = "";
    if (w.status === "supported") {
      const bonusParts = [];
      if (w.rangeBonus > 0) bonusParts.push(`${formatDataSupportValue({ bonusField: "rangeBonus", amount: w.rangeBonus })}`);
      if (w.accuracyBonus > 0) bonusParts.push(`${formatDataSupportValue({ bonusField: "accuracyBonus", amount: w.accuracyBonus })}`);
      if (w.fireRateBonus > 0) bonusParts.push(`${formatDataSupportValue({ bonusField: "fireRateBonus", amount: w.fireRateBonus })}`);
      const bonusText = bonusParts.join(", ");
      statusLabel = bonusText ? `SUPPORTED (${bonusText})` : "SUPPORTED";
      statusTone = "badge-active";
    } else {
      statusLabel = "NO SUPPORT";
      statusTone = "badge-neutral";
    }
    const iconHtml = partIconMarkup ? partIconMarkup(w.weaponType, "data-component-icon", mod?.rotation || 0) : "";
    body += `<div class="wiring-summary-line wiring-component-row data-component-row data-row-weapon data-row-${statusTone}" data-data-inspector="weapon">
      <div class="data-row-main">
        ${iconHtml}
        <span class="data-component-name">${escapeHtml(partName(w.weaponType))}</span>
        <span class="data-component-coords">${escapeHtml(coords)}</span>
      </div>
      <div class="data-row-actions">
        <span class="data-status-badge ${statusTone}">${escapeHtml(statusLabel)}</span>
      </div>
    </div>`;
  });

  body += `  </div></div>`;

  body += `<div class="data-delivered-card" data-data-inspector="delivered-support">
    <h5 class="data-section-heading">DELIVERED SUPPORT</h5>`;
  if (totalRange <= 0 && totalAccuracy <= 0 && totalFireRate <= 0) {
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
        <div class="data-warning-title">${warningIconSvg} ${escapeHtml(warn.title)}</div>
        <div class="data-warning-msg">${escapeHtml(warn.message)}</div>
      </div>`;
    });
    body += `</div>`;
  }

  body += `<details class="wiring-analysis-expander wiring-advanced-details" data-wiring-details="advanced">
    <summary aria-expanded="false" aria-controls="data-infra-content"><span>Infrastructure details</span></summary>
    <div id="data-infra-content" class="wiring-summary-subsection data-infra-details">
      <div class="data-infra-row"><span>Direct links</span><strong>${(analysis.links || []).length}</strong></div>
      <div class="data-infra-row"><span>Wiring cost</span><strong>$0.00</strong></div>
      <div class="data-infra-row"><span>Heat-capacity displacement</span><strong>0</strong></div>
      <div class="data-infra-note">Direct Data Links do not use physical cable and have no capacity, flow or overload limits.</div>
    </div>
  </details>`;

  if (dataLinksUiState.selectedLinkKey) {
    const [s, t] = dataLinksUiState.selectedLinkKey.split(":").map(Number);
    body += `<section class="wiring-summary-section data-inspection-card" data-data-inspector="selected-link">
      <h5>Selected link</h5>
      <div class="wiring-summary-line">${moduleLabel(s)} → ${moduleLabel(t)}</div>
      <div class="wiring-summary-line wiring-muted-text">Press Delete or Backspace to remove this link.</div>
    </section>`;
  }

  setDataLinksMarkup(panel, body);
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
