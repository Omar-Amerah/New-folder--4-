// Hover/context card model for the ship designer's Heat view.
//
// This module answers one question: "what does the player need to know about
// this component's heat, right now, to make the next design decision?" It is
// deliberately NOT a diagnostics dump : engineering detail (capacities,
// transfer detail and accumulated simulation totals) belongs in the
// detailed Heat analysis panel, not in a card that appears under the cursor.
//
// Two rules shape everything below:
//   1. Role-specific. A Heat Sink stores, a Radiator rejects, a Heat Pipe
//      transports, everything else produces. Each gets the rows that matter for
//      its role instead of one generic twenty-row list.
//   2. Exceptions only. A 100% operational multiplier, "Overheat in: Never" and
//      similar normal-state readings are noise; they collapse into one short
//      status line. Only an actual penalty or an actual countdown gets a row.
//
// The module is pure (no DOM, no globals beyond the shared HeatRules authority)
// so the card contents can be unit-tested without a browser.

import { PART_DEFS, PART_STATS } from "./parts.js";
import { getOccupiedCells } from "./footprint.js";
import { coolantNetworkAt } from "./coolantLayout.js";
import { COOLING_ENDPOINT_TYPES } from "./thermalAnalysis.js";
import { escapeHtml } from "../shared/formatting.js";

// Heat state visual language shared with the grid overlay (heat-ui-* classes in
// build-grid.css). Index matches HeatRules.STATE.
const STATE_CLASSES = ["cool", "warm", "hot", "critical", "overheated"];
const CONNECTED = "●";   // ●
const WARNING = "⚠";     // ⚠

function rateText(value, { signed = true } = {}) {
  const number = Number(value) || 0;
  const sign = signed && number >= 0 ? "+" : number < 0 ? "-" : "";
  return `${sign}${Math.abs(number).toFixed(1)} H/s`;
}

function heatText(value) { return `${Math.round(Number(value) || 0)} H`; }
function secondsText(value) { return `${Number(value).toFixed(1)} s`; }
function percentText(value) { return `${Math.round((Number(value) || 0) * 100)}%`; }

/**
 * Role of a component in the Heat system. Drives which rows the card shows.
 * @param {string} type
 * @param {object} rules Shared HeatRules.
 * @returns {"heatSink"|"radiator"|"cooler"|"heatPipe"|"producer"}
 */
export function heatCardRole(type, rules = globalThis.HeatRules) {
  if (type === "heatSink") return "heatSink";
  if (type === "radiator" || type === "heatVent") return "radiator";
  if (type === "closedCycleCooler") return "cooler";
  if (rules?.isCoolantTransportType ? rules.isCoolantTransportType(type) : type === "heatPipe") return "heatPipe";
  return "producer";
}

function neighbourIndices(design, index, partStats) {
  const module = design[index];
  if (!module) return [];
  const cellsOf = (target) => {
    const entry = design[target];
    const stat = partStats?.[entry.type] || {};
    return getOccupiedCells(entry.x, entry.y, stat.footprint || { width: 1, height: 1 }, entry.rotation || 0);
  };
  const owned = new Set(cellsOf(index).map((cell) => `${cell.x},${cell.y}`));
  const found = new Set();
  for (let i = 0; i < design.length; i += 1) {
    if (i === index) continue;
    for (const cell of cellsOf(i)) {
      if (owned.has(`${cell.x + 1},${cell.y}`) || owned.has(`${cell.x - 1},${cell.y}`)
        || owned.has(`${cell.x},${cell.y + 1}`) || owned.has(`${cell.x},${cell.y - 1}`)) { found.add(i); break; }
    }
  }
  return [...found];
}

/**
 * How this component reaches the rest of the thermal system. Heat Pipes form the
 * dedicated coolant network; everything else can still conduct directly to a
 * touching component, which is a weaker but real answer : so it gets its own
 * wording instead of being reported as "Disconnected".
 */
function connectionStatus(design, index, partStats, role) {
  const network = coolantNetworkAt(design, index, partStats);
  if (role === "heatPipe") {
    const attached = network ? network.attachments.size : 0;
    return attached > 0
      ? { label: `${CONNECTED} Connected`, tone: "good", attached }
      : { label: `${WARNING} Nothing attached`, tone: "warn", attached: 0 };
  }
  if (network) return { label: `${CONNECTED} Connected`, tone: "good", attached: network.attachments.size };
  const neighbours = neighbourIndices(design, index, partStats);
  const isCooling = role !== "producer";
  const contact = isCooling
    ? neighbours.length > 0
    : neighbours.some((i) => COOLING_ENDPOINT_TYPES.has(design[i].type));
  if (contact) return { label: `${CONNECTED} Direct contact`, tone: "good", attached: 0 };
  return { label: `${WARNING} Disconnected`, tone: "warn", attached: 0 };
}

