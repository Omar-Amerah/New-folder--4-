import { dom } from "../dom.js";
import { state } from "../../state.js";
import { PART_DEFS, PART_STATS } from "../../design/parts.js";
import { disconnectedComponentIndices } from "../../design/blueprintValidation.js";
import { computeStats } from "../../design/componentStats.js";
import { buildShipSummaryModel, resolvePowerSummary, turnText } from "../../design/shipSummaryModel.js";
import { refreshLoadedBlueprintPresentation } from "../savedBlueprintsUi.js";
import { formatSpeed, formatThrust, round2 } from "../../design/statFormatting.js";
import { escapeHtml } from "../../shared/formatting.js";
import { GENERATED_BALANCE } from "../../generatedBalance.js";
import { getRepairStackingMultiplier, stackingProgression } from "../../shared/repairRules.js";
import { MOVEMENT_CONFIG } from "../../shared/movementStats.js";
import { calculateUniversalPower } from "../../shared/universalPower.js";
import { renderDataAnalysisPanel } from "./dataLinksMode.js";
import { currentHeatAnalysis, renderFullLoadThermalPanel } from "./heatMode.js";

export function currentPowerFlow() {
  const design = Array.isArray(state.design) ? state.design : [];
  return calculateUniversalPower(design, PART_STATS);
}

// The Ship summary leads with nine headline outcomes, follows with concise
// status messages driven by real conditions, and keeps engineering calculations
// in collapsed sections. Structure and value selection come from
// buildShipSummaryModel; this function only renders it.
function renderShipSummary(stats, heat) {
  if (!dom.stats) return;
  const flow = currentPowerFlow();
  const disconnectedIndices = disconnectedComponentIndices(state.design);
  const model = buildShipSummaryModel(stats, {
    design: state.design,
    powerSummary: flow,
    partNames: PART_DEFS,
    overheatingCount: overheatingComponentCount(heat),
    disconnectedComponentCount: disconnectedIndices.length,
    disconnectedComponentIndices: disconnectedIndices,
    includePower: true
  });
  const open = shipSummaryOpenSections();

  const overview = `
    <div class="ship-summary-grid" role="list">
      ${model.overview.map((row) => statMarkup(row.id, row.label, row.value, row.tone === "bad" ? "bad" : row.tone === "good" ? "good" : "neutral", row.hint)).join("")}
    </div>`;

  const status = model.status.length ? `
    <ul class="ship-summary-status" aria-label="Design status">
      ${model.status.map((message) => `
        <li class="ship-status-line is-${escapeHtml(message.level)}" data-status-id="${escapeHtml(message.id)}">
          <span class="ship-status-icon" aria-hidden="true">${statusIcon(message.level)}</span>
          <span class="ship-status-text">${escapeHtml(message.text)}</span>
        </li>`).join("")}
    </ul>` : "";

  const sections = model.sections.map((section) => {
    const isOpen = Boolean(open[section.id]);
    const panelId = `shipSummarySection-${section.id}`;
    const triggerId = `${panelId}-trigger`;
    return `
      <div class="part-accordion${isOpen ? " is-open" : ""}" data-accordion="${escapeHtml(section.id)}">
        <button type="button" class="part-accordion-trigger" id="${triggerId}"
                aria-expanded="${isOpen ? "true" : "false"}" aria-controls="${panelId}"
                data-summary-section="${escapeHtml(section.id)}">
          <span class="part-accordion-marker" aria-hidden="true"></span>
          <span class="part-accordion-title">${escapeHtml(section.title)}</span>
        </button>
        <div class="part-accordion-panel" id="${panelId}" role="region" aria-labelledby="${triggerId}"${isOpen ? "" : " hidden"}>
          <div class="part-detail-list">
            ${section.rows.map((row) => `
              <div class="part-detail-row${row.tone ? ` is-${escapeHtml(row.tone)}` : ""}">
                <span class="part-spec-label">${escapeHtml(row.label)}</span>
                <strong class="part-detail-value">${escapeHtml(row.value)}</strong>
              </div>`).join("")}
          </div>
          ${section.note ? `<p class="part-accordion-note">${escapeHtml(section.note)}</p>` : ""}
        </div>
      </div>`;
  }).join("");

  dom.stats.innerHTML = `${overview}${status}${sections}`;
  attachShipSummaryAccordionHandlers();
}

function statusIcon(level) {
  if (level === "good") return "✓";
  if (level === "bad") return "✕";
  if (level === "warning") return "!";
  return "•";
}

