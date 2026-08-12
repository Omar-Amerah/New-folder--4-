// Data Links view: connects Data-support sources to weapons as logical links,
// drawn as dashed lines. A link is just an explicit (source, weapon) pair, so
// this owns no route state.
//
// Two ways to connect, both hit-testing the component's whole footprint:
//   - click a source to arm it, then click weapons to toggle each link
//   - drag from a source onto a weapon
import { state } from "../state.js";
import { dom } from "./dom.js";
import { PART_DEFS, PART_STATS, partIconMarkup } from "../design/parts.js";
import { getCachedDesignDataSupport, getDesignEffectiveWeaponProfile, getDesignSourceAllocation, getDesignWeaponSupport } from "../design/dataSupportAnalysis.js";
import { formatDataSupportValue, formatDataSupportEquation } from "../design/dataSupportPresentation.js";
import { escapeHtml } from "../shared/formatting.js";
import { persistDesign } from "../design/blueprintStorage.js";
import { getOccupiedCells } from "../design/footprint.js";
// Link edits change predicted weapon stats, so the ship summary is re-rendered
// alongside the overlay. designerUi imports this module too; the cycle is the
// same shape the designer already uses and resolves at call time.
import { renderLocalStats } from "./designerUi.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const GRID_SIZE = 15;

const rules = () => globalThis.DataSupportRules;
let dataLinksResizeObserver = null;

globalThis.DataLinksUi = { renderDataLinksOverlay, refreshDataLinksPresentation, linkAllDataSourcesToWeapons };

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}
// Footprint geometry in grid units. Derived from the component catalogue so
// Data Links needs only the component catalogue and footprint geometry.
function componentCells(index) {
  const module = state.design?.[index];
  if (!module) return [];
  const footprint = PART_STATS[module.type]?.footprint || { width: 1, height: 1 };
  return getOccupiedCells(module.x, module.y, footprint, module.rotation || 0);
}

// A component's footprint is always rectangular, so its cells collapse to one
// box in grid units : the box the player sees on the grid, and the only shape
// Data Links hit-tests or highlights.
function componentBox(index) {
  const cells = componentCells(index);
  if (!cells.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const cell of cells) {
    minX = Math.min(minX, cell.x); maxX = Math.max(maxX, cell.x);
    minY = Math.min(minY, cell.y); maxY = Math.max(maxY, cell.y);
  }
  return { minX, minY, maxX, maxY };
}

function componentCenter(index) {
  const box = componentBox(index);
  if (!box) return null;
  return { x: (box.minX + box.maxX + 1) / 2, y: (box.minY + box.maxY + 1) / 2 };
}

// Build-grid geometry in CSS pixels. The grid is a CSS grid with a border,
// padding and 2px gaps, so a cell is NOT a plain fifteenth of the host box.
// Drawing the overlay as an even 15x15 division puts its presentational boxes a few pixels off
// the component it belongs to : worst at the far edges : which is what made the
// hit areas feel wrong. Pointer hit-testing deliberately does not depend on it.
function gridMetrics() {
  const grid = dom.grid;
  const rect = grid?.getBoundingClientRect();
  if (!rect || !rect.width || !rect.height) return null;
  const style = getComputedStyle(grid);
  const px = (s, d = 0) => Math.max(0, Number.parseFloat(s) || d);
  const left = px(style.borderLeftWidth) + px(style.paddingLeft, 8);
  const top = px(style.borderTopWidth) + px(style.paddingTop, 8);
  const right = px(style.borderRightWidth) + px(style.paddingRight, 8);
  const bottom = px(style.borderBottomWidth) + px(style.paddingBottom, 8);
  const gapX = px(style.columnGap || style.gap, 2);
  const gapY = px(style.rowGap || style.gap, 2);
  const contentWidth = rect.width - left - right;
  const contentHeight = rect.height - top - bottom;
  const cellWidth = (contentWidth - gapX * (GRID_SIZE - 1)) / GRID_SIZE;
  const cellHeight = (contentHeight - gapY * (GRID_SIZE - 1)) / GRID_SIZE;
  if (!(cellWidth > 0 && cellHeight > 0)) return null;
  return {
    rect, left, top, contentWidth, contentHeight,
    cellWidth, cellHeight, gapX, gapY,
    stepX: cellWidth + gapX, stepY: cellHeight + gapY
  };
}