/**
 * The one performance penalty worth surfacing: heat is actually reducing what
 * this component does. Never rendered at 100% : that is the normal state.
 */
function performancePenalty(type, stat, state, rules) {
  const active = rules.activeOutputForState(state);
  const describe = (what, value) => (value >= 0.999 ? null : { what, value });
  if (type === "heatSink" || type === "heatPipe") return null;
  if (type === "radiator" || type === "heatVent" || type === "closedCycleCooler") {
    return describe("cooling output", rules.activeCoolingForState(state));
  }
  if (rules.isPassiveStructure(type, stat) || /frame/i.test(String(type))) {
    const value = rules.passiveProtectionForState(state);
    return describe(type === "armor" || type === "compositeArmor" ? "protection" : "structural strength", value);
  }
  if (stat.weapon) return describe(stat.weapon.type === "beam" ? "beam output" : "fire rate", active);
  if ((stat.thrust || 0) > 0 || (stat.lateralThrust || 0) > 0 || (stat.turn || 0) > 0) return describe("thrust", active);
  if ((stat.powerGeneration || 0) > 0) return describe("power output", active);
  if ((stat.shieldRegen || 0) > 0) return describe("shield recharge", active);
  if ((stat.repairRate || 0) > 0) return describe("repair output", active);
  return null;
}

/**
 * Build the display model for one component's Heat hover card.
 * @param {object} options
 * @param {Array<{type:string,x:number,y:number,rotation?:number}>} options.design
 * @param {number} options.index Hovered component index.
 * @param {object} options.prediction Entry from analyzeDesignHeat().predictions.
 * @param {object} [options.result] Full thermal analysis, for routing problems.
 * @param {object} [options.partStats] Catalogue (defaults to PART_STATS).
 * @param {object} [options.rules] Shared HeatRules.
 * @returns {{title:string,stateLabel:string,stateClass:string,meter:object,rows:Array,notes:Array,statuses:Array}|null}
 */
export function buildHeatCardModel(options = {}) {
  const { design = [], index, prediction, result = null } = options;
  const partStats = options.partStats || PART_STATS;
  const rules = options.rules || globalThis.HeatRules;
  const part = design[index];
  if (!part || !prediction || !rules) return null;

  const stat = partStats[part.type] || {};
  const role = heatCardRole(part.type, rules);
  // The card reads the SETTLED end-of-simulation state, because that is the
  // instant the rate rows below describe. The transient peak is a separate,
  // clearly-labelled figure : pairing a peak temperature with a final-state heat
  // rate is what made an equilibrium reactor look like it was reading wrong.
  const capacity = Math.max(1, Number(prediction.capacity) || 1);
  const peakRatio = Math.max(0, Number(prediction.peakRatio ?? prediction.ratio) || 0);
  const ratio = Math.max(0, Number(prediction.finalRatio ?? prediction.ratio) || 0);
  const stored = Math.max(0, Number(prediction.finalHeat ?? prediction.heat) || 0);
  const state = Number(prediction.finalState ?? prediction.state) || 0;
  const generation = Number(prediction.finalGeneration ?? prediction.generation) || 0;
  const cooling = Number(prediction.cooling) || 0;
  const received = Number(prediction.received) || 0;
  const transferredOut = Number(prediction.transferredOut) || 0;
  const net = generation + received - transferredOut - cooling;
  const connection = connectionStatus(design, index, partStats, role);
  const isHeatSink = role === "heatSink";

  const rows = [];
  const notes = [];
  const statuses = [];

  if (isHeatSink) {
    // The meter above already reads "Stored 212 / 340 H"; repeating it as a row
    // is exactly the duplication this card exists to remove.
    rows.push(net >= 0
      ? { label: "Filling", value: rateText(net) }
      : { label: "Draining", value: rateText(net) });
    rows.push({ label: "Coolant", value: connection.label, tone: connection.tone });
  } else if (role === "radiator" || role === "cooler") {
    rows.push({ label: "Heat removed", value: rateText(cooling, { signed: false }) });
    if (role === "radiator") {
      const exposed = (prediction.exposedEdges || 0) > 0;
      const multiplier = Number(prediction.exposureCoolingMultiplier ?? 1);
      rows.push(exposed
        ? { label: "Exposure", value: "Full" }
        : { label: "Exposure", value: `${WARNING} Enclosed : ${percentText(multiplier)}`, tone: "warn" });
    }
    rows.push({ label: "Coolant", value: connection.label, tone: connection.tone });
  } else if (role === "heatPipe") {
    rows.push({ label: "Flow", value: rateText(Math.max(received, transferredOut), { signed: false }) });
    rows.push({ label: "Network", value: connection.label, tone: connection.tone });
  } else {
    if (generation > 0.05) rows.push({ label: "Generates", value: rateText(generation) });
    rows.push({ label: "Net heat", value: rateText(net) });
    rows.push({ label: "Coolant", value: connection.label, tone: connection.tone });
  }

  const penalty = performancePenalty(part.type, stat, state, rules);
  if (penalty) notes.push({ text: `${WARNING} Heat reducing ${penalty.what} to ${percentText(penalty.value)}`, tone: "warn" });
  if (result?.problemIndices?.unroutedHot?.has?.(index)) {
    notes.push({ text: `${WARNING} No route to a Heat Sink, Radiator or Vent`, tone: "warn" });
  }

  const overheatWord = isHeatSink ? "SATURATES" : "OVERHEATS";
  if (prediction.timeToOverheat != null) {
    statuses.push({ text: `${overheatWord} IN ${secondsText(prediction.timeToOverheat)}`, tone: "danger" });
  } else if (isHeatSink && ratio >= 0.9) {
    statuses.push({ text: "Nearly saturated", tone: "warn" });
  } else {
    statuses.push({ text: isHeatSink ? "No saturation predicted" : "No overheat predicted", tone: "ok" });
  }
  if (prediction.meltdownTime != null) {
    statuses.push({ text: `MELTDOWN IN ${secondsText(prediction.meltdownTime)}`, tone: "danger" });
  }

  const stateIndex = rules.clamp(state, 0, STATE_CLASSES.length - 1);
  const percent = Math.min(100, Math.round(ratio * 100));
  const peakPercent = Math.min(100, Math.round(peakRatio * 100));
  return {
    title: `${PART_DEFS[part.type]?.name || part.type} #${index}`,
    role,
    stateLabel: rules.STATE_LABELS[stateIndex] || "Cool",
    stateClass: STATE_CLASSES[stateIndex],
    meter: {
      // A component that never settles has not "settled at" anything.
      label: isHeatSink ? "Stored" : prediction.timeToOverheat != null ? "Ends at" : "Settles at",
      percent,
      fillPercent: Math.max(0, Math.min(100, Math.round(ratio * 100))),
      detail: `${Math.round(stored)} / ${Math.round(capacity)} H`,
      // Only worth stating when the run actually got hotter than it ended.
      peakPercent: peakPercent > percent ? peakPercent : null,
      // Amber when the transient peak was a worse Heat state than the settled one.
      peakTone: rules.stateFor(peakRatio, rules.STATE.NORMAL) > stateIndex ? "warn" : null
    },
    rows,
    notes,
    statuses
  };
}