// Count components the authoritative thermal analysis predicts will overheat.
function overheatingComponentCount(heat) {
  const rules = globalThis.HeatRules;
  if (!heat?.predictions || !rules) return 0;
  let count = 0;
  for (const prediction of heat.predictions.values()) {
    if (prediction?.state >= rules.STATE.OVERHEATED) count += 1;
  }
  return count;
}

function shipSummaryOpenSections() {
  if (!state.shipSummaryOpen || typeof state.shipSummaryOpen !== "object") state.shipSummaryOpen = {};
  return state.shipSummaryOpen;
}

function attachShipSummaryAccordionHandlers() {
  dom.stats.querySelectorAll("[data-summary-section]").forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const wrapper = trigger.closest(".part-accordion");
      const panel = wrapper?.querySelector(".part-accordion-panel");
      if (!panel) return;
      const next = trigger.getAttribute("aria-expanded") !== "true";
      trigger.setAttribute("aria-expanded", next ? "true" : "false");
      panel.hidden = !next;
      wrapper.classList.toggle("is-open", next);
      shipSummaryOpenSections()[trigger.dataset.summarySection] = next;
    });
  });
}

export function renderLocalStats() {
  const stats = computeStats(state.design, { dataLinks: state.dataLinks });
  const heat = currentHeatAnalysis();
  const mine = state.mine;
  const money = currentMatchMoney(mine);
  const canAfford = money >= stats.unitCost;

  if (dom.combatStyleSelect) {
    dom.combatStyleSelect.value = state.combatStyle || "hold";
  }
  refreshLoadedBlueprintPresentation();
  if (dom.blueprintCostLabel) dom.blueprintCostLabel.textContent = `$${stats.unitCost.toLocaleString()}`;
  if (dom.blueprintCostStatus) {
    dom.blueprintCostStatus.textContent = "";
    dom.blueprintCostStatus.className = "";
  }
  renderShipSummary(stats, heat);

    renderAnalysisPanels(stats, heat);
}

function analysisGridMarkup(rows) {
  return `<div class="analysis-stat-grid">${rows.map(([label, value, tone = ""]) => `
    <div${tone ? ` class="${escapeHtml(tone)}"` : ""}><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join("")}</div>`;
}

function sensorSectorPath(cx, cy, radius, relativeAngle, arc) {
  const screenAngle = (Number(relativeAngle) || 0) - Math.PI / 2;
  const halfArc = Math.max(0, Number(arc) || 0) / 2;
  const start = screenAngle - halfArc;
  const end = screenAngle + halfArc;
  const x1 = cx + Math.cos(start) * radius;
  const y1 = cy + Math.sin(start) * radius;
  const x2 = cx + Math.cos(end) * radius;
  const y2 = cy + Math.sin(end) * radius;
  return [
    `M ${cx.toFixed(2)} ${cy.toFixed(2)}`,
    `L ${x1.toFixed(2)} ${y1.toFixed(2)}`,
    `A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 ${halfArc * 2 > Math.PI ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
    "Z"
  ].join(" ");
}