// Overlay coordinates stay in cell units : one unit is one cell, so the CSS
// stroke widths and radii keep their meaning : but cells are pushed apart by
// the grid's gap so pad n lands exactly on component cell n.
function overlayProjection() {
  const metrics = gridMetrics();
  if (!metrics) {
    return { metrics: null, viewBoxWidth: GRID_SIZE, viewBoxHeight: GRID_SIZE, x: (v) => v, y: (v) => v };
  }
  const kx = metrics.stepX / metrics.cellWidth;
  const ky = metrics.stepY / metrics.cellHeight;
  // v is cellIndex + fraction, so only whole cells accumulate gap.
  const axis = (k) => (v) => v + Math.floor(v) * (k - 1);
  return {
    metrics,
    viewBoxWidth: GRID_SIZE + (GRID_SIZE - 1) * (kx - 1),
    viewBoxHeight: GRID_SIZE + (GRID_SIZE - 1) * (ky - 1),
    x: axis(kx),
    y: axis(ky)
  };
}

function projectPoint(proj, point) {
  return point ? { x: proj.x(point.x), y: proj.y(point.y) } : null;
}

// Component box in overlay units. A multi-cell component is one box: the gaps
// between its own cells belong to it, exactly as they do on the grid.
function projectBox(proj, index) {
  const box = componentBox(index);
  if (!box) return null;
  const x = proj.x(box.minX);
  const y = proj.y(box.minY);
  return { x, y, width: proj.x(box.maxX) + 1 - x, height: proj.y(box.maxY) + 1 - y };
}

function isSourceIndex(index) {
  return rules().isDataSupportSource(state.design?.[index]?.type);
}

function isWeaponIndex(index) {
  return rules().isWeapon(state.design?.[index], PART_STATS);
}

function hasLink(sourceIndex, targetIndex) {
  return (state.dataLinks || []).some((l) => l.sourceIndex === sourceIndex && l.targetIndex === targetIndex);
}

// Keep a footprint-shaped rectangle for optional presentation. Its projected
// geometry is not input authority, so it cannot drift a component's click area.
function hitPadFor(index, role, { cursor, active, proj }) {
  const box = projectBox(proj, index);
  if (!box) return null;
  return svgEl("rect", {
    ...box,
    fill: "transparent",
    class: `data-link-pad data-link-pad-${role}${active ? " is-active" : ""}`,
    [`data-${role}-index`]: String(index),
    "pointer-events": "none",
    style: `cursor:${cursor}`
  });
}