/**
 * Render a card model as HTML. Values never wrap mid-word: labels get the
 * flexible column and values stay intact (see .heat-card-grid in build-grid.css).
 * @param {object} model Output of buildHeatCardModel().
 * @returns {string}
 */
export function heatCardMarkup(model) {
  if (!model) return "";
  const rows = model.rows.map((row) =>
    `<span${row.tone ? ` class="heat-card-${escapeHtml(row.tone)}"` : ""}>${escapeHtml(row.label)}</span>`
    + `<strong${row.tone ? ` class="heat-card-${escapeHtml(row.tone)}"` : ""}>${escapeHtml(row.value)}</strong>`
  ).join("");
  const notes = model.notes.map((note) =>
    `<p class="heat-card-note heat-card-${escapeHtml(note.tone)}">${escapeHtml(note.text)}</p>`
  ).join("");
  const statuses = model.statuses.map((status) =>
    `<p class="heat-card-status heat-card-status-${escapeHtml(status.tone)}">${escapeHtml(status.text)}</p>`
  ).join("");
  return `<h4><span class="heat-card-name">${escapeHtml(model.title)}</span>`
    + `<span class="heat-card-state heat-card-state-${escapeHtml(model.stateClass)}">${escapeHtml(model.stateLabel)}</span></h4>`
    + `<div class="heat-card-meter">`
    + `<span class="heat-card-meter-label">${escapeHtml(model.meter.label)}</span>`
    + `<div class="heat-card-meter-gauge">`
    + `<div class="heat-card-bar heat-ui-${escapeHtml(model.stateClass)}" role="img" aria-label="${escapeHtml(`${model.meter.label} ${model.meter.percent}%`)}">`
    + `<i style="width:${model.meter.fillPercent}%"></i></div>`
    + `<span class="heat-card-meter-value">${model.meter.percent}%</span>`
    + `</div>`
    + `<span class="heat-card-meter-detail">${escapeHtml(model.meter.detail)}</span>`
    + (model.meter.peakPercent == null ? "" :
      `<div class="heat-card-meter-peak${model.meter.peakTone ? ` heat-card-${escapeHtml(model.meter.peakTone)}` : ""}">`
      + `<span>Peak</span><strong>${model.meter.peakPercent}%</strong></div>`)
    + `</div>`
    + `<div class="heat-card-grid">${rows}</div>${notes}${statuses}`;
}