function sensorCoverageMarkup(stats) {
  const contributions = stats.sensorContributions || {};
  const omni = Array.isArray(contributions.omni) ? contributions.omni : [];
  const directed = Array.isArray(contributions.directed) ? contributions.directed : [];
  const baseRange = Math.max(0, Number(contributions.baseRange ?? stats.baseSensorRange) || 0);
  const omniRange = Math.max(baseRange, Number(stats.sensorRange) || 0);
  const directedMax = directed.reduce((maximum, entry) => Math.max(maximum, Number(entry.range) || 0), 0);
  const maxRange = Math.max(1, omniRange, directedMax);
  const cx = 130;
  const cy = 118;
  const chartRadius = 92;
  const scaledRadius = (range) => Math.max(0, Math.min(chartRadius, chartRadius * (Number(range) || 0) / maxRange));
  const baseRadius = scaledRadius(baseRange);
  const omniRadius = scaledRadius(omniRange);
  const coneMarkup = [...directed]
    .sort((a, b) => (Number(b.range) || 0) - (Number(a.range) || 0))
    .map((entry, index) => {
      const opacity = "0.62";
      return `<path class="sensor-coverage-cone sensor-coverage-cone-${index % 3}"
        d="${sensorSectorPath(cx, cy, scaledRadius(entry.range), entry.relativeAngle, entry.arc)}"
        style="fill-opacity:${opacity}"></path>`;
    }).join("");
  const ringMarkup = [0.25, 0.5, 0.75, 1].map((ratio) => `
    <circle class="sensor-coverage-grid-ring" cx="${cx}" cy="${cy}" r="${(chartRadius * ratio).toFixed(2)}"></circle>`).join("");
  const rangeLabel = (value) => `${Math.round(Number(value) || 0).toLocaleString()} m`;
  const hasInstalledSensors = omni.length + directed.length > 0;

  return `<section class="analysis-summary-card sensor-coverage-card">
    <div class="sensor-coverage-heading">
      <div>
        <h3>Sensor coverage</h3>
         <p>Effective detection envelope at full Power with every fitted sensor intact.</p>
      </div>
      <span class="sensor-coverage-status">${hasInstalledSensors ? `${omni.length + directed.length} fitted` : "Hull array only"}</span>
    </div>
    <div class="sensor-coverage-readouts">
      <div><span>General range</span><strong>${escapeHtml(rangeLabel(omniRange))}</strong></div>
      <div><span>Directional maximum</span><strong>${directedMax > 0 ? escapeHtml(rangeLabel(directedMax)) : "None"}</strong></div>
    </div>
    <div class="sensor-coverage-plot-wrap">
      <svg class="sensor-coverage-plot" viewBox="0 0 260 226" role="img"
        aria-label="${escapeHtml(`General sensor range ${rangeLabel(omniRange)}${directedMax > 0 ? `, maximum directional range ${rangeLabel(directedMax)}` : ", no directional sensor fitted"}`)}">
        <defs>
          <radialGradient id="sensorOmniGradient">
            <stop offset="0%" stop-color="#22d3ee" stop-opacity=".25"></stop>
            <stop offset="70%" stop-color="#0ea5e9" stop-opacity=".12"></stop>
            <stop offset="100%" stop-color="#38bdf8" stop-opacity=".03"></stop>
          </radialGradient>
          <linearGradient id="sensorHullGradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#e0f2fe"></stop>
            <stop offset="100%" stop-color="#0891b2"></stop>
          </linearGradient>
        </defs>
        <g class="sensor-coverage-grid">
          ${ringMarkup}
          <line x1="${cx}" y1="${cy - chartRadius - 8}" x2="${cx}" y2="${cy + chartRadius}" class="sensor-coverage-axis"></line>
          <line x1="${cx - chartRadius}" y1="${cy}" x2="${cx + chartRadius}" y2="${cy}" class="sensor-coverage-axis"></line>
          <text x="${cx}" y="13" class="sensor-coverage-forward-label">FORWARD</text>
        </g>
        <circle class="sensor-coverage-omni" cx="${cx}" cy="${cy}" r="${omniRadius.toFixed(2)}"></circle>
        <circle class="sensor-coverage-base" cx="${cx}" cy="${cy}" r="${baseRadius.toFixed(2)}"></circle>
        ${coneMarkup}
        <g class="sensor-coverage-ship" transform="translate(${cx} ${cy})">
          <path d="M 0 -15 L 10 12 L 0 7 L -10 12 Z"></path>
          <circle cx="0" cy="1" r="3"></circle>
        </g>
      </svg>
      <div class="sensor-coverage-legend" aria-hidden="true">
        <span class="omni">General</span>
        <span class="directed">Directional</span>
        <span class="base">Hull baseline</span>
      </div>
    </div>
  </section>`;
}