export function renderDataLinksOverlay() {
  const host = dom.dataLinksOverlayHost;
  if (!host) return;
  if (state.blueprintView !== "dataLinks") {
    host.replaceChildren();
    host.classList.remove("is-active");
    dom.grid?.classList.remove("data-links-active");
    return;
  }
  host.replaceChildren();
  host.classList.add("is-active");
  dom.grid?.classList.add("data-links-active");

  const proj = overlayProjection();
  const svg = svgEl("svg", {
    viewBox: `0 0 ${proj.viewBoxWidth} ${proj.viewBoxHeight}`,
    class: "data-links-overlay",
    preserveAspectRatio: "none"
  });
  // Pin the overlay to the grid's content box. The stylesheet's inset:8px
  // assumes the grid's padding but ignores its 1px border, so the pads sat a
  // pixel off in both axes before this.
  if (proj.metrics) {
    const hostRect = host.getBoundingClientRect();
    const left = proj.metrics.rect.left - hostRect.left + proj.metrics.left;
    const top = proj.metrics.rect.top - hostRect.top + proj.metrics.top;
    svg.setAttribute("style", `left:${left}px;top:${top}px;right:auto;bottom:auto;width:${proj.metrics.contentWidth}px;height:${proj.metrics.contentHeight}px`);
  }

  const links = state.dataLinks || [];
  const armed = dataLinksUiState.armedSourceIndex;
  const dragging = dataLinksUiState.drag?.sourceIndex ?? null;
  // The armed or dragged source is the one the player is working on; everything
  // else fades so its links and candidate weapons stand out.
  const focus = dragging ?? armed;

  // Outline the focused source and every weapon it can reach. The outline is
  // the component's box, so the highlight shows exactly where a click lands.
  if (focus != null) {
    const sourceBox = projectBox(proj, focus);
    if (sourceBox) {
      svg.appendChild(svgEl("rect", { ...sourceBox, rx: 0.12, class: "data-link-source-halo" }));
    }
    for (let i = 0; i < state.design.length; i += 1) {
      if (!isDataLinksWeaponTargetValid(focus, i)) continue;
      const targetBox = projectBox(proj, i);
      if (!targetBox) continue;
      svg.appendChild(svgEl("rect", {
        ...targetBox, rx: 0.12,
        class: `data-link-candidate${hasLink(focus, i) ? " is-linked" : ""}`
      }));
    }
  }

  const hitLines = [];
  for (const link of links) {
    const from = projectPoint(proj, componentCenter(link.sourceIndex));
    const to = projectPoint(proj, componentCenter(link.targetIndex));
    if (!from || !to) continue;
    const key = `${link.sourceIndex}:${link.targetIndex}`;
    const selected = dataLinksUiState.selectedLinkKey === key;
    const dim = focus != null && link.sourceIndex !== focus && link.targetIndex !== focus;
    svg.appendChild(svgEl("line", {
      x1: from.x, y1: from.y, x2: to.x, y2: to.y,
      class: `data-link-line${selected ? " is-selected" : ""}${dim ? " is-dim" : ""}`,
      "pointer-events": "none"
    }));
    // The visible line is dashed, and a dashed stroke only hit-tests on its
    // painted dashes. Carry clicks on a wider invisible companion instead.
    hitLines.push(svgEl("line", {
      x1: from.x, y1: from.y, x2: to.x, y2: to.y,
      class: "data-link-hit",
      "data-link-key": key,
      "pointer-events": "stroke",
      style: "cursor:pointer"
    }));
  }

  // Rubber band for an in-progress drag.
  if (dataLinksUiState.drag?.pointer) {
    const from = projectPoint(proj, componentCenter(dataLinksUiState.drag.sourceIndex));
    const to = projectPoint(proj, dataLinksUiState.drag.pointer);
    if (from && to) {
      svg.appendChild(svgEl("line", {
        x1: from.x, y1: from.y, x2: to.x, y2: to.y,
        class: "data-link-line is-pending",
        "pointer-events": "none"
      }));
    }
  }

  for (const hit of hitLines) svg.appendChild(hit);

  // Pads last so clicking a component always beats clicking a line across it.
  for (let i = 0; i < state.design.length; i += 1) {
    if (isSourceIndex(i)) {
      const pad = hitPadFor(i, "source", { cursor: dragging === i ? "grabbing" : "pointer", active: focus === i, proj });
      if (pad) svg.appendChild(pad);
    } else if (isWeaponIndex(i)) {
      const reachable = focus != null && isDataLinksWeaponTargetValid(focus, i);
      const pad = hitPadFor(i, "target", { cursor: reachable ? "copy" : "pointer", active: reachable, proj });
      if (pad) svg.appendChild(pad);
    }
  }

  host.appendChild(svg);
}

// Resolve the component at a client point for both pointer-down and pointerup.
// Pointerup is retargeted to the capturing host, so the DOM under the cursor
// cannot be read from event.target mid-drag.
function componentIndexAtClientPoint(clientX, clientY) {
  if (!dom.grid || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  for (const cell of dom.grid.querySelectorAll(".build-cell.occupied[data-part-index]")) {
    const rect = cell.getBoundingClientRect();
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      const index = Number(cell.dataset.partIndex);
      return Number.isInteger(index) ? index : null;
    }
  }
  return null;
}

// Written into the Build view's interaction guide line (which would otherwise
// advertise placement, and placement is paused here), so it reads in the same
// "action: input" shorthand rather than as its own paragraph.
export function dataLinksHintText() {
  const armed = dataLinksUiState.armedSourceIndex;
  if (!state.design?.some((_, i) => isSourceIndex(i))) {
    return "Add a Fire Control, Signal Amplifier, Targeting Computer or Stabilizer Node to create Data links";
  }
  if (armed == null) {
    return "Select: click a Data source · Link: click a weapon, or drag source → weapon";
  }
  const name = PART_DEFS[state.design[armed]?.type]?.name || "Source";
  const linked = (state.dataLinks || []).filter((l) => l.sourceIndex === armed).length;
  return `${name} selected · ${linked} linked · Link/unlink: click a weapon · Deselect: Esc`;
}

