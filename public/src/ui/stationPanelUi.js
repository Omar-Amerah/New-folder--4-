// Inspection panel for the station selected in the arena (station
// infrastructure mode only).
//
// Stations are not commandable, so this panel is read-only: vitals, operational
// state, what the home station's hangar is building, and the queue behind it.
// The panel stays hidden entirely in Classic rooms, where no station exists.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { selectedStation } from "../game/selection.js";

const STATE_LABELS = {
  operational: "Operational",
  disabled: "Disabled",
  neutral: "Unclaimed"
};

const QUEUE_STATE_LABELS = {
  queued: "Queued",
  building: "Building",
  "complete-waiting-launch": "Awaiting launch"
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
  ));
}

function percent(value, max) {
  if (!(max > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}

function playerName(playerId) {
  if (!playerId) return "Unknown";
  if (playerId === state.myId) return "You";
  const player = state.snapshot?.players?.find((entry) => entry.id === playerId);
  return player?.name || "Unknown";
}

function ownerLabel(station) {
  if (station.state === "neutral") return "Unclaimed";
  if (station.ownerId) return playerName(station.ownerId);
  if (station.team) {
    const teamPlayer = state.snapshot?.players?.find((entry) => entry.team === station.team);
    return teamPlayer?.teamName || station.team;
  }
  return "Unclaimed";
}

function renderMeter(label, value, max, className) {
  const ratio = percent(value, max);
  return `
    <div class="station-meter ${className}">
      <span class="station-meter-label">${escapeHtml(label)}</span>
      <span class="station-meter-track"><i style="width:${ratio}%"></i></span>
      <span class="station-meter-value">${Math.round(value)} / ${Math.round(max)}</span>
    </div>
  `;
}

function renderProductionQueue(station) {
  const queue = Array.isArray(station.productionQueue) ? station.productionQueue : [];
  if (queue.length === 0) {
    return `<p class="station-empty">Hangar idle. Purchases are built here and launched down the corridor.</p>`;
  }
  const rows = queue.map((item, index) => {
    const stateLabel = QUEUE_STATE_LABELS[item.state] || item.state;
    const progress = Math.round(Math.max(0, Math.min(1, Number(item.progress) || 0)) * 100);
    const quantity = Math.max(1, Number(item.quantityRemaining) || 1);
    const mine = item.playerId === state.myId;
    return `
      <li class="station-queue-item${mine ? " station-queue-mine" : ""}${index === 0 ? " station-queue-active" : ""}">
        <span class="station-queue-owner">${escapeHtml(playerName(item.playerId))}</span>
        <span class="station-queue-state">${escapeHtml(stateLabel)}${quantity > 1 ? ` &times;${quantity}` : ""}</span>
        <span class="station-queue-track"><i style="width:${progress}%"></i></span>
        <span class="station-queue-progress">${progress}%</span>
      </li>
    `;
  }).join("");
  return `<ul class="station-queue">${rows}</ul>`;
}

export function renderStationPanel() {
  const panel = dom.stationPanel;
  if (!panel) return;
  const station = state.rules?.infrastructureMode === "stations" ? selectedStation() : null;
  if (!station) {
    if (!panel.hidden) {
      panel.hidden = true;
      if (dom.stationPanelBody) dom.stationPanelBody.innerHTML = "";
    }
    return;
  }
  panel.hidden = false;
  if (dom.stationPanelKind) {
    dom.stationPanelKind.textContent = station.stationType === "home" ? "Home Station" : "Relay Station";
  }
  if (!dom.stationPanelBody) return;

  const stateLabel = STATE_LABELS[station.state] || station.state;
  const sections = [
    `<dl class="station-summary">
       <div class="station-summary-row"><dt>Status</dt><dd class="station-status station-status-${escapeHtml(station.state)}">${escapeHtml(stateLabel)}</dd></div>
       <div class="station-summary-row"><dt>Controlled by</dt><dd>${escapeHtml(ownerLabel(station))}</dd></div>
     </dl>`,
    renderMeter("Hull", Number(station.hp) || 0, Number(station.maxHp) || 0, "station-meter-hull")
  ];
  if (Number(station.maxShield) > 0) {
    sections.push(renderMeter("Shield", Number(station.shield) || 0, Number(station.maxShield) || 0, "station-meter-shield"));
  }
  if (station.stationType === "home") {
    sections.push(`<div class="section-heading compact"><h3>Production</h3></div>`);
    sections.push(renderProductionQueue(station));
  } else if (station.state === "neutral") {
    sections.push(`<p class="station-empty">Bring ships inside the capture ring to claim this relay.</p>`);
  }
  if (station.state === "disabled") {
    sections.push(`<p class="station-empty">Disabled stations self-repair once they stop taking fire, then come back online.</p>`);
  }

  const html = sections.join("");
  if (dom.stationPanelBody.innerHTML !== html) {
    dom.stationPanelBody.innerHTML = html;
    const diagnostics = state.presentationDiagnostics;
    if (diagnostics) diagnostics.stationPanelUpdateCount = (diagnostics.stationPanelUpdateCount || 0) + 1;
  }
}

export function updateStationPanel() {
  renderStationPanel();
}