function renderAnalysisPanels(stats, heat) {
  if (dom.dataAnalysisSummary) {
    // Data support reuses the Data Links presentation so the analysis tab and
    // the grid overlay describe the same prediction with the same cards.
    renderDataAnalysisPanel(dom.dataAnalysisSummary, { thermalAnalysis: heat });
  }

  const accelText = (value) => {
    const v = Number(value || 0);
    if (v <= 0) return "0";
    return v >= 1 ? `${Math.round(v)} m/s²` : `${v.toFixed(1)} m/s²`;
  };
  let marginalDelta = "N/A";
  if (state?.design && Array.isArray(state.design)) {
    try {
      const testStats = computeStats([...state.design, { x: -1, y: -1, type: "engine", rotation: 0 }]);
      const dSpeed = Math.round((testStats.maxSpeed || 0) - (stats.maxSpeed || 0));
      const dAccel = Math.round((testStats.accel || 0) - (stats.accel || 0));
      if (Number.isFinite(dSpeed) && Number.isFinite(dAccel) && testStats.mass > (stats.mass || 0)) {
        marginalDelta = `max ${dSpeed >= 0 ? '+' : ''}${dSpeed} m/s, accel ${dAccel >= 0 ? '+' : ''}${dAccel} m/s²`;
      }
    } catch (e) { /* ignore if the dummy placement cannot be computed */ }
  }
  const marginalImpact = marginalDelta.startsWith("max ")
    ? marginalDelta.replace(/^max /, "Top speed ").replace(", accel ", " / Acceleration ")
    : marginalDelta;
  const maxSpeed = Math.round(stats.maxSpeed || 0);
  const hasEffectiveThrust = Number(stats.effectiveThrust || 0) > 0;
  const powerShortfall = Number(currentPowerFlow()?.summary?.unmetDemandMw || 0) > 0.0005;
  const heatDeratedEngine = Number(heat?.analysis?.engineEfficiency ?? 1) < 0.999;
  const blockedEngines = Number(stats.blockedEngines || 0);
  const movementStatus = !hasEffectiveThrust
    ? "No thrust"
    : blockedEngines > 0
      ? `${blockedEngines} blocked engine${blockedEngines === 1 ? "" : "s"}`
      : powerShortfall
        ? "Power shortage"
        : heatDeratedEngine
          ? "Heat derated"
          : "";
  const movementStatusTone = movementStatus ? " is-warning" : "";
  const movementMetrics = [
    ["Acceleration", accelText(stats.accel)],
    ["Turn rate", turnText(stats)],
    ["Effective thrust", formatThrust(stats.effectiveThrust)],
    ["Thrust-to-mass", `${round2(stats.thrustRatio)} kN/T`]
  ];
  const movementMetricMarkup = movementMetrics.map(([label, value]) => `<div>
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(String(value))}</strong>
  </div>`).join("");
  const movementStatusMarkup = movementStatus
    ? `<span class="combat-movement-status${movementStatusTone}">${escapeHtml(movementStatus)}</span>`
    : "";
  if (dom.analysisMovementPanel) {
    dom.analysisMovementPanel.innerHTML = `<section class="analysis-summary-card combat-movement-card">
      <div class="combat-movement-heading">
        <div>
          <h3>Combat movement</h3>
          <p>Speed, handling and propulsion at full power.</p>
        </div>
        ${movementStatusMarkup}
      </div>
      <div class="movement-speed-hero">
        <div class="movement-speed-primary">
          <span>Top speed</span>
          <strong>${escapeHtml(formatSpeed(maxSpeed))}</strong>
        </div>
      </div>
      <div class="movement-section-heading">Handling &amp; propulsion</div>
      <div class="movement-metric-grid">${movementMetricMarkup}</div>
      <div class="movement-engine-impact">
        <span class="movement-engine-impact-icon" aria-hidden="true">+</span>
        <div>
          <span>Adding one engine</span>
          <strong>${escapeHtml(marginalImpact)}</strong>
        </div>
      </div>
    </section>${sensorCoverageMarkup(stats)}`;
  }

  renderFullLoadThermalPanel(heat);
}

function currentMatchMoney(mine) {
  return mine ? Number(mine.money) || 0 : state.rules.startingMoney;
}

// Toggle/Show tooltip on click
if (dom.stats && typeof dom.stats.addEventListener === "function") {
  dom.stats.addEventListener("click", (e) => {
    const card = e.target.closest(".stat");
    if (card) {
      e.stopPropagation();
      const key = card.dataset.statKey;
      if (!dom.statTooltip.hidden && dom.statTooltip.dataset.activeKey === key) {
        hideStatTooltip();
      } else {
        showStatTooltip(card, e);
        dom.statTooltip.dataset.activeKey = key;
      }
    }
  });

  dom.stats.addEventListener("keydown", (e) => {
    const card = e.target.closest(".stat");
    if (card && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      card.click();
    }
  });
}

// Close tooltip when clicking outside
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("click", (e) => {
    if (dom.statTooltip && !dom.statTooltip.hidden) {
      if (!e.target.closest(".stat") && !e.target.closest("#statTooltip")) {
        hideStatTooltip();
      }
    }
  });
}

function showStatTooltip(card, event) {
  if (!dom.statTooltip) return;
  const key = card.dataset.statKey;
  const stats = computeStats(state.design, { dataLinks: state.dataLinks });
  const markup = buildStatTooltipMarkup(key, stats);
  if (!markup) {
    dom.statTooltip.hidden = true;
    return;
  }
  dom.statTooltip.innerHTML = markup;
  dom.statTooltip.hidden = false;
  positionStatTooltip(event);
}