export function refreshDataLinksControls() {
  const active = state.blueprintView === "dataLinks";
  if (dom.dataLinksToolbar) dom.dataLinksToolbar.hidden = !active;
  if (!active) return;
  // Live updates (arming a source, adding a link) land here without a full
  // blueprint-control refresh, so the guide line is rewritten here too.
  if (dom.buildInteractionGuide) {
    dom.buildInteractionGuide.hidden = false;
    dom.buildInteractionGuide.textContent = dataLinksHintText();
  }
  if (dom.dataLinksClearButton) dom.dataLinksClearButton.disabled = (state.dataLinks || []).length === 0;
  if (dom.dataLinksAutoButton) {
    const pairs = allDataLinkPairs();
    // Nothing to link, or everything already linked.
    dom.dataLinksAutoButton.disabled = !pairs.length || pairs.every((p) => hasLink(p.sourceIndex, p.targetIndex));
  }
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
  return getCachedDesignDataSupport(state.design, PART_STATS, {
    thermalLoadMode: state.thermalLoadMode || "full",
    dataLinks: state.dataLinks,
    ...options
  });
}

// A source only counts as delivering when it has recipients to divide its
// budget between; an unlinked source is idle no matter how large its budget.
function isDeliveringSource(source) {
  return source.recipientCount > 0 && source.effectiveBudget > 0;
}

// Ordered by how fundamental the blocker is, so the badge names the thing the
// player has to fix rather than a downstream symptom.
function sourceRowStatus(source) {
  const amount = formatDataSupportValue({ bonusField: source.bonusField, amount: source.effectiveBudget });
  if (source.powerMultiplier <= 0) return { label: "UNPOWERED", tone: "badge-offline" };
  if (source.thermalMultiplier <= 0) return { label: "OVERHEATED", tone: "badge-offline" };
  if (source.recipientCount === 0) return { label: "NO RECIPIENTS", tone: "badge-neutral" };
  if (source.effectiveBudget <= 0) return { label: String(source.status).toUpperCase(), tone: "badge-neutral" };
  if (source.thermalMultiplier < 1) return { label: `REDUCED (${amount})`, tone: "badge-reduced" };
  return { label: `ACTIVE (${amount})`, tone: "badge-active" };
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
  return `<div class="data-component-row data-component-row-stacked data-row-${kind} data-row-${tone}" data-data-inspector="${kind}">
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
  const activeSources = sources.filter(isDeliveringSource);
  const supportedWeapons = weapons.filter((w) => w.status === "supported");

  // Only budget that actually reaches a weapon counts as delivered.
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
  } else if (activeSources.length === 0) {
    // Nothing is reaching a weapon, so this outranks any thermal derate.
    statusText = "IDLE · NO LINKS";
    statusClass = "data-badge-partially-active";
  } else if (reducedSources.length > 0) {
    statusText = "PARTIALLY ACTIVE · SOURCE REDUCED";
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
    } else if (s.recipientCount === 0) {
      warningCallouts.push({
        title: `${partName(s.sourceType)} has no weapon recipients`,
        message: `Its ${formatDataSupportValue({ bonusField: s.bonusField, amount: s.nominalBudget })} ${s.effect} is wasted until a weapon is linked.`
      });
    } else if (s.thermalMultiplier < 1) {
      warningCallouts.push({
        title: `${partName(s.sourceType)} is thermally reduced`,
        message: "Predicted heat is limiting support distribution."
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

  body += `<section class="data-panel-section data-inspection-card" data-data-inspector="overview">
    <div class="data-card-header">
      <span class="data-support-title">DATA SUPPORT</span>
      <span class="data-badge ${statusClass}">${escapeHtml(statusText)}</span>
    </div>
    <div class="data-summary-stats" data-data-inspector="status">
      <div class="data-stat-cell"><span class="data-stat-label">Sources</span><strong class="data-stat-value">${activeSources.length} / ${sources.length} active</strong></div>
      <div class="data-stat-cell"><span class="data-stat-label">Weapons</span><strong class="data-stat-value">${supportedWeapons.length} / ${weapons.length} supported</strong></div>
      <div class="data-stat-cell"><span class="data-stat-label">Delivered</span><strong class="data-stat-value ${deliveredSummaryText === "None" ? "data-stat-none" : "data-stat-active"}">${escapeHtml(deliveredSummaryText)}</strong></div>
    </div>
    <div class="data-link-note">Each Data source divides one fixed support budget across its linked weapons, so linking more weapons gives every weapon a smaller share.</div>
  </section>`;

  body += `<div class="data-components-card" data-data-inspector="components-card">
    <h5 class="data-section-heading">LINKED COMPONENTS</h5>
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

  body += `<section class="data-details" data-data-inspector="link-details">
    <h5 class="data-section-heading">LINK DETAILS</h5>
    <div id="data-link-details" class="data-link-details">
      <div class="data-link-row"><span>Direct links</span><strong>${(analysis?.links || []).length}</strong></div>
      <div class="data-link-row"><span>Sources fitted</span><strong>${sources.length}</strong></div>
      <div class="data-link-row"><span>Weapons fitted</span><strong>${weapons.length}</strong></div>
      <div class="data-link-note">Data links are free and weightless: they add no cost, no mass and no heat.</div>
    </div>
  </section>`;

  if (selectedLinkKey) {
    const [s, t] = selectedLinkKey.split(":").map(Number);
    body += `<section class="data-panel-section data-inspection-card" data-data-inspector="selected-link">
      <h5 class="data-section-heading">Selected link</h5>
      <div class="data-panel-line">${moduleLabel(s)} → ${moduleLabel(t)}</div>
      <div class="data-panel-line data-muted-text">Press Delete or Backspace to remove this link.</div>
    </section>`;
  }

  return body;
}