function positionStatTooltip(event) {
  if (!dom.statTooltip || dom.statTooltip.hidden) return;
  const margin = 14;
  const rect = dom.statTooltip.getBoundingClientRect();
  const sourceRect = event.currentTarget?.getBoundingClientRect?.();
  const pointerX = event.clientX || sourceRect?.left || window.innerWidth / 2;
  const pointerY = event.clientY || sourceRect?.top || window.innerHeight / 2;

  const left = Math.min(pointerX + 14, window.innerWidth - rect.width - margin);
  const top = Math.min(pointerY - rect.height - 12, window.innerHeight - rect.height - margin);

  dom.statTooltip.style.left = `${Math.max(margin, left)}px`;
  dom.statTooltip.style.top = `${Math.max(margin, top)}px`;
}

function hideStatTooltip() {
  if (dom.statTooltip) dom.statTooltip.hidden = true;
}

function formatTooltipText(text) {
  if (!text) return "";
  let html = escapeHtml(text);
  html = html.replace(/\bHP\b/g, '<span class="stat-unit hp">HP</span>');
  html = html.replace(/\bSP\b/g, '<span class="stat-unit sp">SP</span>');
  html = html.replace(/\bm\/s\b/g, '<span class="stat-unit speed">m/s</span>');
  html = html.replace(/\brad\/s\b/g, '<span class="stat-unit turn">rad/s</span>');
  html = html.replace(/\bdeg\/s\b/g, '<span class="stat-unit turn">deg/s</span>');
  html = html.replace(/\bMW\b/g, '<span class="stat-unit power">MW</span>');
  html = html.replace(/\bMJ\b/g, '<span class="stat-unit power">MJ</span>');
  html = html.replace(/\bkN\b/g, '<span class="stat-unit thrust">kN</span>');
  html = html.replace(/\bT\b/g, '<span class="stat-unit mass">T</span>');
  html = html.replace(/\b\$\b/g, '<span class="stat-unit money">$</span>');
  html = html.replace(/\bDPS\b/g, '<span class="stat-unit hp">DPS</span>');
  return html;
}

function buildStatTooltipMarkup(key, stats) {
  const data = buildStatTooltipData(key, stats);
  if (!data.label) return "";

  let html = `<div class="stat-tooltip-head"><strong>${escapeHtml(data.label)}</strong></div>`;
  html += `<div class="stat-tooltip-desc">${formatTooltipText(data.desc)}</div>`;

  if (data.formula) {
    html += `<div class="stat-tooltip-formula">${formatTooltipText(data.formula)}</div>`;
  }

  if (data.breakdown) {
    html += `<div class="stat-tooltip-breakdown">${formatTooltipText(data.breakdown)}</div>`;
  }

  return html;
}