// The Blueprint's Data analysis tab is the only host for these cards. It owns
// no route DOM, so Data support remains a standalone logical editor.
// `thermalAnalysis` is the designer's already-computed prediction, passed in so
// the tab does not run a second thermal pass.
export function renderDataAnalysisPanel(host = dom.dataAnalysisSummary, { thermalAnalysis, selectedLinkKey } = {}) {
  if (!host) return;
  let analysis;
  try {
    analysis = currentDataSupportAnalysis(thermalAnalysis ? { thermalAnalysis } : {});
  } catch (_) {
    setPanelMarkup(host, `<div role="status" class="data-panel-line">Data support analysis could not be produced.</div>`);
    return;
  }
  setPanelMarkup(host, dataSupportPanelMarkup(analysis, {
    selectedLinkKey: selectedLinkKey ?? (state.blueprintView === "dataLinks" ? dataLinksUiState.selectedLinkKey : null)
  }));
}

export function refreshDataLinksPresentation() {
  if (state.blueprintView !== "dataLinks") return;
  renderDataLinksOverlay();
  refreshDataLinksControls();
  renderDataAnalysisPanel();
}

const dataLinksUiState = { drag: null, selectedLinkKey: null, armedSourceIndex: null };

export function resetDataLinksUiState() {
  dataLinksUiState.drag = null;
  dataLinksUiState.selectedLinkKey = null;
  dataLinksUiState.armedSourceIndex = null;
}

function isDataLinksWeaponTargetValid(sourceIndex, targetIndex) {
  const s = state.design?.[sourceIndex]; const t = state.design?.[targetIndex];
  return Boolean(s && t && sourceIndex !== targetIndex && rules().isDataSupportSource(s.type) && rules().isWeapon(t, PART_STATS));
}

// A link edit changes predicted weapon stats and therefore the ship summary, so
// the design is persisted and the whole designer presentation is refreshed.
function commitDataLinks(next) {
  state.dataLinks = rules().normalizeDataLinks(state.design, next, PART_STATS);
  persistDesign(state.design, state.dataLinks, state.combatStyle);
  refreshDataLinksPresentation();
  renderLocalStats();
}