function buildStatTooltipData(key, stats) {
  switch (key) {
    case "accel": {
      const acceleration = Number(stats.accel) || 0;
      return {
        label: "Acceleration",
        desc: "Acceleration shows how quickly the ship changes velocity.",
        breakdown: `Effective Thrust: ${stats.effectiveThrust} kN\nMass: ${stats.mass} T\nAcceleration: ${acceleration >= 1 ? Math.round(acceleration) : acceleration.toFixed(1)} m/s²`
      };
    }

    case "hull": {
      let coreHp = 0, armorHp = 0, frameHp = 0, weaponHp = 0, otherHp = 0;
      for (const m of state.design) {
        const part = PART_STATS[m.type] || PART_STATS.frame;
        if (m.type === "core") coreHp += part.hp;
        else if (m.type === "armor" || m.type === "compositeArmor") armorHp += part.hp;
        else if (m.type === "frame") frameHp += part.hp;
        else if (part.weapon) weaponHp += part.hp;
        else otherHp += part.hp;
      }
      return {
        label: "Hull Hit Points",
        desc: "Non-Core components use their listed Hull values directly and are summed into ship hull integrity. The main Core keeps its listed HP in a separate destroyable pool.",
        formula: "Ship Max HP = Sum(Non-Core listed Hull); Core HP is separate",
        breakdown: `Core: ${coreHp} HP
Armor: +${armorHp} HP
Frames: +${frameHp} HP
Weapons: +${weaponHp} HP
Other Systems: +${otherHp} HP
Non-Core Hull Sum: ${armorHp + frameHp + weaponHp + otherHp} HP
Final Hull HP: ${stats.maxHp} HP`
      };
    }

    case "shield":
      return {
        label: "Shield Buffers",
        desc: "Shield barrier capacity. Shields absorb 95% of incoming blocked damage, leaking 5% to the hull. Shield generators and batteries increase maximum Shield Capacity; Power affects regeneration, not maximum Shield Capacity. Blocked damage also heats the shield generators, and recharging generates heat : hot shield modules recharge slower.",
        formula: "Maximum Shield Capacity = Round(BaseShield)",
        breakdown: `Base Shield: ${stats.baseMaxShield ?? stats.maxShield} SP
Effective Shield SP: ${stats.maxShield} SP
Effective Shield Recharge: +${stats.shieldRegen}/s`
      };

    case "speed":
      return {
        label: "Top Speed",
        desc: "Maximum speed the ship can achieve when engines are fully engaged. Effective thrust already includes each engine's health, heat, and universal Power allocation before the continuous mass-drag curve is applied.",
        formula: `MaxSpeed = (${MOVEMENT_CONFIG.speed.base} + sqrt(EffectiveThrust) * ${MOVEMENT_CONFIG.speed.thrustSqrtScale}) * MassSpeedDrag`,
        breakdown: `Engine Thrust: ${stats.effectiveThrust} kN
Mass: ${stats.mass} T
Thrust/Mass Ratio: ${stats.thrustRatio.toFixed(2)} kN/T
Mass Speed Drag: ${stats.mass > 0 ? (1 / Math.pow(1 + stats.mass / MOVEMENT_CONFIG.speed.massDivisor, MOVEMENT_CONFIG.speed.massExponent)).toFixed(3) : "1.000"}
Movement consumer Power: ${Math.round((1 - (Number(stats.powerDebuff) || 0)) * 100)}%
Final Speed: ${Math.round(stats.maxSpeed)} m/s`
      };

    case "turn":
      return {
        label: "Hull Turn Rate",
        desc: "Directional hull turn rates. Uneven values indicate manoeuvre thrusters favour one turn direction; neither direction is automatically better. Turn authority is reduced continuously by mass. There is no class-based turn cap.",
        formula: `RawTurn = EffectiveTurnAuthority * ${MOVEMENT_CONFIG.turn.genericScale} * MassTurnPenalty\nTurnRate = RawTurn`,
        breakdown: `Reliable Turn: ${stats.turnRate.toFixed(2)} rad/s (${Math.round(stats.turnRate * (180 / Math.PI))} deg/s)\nLeft Turn: ${(stats.turnRateLeft ?? stats.turnRate).toFixed(2)} rad/s\nRight Turn: ${(stats.turnRateRight ?? stats.turnRate).toFixed(2)} rad/s
Mass Turn Penalty: ${(1 / Math.pow(1 + Math.max(1, Number(stats.mass) || 1) / MOVEMENT_CONFIG.turn.massDivisor, MOVEMENT_CONFIG.turn.massExponent)).toFixed(3)}`
      };

    case "power": {
      const flow = currentPowerFlow();
      const view = resolvePowerSummary(stats, flow, { design: state.design, partNames: PART_DEFS });

      const gen = view.availableGenerationMw ?? view.generationMw ?? view.generation ?? stats.powerGeneration;
      const demand = view.activeDemandMw ?? view.demandMw ?? view.requested ?? stats.powerUse;
      const delivered = view.allocatedMw ?? view.deliveredMw ?? view.delivered ?? Math.min(gen, demand);
      const unmet = view.unmetMw ?? view.unmet ?? Math.max(0, demand - delivered);
      const spare = unmet > 0.0005 ? 0 : (view.reachableSpareMw ?? view.spareMw ?? view.spare ?? Math.max(0, gen - demand));

      const fmtMw = (v) => `${(Math.round(Number(v || 0) * 10) / 10).toFixed(1)} MW`;

      let explanationText = "";
      if (view.explanation) {
        explanationText = view.explanation;
      } else if (unmet > 0.0005) {
        explanationText = `${fmtMw(unmet)} of component demand could not be supplied.`;
      } else {
        explanationText = "Power supply meets all component demand.";
      }

      const rows = [
        `Available generation: ${fmtMw(gen)}`,
        `Active demand: ${fmtMw(demand)}`,
        `Delivered: ${fmtMw(delivered)}`,
        `Unmet: ${fmtMw(unmet)}`,
        `Reachable spare: ${fmtMw(spare)}`
      ];
      return {
        label: "Reactor Power Balance",
        desc: "Power is supplied universally from the ship's total generation to its active component demand.",
        breakdown: `${rows.join("\n")}\n\n${explanationText}`
      };
    }

    case "thrust":
      return {
        label: "Total Engine Thrust",
        desc: "Total usable thrust is the sum of live engine output. Mass applies a continuous drag curve when that thrust becomes movement.",
        formula: "Linear Engine Sum",
        breakdown: `Raw Engine Sum: ${stats.thrust} kN
Effective Thrust: ${stats.effectiveThrust} kN`
      };

    case "engineEfficiency":
      return {
        label: "Engine Output Efficiency",
        desc: "Proportion of authored live engine output available after component state and Power allocation.",
        formula: "Efficiency = EffectiveThrust / RawThrust",
        breakdown: `Raw Engine Sum: ${stats.thrust} kN
Effective Thrust: ${stats.effectiveThrust} kN
Efficiency: ${Math.round(stats.engineEfficiency * 100)}%`
      };

    case "powerEfficiency": {
      const flow = currentPowerFlow();
       const view = resolvePowerSummary(stats, flow, { design: state.design, partNames: PART_DEFS });
      const gen = view.availableGenerationMw ?? view.generationMw ?? view.generation ?? stats.powerGeneration;
      const demand = view.activeDemandMw ?? view.demandMw ?? view.requested ?? stats.powerUse;
      const fmtMw = (v) => `${(Math.round(Number(v || 0) * 10) / 10).toFixed(1)} MW`;
      return {
        label: "Subsystem Power Efficiency",
        desc: "Energy grid output performance ratio. Low power capacity limits defense recharge rates.",
        formula: "Efficiency = Clamp(AvailableGeneration / ActiveDemand, 0, 1)",
        breakdown: `Available generation: ${fmtMw(gen)}\nActive demand: ${fmtMw(demand)}\nEfficiency: ${Math.round(stats.powerEfficiency * 100)}%`
      };
    }

    case "powerDebuff": {
      const flow = currentPowerFlow();
       const view = resolvePowerSummary(stats, flow, { design: state.design, partNames: PART_DEFS });
      const gen = view.availableGenerationMw ?? view.generationMw ?? view.generation ?? stats.powerGeneration;
      const demand = view.activeDemandMw ?? view.demandMw ?? view.requested ?? stats.powerUse;
      const fmtMw = (v) => `${(Math.round(Number(v || 0) * 10) / 10).toFixed(1)} MW`;
      const eff = Math.min(1, Number(stats.efficiency) || 1);
      const sysPenalty = Math.round((1 - eff) * 100);
      const movePenalty = Math.round((Number(stats.powerDebuff) || 0) * 100);
      const deficit = demand > gen + 0.0005;
      return {
        label: "Power Penalty",
        desc: deficit
          ? "Reactor output is below demand, so power-hungry systems run under-powered and lose effectiveness. Add reactors/batteries or cut power use to clear it."
          : "Power supply meets demand : no systems are being throttled.",
        formula: "Under-power scales each system down toward the generation / demand ratio.",
        breakdown: deficit
          ? `Available generation: ${fmtMw(gen)} vs Active demand: ${fmtMw(demand)}
Weapon damage: -${sysPenalty}%
Shield capacity & regen: -${sysPenalty}%
Repair rate: -${sysPenalty}%
Powered movement component output: -${movePenalty}%
Fire rate: unaffected by power (only reduced by overheating)`
          : "All systems at full effectiveness."
      };
    }

    case "thrustRatio":
      return {
        label: "Thrust-to-Mass ratio",
        desc: "Acceleration potential index. Higher numbers allow you to change directions and escape hazards faster.",
        formula: "ThrustRatio = EffectiveThrust / Mass",
        breakdown: `Effective Thrust: ${stats.effectiveThrust} kN
Mass: ${stats.mass} T
Acceleration index: ${stats.thrustRatio.toFixed(2)} kN/T`
      };

    case "weapons": {
      const weaponsCount = stats.blaster + stats.missile + stats.railgun + (stats.beam || 0) + (stats.emp || 0);
      const desc = `${stats.blaster} Blaster(s) / ${stats.missile} Missile(s) / ${stats.railgun} Railgun(s)` + (stats.beam ? ` / ${stats.beam} Beam(s)` : "") + (stats.emp ? ` / ${stats.emp} EMP Cannon(s)` : "");
      const dpsLabel = stats.weaponDpsLabel || "Weapon DPS";
      return {
        label: "Weapons loadout",
        desc: "Ship offensive weapon summary. More active weapons increase direct combat DPS but add mass, cost, and power use.",
        formula: dpsLabel === "Weapon DPS" ? "DPS = Base Weapon DPS Sum" : `${dpsLabel} = Base Weapon Cycle Sum`,
        breakdown: `Active Guns: ${weaponsCount}
Summary: ${desc}
Total ${dpsLabel}: ${stats.weaponDps}`
      };
    }

    case "capture":
      return {
        label: "Lobby Capture Pressure",
        desc: "objective control zone capture rate speedup.",
        formula: "Capture rate = Base + Sum of Capture modules",
        breakdown: `Zone Capture rate: +${Math.round(stats.captureBonus * 100)}%`
      };

    case "repair": {
      const sourceCount = Number(stats.selfRepairSourceCount ?? stats.repairRateSourceCount ?? 0);
      const selfRepair = Number(stats.selfRepairRate ?? stats.repairRate ?? 0) || 0;
      const repairBeamOutput = Number(stats.repairBeamOutput ?? stats.repairBeamRate ?? 0) || 0;
      const multiplier = getRepairStackingMultiplier(GENERATED_BALANCE);
      const lines = [];
      if (selfRepair > 0) lines.push(`Self Repair: ${selfRepair.toFixed(1)} HP/s`);
      if (repairBeamOutput > 0) lines.push(`Repair Beam Output: ${repairBeamOutput.toFixed(1)} HP/s`);
      if (sourceCount > 1) lines.push(`Local stacking progression: ${stackingProgression(sourceCount, GENERATED_BALANCE).join(", ")}`);
      return {
        label: "Repair Output",
        desc: "Self Repair restores this ship. Repair Beams project linear output to allied ships. Neither restores shield capacity.",
        formula: sourceCount > 1
          ? `Self Repair diminishing returns (${Math.round(multiplier * 100)}% stack factor)`
          : repairBeamOutput > 0 ? "Repair Beam Output: linear sum" : "Self Repair: single-source output",
        breakdown: lines.join("\n") || "No active repair output"
      };
    }

    case "mass": {
      let structMass = 0, weaponMass = 0, engineMass = 0, powerMass = 0, otherMass = 0;
      for (const m of state.design) {
        const part = PART_STATS[m.type] || PART_STATS.frame;
        if (part.category === "Structure") structMass += part.mass;
        else if (part.category === "Weapons") weaponMass += part.mass;
        else if (part.category === "Engines") engineMass += part.mass;
        else if (part.category === "Power" || part.category === "Defence") powerMass += part.mass;
        else otherMass += part.mass;
      }
      return {
        label: "Blueprint Ship Mass",
        desc: "Total mass weight in tonnes. Heavier ships survive longer but turn and accelerate slower.",
        formula: "Mass = Sum of module masses",
        breakdown: `Structure: ${structMass} T
Weapons: ${weaponMass} T
Engines: ${engineMass} T
Systems / Defence: ${powerMass} T
Other modules: ${otherMass} T
Total Mass: ${stats.mass} T`
      };
    }

    default:
      return { label: "", desc: "", formula: "", breakdown: "" };
  }
}

const DIAGNOSTIC_LEVELS = new Set(["neutral", "good", "warning", "bad"]);

function diagnostic(status = "neutral") {
  return DIAGNOSTIC_LEVELS.has(status) ? status : "neutral";
}

function statMarkup(key, label, value, diagnosticStatus = "neutral", hint = "") {
  const status = diagnostic(diagnosticStatus);
  const diagnosticText = status === "neutral" ? "" : ` ${status}`;
  const textValue = typeof value === "object" && value ? value.text : String(value);
  const htmlValue = typeof value === "object" && value?.html ? value.html : escapeHtml(textValue);
  const hintText = hint ? String(hint) : "";
  return `
    <div class="stat stat-${status}" role="listitem" tabindex="0" data-stat-key="${escapeHtml(key)}" data-stat-label="${escapeHtml(label)}" data-stat-value="${escapeHtml(textValue)}" data-stat-diagnostic="${escapeHtml(status)}" aria-label="${escapeHtml(`${label}: ${textValue}${hintText ? `. ${hintText}` : ""}${diagnosticText}`)}">
      <span>${escapeHtml(label)}</span>
      <strong>${htmlValue}</strong>
      ${hintText ? `<small class="stat-hint">${escapeHtml(hintText)}</small>` : ""}
    </div>
  `;
}