function addDataLink(sourceIndex, targetIndex) {
  if (!isDataLinksWeaponTargetValid(sourceIndex, targetIndex)) return false;
  if (hasLink(sourceIndex, targetIndex)) return false;
  commitDataLinks([...(state.dataLinks || []), { sourceIndex, targetIndex }]);
  return true;
}

function removeDataLink(sourceIndex, targetIndex) {
  commitDataLinks((state.dataLinks || []).filter((l) => l.sourceIndex !== sourceIndex || l.targetIndex !== targetIndex));
}

// Click-to-connect: clicking an eligible weapon while a source is armed adds
// the link, and clicking an already-linked weapon takes it away again.
function toggleDataLink(sourceIndex, targetIndex) {
  if (!isDataLinksWeaponTargetValid(sourceIndex, targetIndex)) return false;
  if (hasLink(sourceIndex, targetIndex)) { removeDataLink(sourceIndex, targetIndex); return true; }
  return addDataLink(sourceIndex, targetIndex);
}

export function clearAllDataLinks() {
  if (!(state.dataLinks || []).length) return;
  dataLinksUiState.selectedLinkKey = null;
  commitDataLinks([]);
}

// Every (source, weapon) pair the editor would accept, in design order.
function allDataLinkPairs() {
  const design = state.design || [];
  const pairs = [];
  for (let source = 0; source < design.length; source += 1) {
    if (!isSourceIndex(source)) continue;
    for (let target = 0; target < design.length; target += 1) {
      if (isDataLinksWeaponTargetValid(source, target)) pairs.push({ sourceIndex: source, targetIndex: target });
    }
  }
  return pairs;
}

// Auto-link: connect every Data source to every weapon. This is the maximum
// coverage a design can have, not the strongest per-weapon bonus : each source
// still divides one fixed budget across everything it feeds.
export function linkAllDataSourcesToWeapons() {
  const pairs = allDataLinkPairs();
  if (!pairs.length || pairs.every((p) => hasLink(p.sourceIndex, p.targetIndex))) return false;
  dataLinksUiState.selectedLinkKey = null;
  commitDataLinks(pairs);
  return true;
}

function pointerGridPoint(clientX, clientY) {
  const m = gridMetrics();
  if (!m) return null;
  const localX = clientX - m.rect.left - m.left;
  const localY = clientY - m.rect.top - m.top;
  const x = Math.floor(localX / m.stepX);
  const y = Math.floor(localY / m.stepY);
  // A pointer inside the gap after cell n reads as a fraction above 1, which
  // would floor into cell n+1 when a drop is resolved. Gap pixels belong to the
  // cell they follow, so the fraction never leaves that cell.
  const inCell = (offset, size) => Math.max(0, Math.min(offset / size, 0.999));
  const fx = inCell(localX - x * m.stepX, m.cellWidth);
  const fy = inCell(localY - y * m.stepY, m.cellHeight);
  return { x: Math.max(0, Math.min(GRID_SIZE, x + fx)), y: Math.max(0, Math.min(GRID_SIZE, y + fy)) };
}

// Past this distance a press is a drag, not a click. Without it a sloppy click
// on a source would arm and immediately disarm the source.
const DRAG_THRESHOLD_CELLS = 0.35;

function onDataLinksPointerDown(event) {
  if (state.blueprintView !== "dataLinks" || event.button !== 0) return;
  const componentIndex = componentIndexAtClientPoint(event.clientX, event.clientY);
  const linkLine = event.target.closest?.("[data-link-key]");

  if (componentIndex != null && isSourceIndex(componentIndex)) {
    event.preventDefault();
    const sourceIndex = componentIndex;
    // Press starts a potential drag; whether it was a click is decided on up.
    dataLinksUiState.drag = { sourceIndex, origin: pointerGridPoint(event.clientX, event.clientY), moved: false };
    dataLinksUiState.selectedLinkKey = null;
    dom.dataLinksOverlayHost?.setPointerCapture?.(event.pointerId);
    renderDataLinksOverlay();
    return;
  }

  if (componentIndex != null && isWeaponIndex(componentIndex)) {
    // Clicking a weapon while a source is armed toggles that link.
    event.preventDefault();
    const targetIndex = componentIndex;
    const armed = dataLinksUiState.armedSourceIndex;
    if (armed != null && isDataLinksWeaponTargetValid(armed, targetIndex)) {
      toggleDataLink(armed, targetIndex);
    }
    return;
  }

  if (linkLine) {
    // Selecting a link is a different job from building new ones, so it drops
    // any armed source rather than leaving two selections live at once.
    dataLinksUiState.selectedLinkKey = linkLine.dataset.linkKey;
    dataLinksUiState.armedSourceIndex = null;
    dataLinksUiState.drag = null;
    refreshDataLinksPresentation();
    return;
  }

  // Empty space clears the working selection.
  if (dataLinksUiState.armedSourceIndex != null || dataLinksUiState.selectedLinkKey) {
    dataLinksUiState.armedSourceIndex = null;
    dataLinksUiState.selectedLinkKey = null;
    refreshDataLinksPresentation();
  }
}

function onDataLinksPointerMove(event) {
  if (state.blueprintView !== "dataLinks" || !dataLinksUiState.drag) return;
  const point = pointerGridPoint(event.clientX, event.clientY);
  const origin = dataLinksUiState.drag.origin;
  if (point && origin && Math.hypot(point.x - origin.x, point.y - origin.y) > DRAG_THRESHOLD_CELLS) {
    dataLinksUiState.drag.moved = true;
  }
  // Only trail a rubber band once the press has become a real drag.
  dataLinksUiState.drag.pointer = dataLinksUiState.drag.moved ? point : null;
  renderDataLinksOverlay();
}

function onDataLinksPointerUp(event) {
  if (state.blueprintView !== "dataLinks" || !dataLinksUiState.drag) return;
  const { sourceIndex, moved } = dataLinksUiState.drag;
  dataLinksUiState.drag = null;

  if (moved) {
    // Drag-to-connect: release over a weapon links it.
    const targetIndex = componentIndexAtClientPoint(event.clientX, event.clientY);
    if (targetIndex != null && isDataLinksWeaponTargetValid(sourceIndex, targetIndex)) {
      dataLinksUiState.armedSourceIndex = sourceIndex;
      addDataLink(sourceIndex, targetIndex);
      return;
    }
    dataLinksUiState.armedSourceIndex = sourceIndex;
  } else {
    // Click-to-connect: toggle this source as the armed one.
    dataLinksUiState.armedSourceIndex = dataLinksUiState.armedSourceIndex === sourceIndex ? null : sourceIndex;
  }
  refreshDataLinksPresentation();
}

function onDataLinksKeyDown(event) {
  if (state.blueprintView !== "dataLinks") return;
  if (event.key === "Escape") {
    dataLinksUiState.drag = null;
    dataLinksUiState.selectedLinkKey = null;
    dataLinksUiState.armedSourceIndex = null;
    refreshDataLinksPresentation();
    return;
  }
  if ((event.key === "Delete" || event.key === "Backspace") && dataLinksUiState.selectedLinkKey) {
    event.preventDefault();
    const [s, t] = dataLinksUiState.selectedLinkKey.split(":").map(Number);
    dataLinksUiState.selectedLinkKey = null;
    removeDataLink(s, t);
  }
}

export function initDataLinksUi() {
  const host = dom.dataLinksOverlayHost;
  if (!host) return;
  if (!dataLinksResizeObserver && dom.grid && typeof ResizeObserver !== "undefined") {
    dataLinksResizeObserver = new ResizeObserver(() => {
      if (state.blueprintView !== "dataLinks") return;
      requestAnimationFrame(() => {
        if (state.blueprintView === "dataLinks") renderDataLinksOverlay();
      });
    });
    dataLinksResizeObserver.observe(dom.grid);
  }
  if (host.dataset.dataLinksBound) return;
  host.addEventListener("pointerdown", onDataLinksPointerDown);
  host.addEventListener("pointermove", onDataLinksPointerMove);
  host.addEventListener("pointerup", onDataLinksPointerUp);
  host.addEventListener("pointercancel", () => { dataLinksUiState.drag = null; renderDataLinksOverlay(); });
  document.addEventListener("keydown", onDataLinksKeyDown);
  dom.dataLinksAutoButton?.addEventListener("click", linkAllDataSourcesToWeapons);
  dom.dataLinksClearButton?.addEventListener("click", clearAllDataLinks);
  host.dataset.dataLinksBound = "1";
}
