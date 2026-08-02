// Inspection panel for the station selected in the arena (station
// infrastructure mode only).
//
// Stations are not commandable, so this panel is read-only: vitals, operational
// state, what the home station's launch bays are building, and the queue behind it.
// The panel stays hidden entirely in Classic rooms, where no station exists.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { selectedStation } from "../game/selection.js";
import { centerCameraOnPoint } from "../game/camera.js";
import {
  brightenShieldColor,
  hullColorForRatio,
  shieldColorForRatio
} from "../game/shipVitals.js";

const STATE_LABELS = {
  operational: "Operational",
  destroyed: "Destroyed",
  neutral: "Unclaimed",
  controlled: "Controlled"
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

function colorHex(value) {
  return `#${Math.max(0, Math.min(0xffffff, Number(value) || 0)).toString(16).padStart(6, "0")}`;
}

function meterPalette(kind, value, max) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  if (kind === "shield") {
    const base = shieldColorForRatio(ratio);
    return { start: colorHex(base), end: colorHex(brightenShieldColor(base, 0.34)) };
  }
  return hullColorForRatio(ratio);
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

function renderMeter(label, value, max, kind) {
  const ratio = percent(value, max);
  const palette = meterPalette(kind, value, max);
  return `
    <div class="station-meter station-meter-${kind}" style="--station-meter-start:${palette.start};--station-meter-end:${palette.end}" aria-label="${escapeHtml(label)} ${ratio}%">
      <span class="station-meter-label">${escapeHtml(label)}</span>
      <span class="station-meter-track"><i style="width:${ratio}%"></i></span>
      <span class="station-meter-value"><strong>${Math.round(value)}</strong><small>/ ${Math.round(max)}</small></span>
    </div>
  `;
}

function renderProductionQueue(station) {
  const queue = Array.isArray(station.productionQueue) ? station.productionQueue : [];
  if (queue.length === 0) return `<p class="station-empty">Launch bays idle — nothing in production.</p>`;
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

// Your own home station is where every purchase you make is built, so it is the
// panel's default subject: in station mode the launch bays are visible from the moment
// the match starts, without having to find and click the structure first.
export function ownHomeStation() {
  const myTeam = state.mine?.team;
  return (state.snapshot?.stations || []).find((station) => (
    station.stationType === "home"
    && (station.ownerId === state.myId || (myTeam && station.team === myTeam))
  )) || null;
}

// The station this panel is describing: an explicit click always wins, and the
// home station fills in otherwise.
export function panelStation() {
  if (state.rules?.infrastructureMode !== "stations") return null;
  return selectedStation() || ownHomeStation();
}

export function focusPanelStation() {
  const station = panelStation();
  if (!station) return;
  state.camera.follow = false;
  centerCameraOnPoint({ x: station.x, y: station.y }, 0.35);
}

export function renderStationPanel() {
  const panel = dom.stationPanel;
  if (!panel) return;
  const station = panelStation();
  if (!station) {
    if (!panel.hidden) {
      panel.hidden = true;
      if (dom.stationPanelBody) dom.stationPanelBody.innerHTML = "";
    }
    return;
  }
  panel.hidden = false;
  const mine = station.stationType === "home" && station.id === ownHomeStation()?.id;
  if (dom.stationPanelKind) {
    dom.stationPanelKind.textContent = station.stationType === "home"
      ? (mine ? "Your Home Station" : "Home Station")
      : "Relay Station";
  }
  if (!dom.stationPanelBody) return;

  const stateLabel = STATE_LABELS[station.state] || station.state;
  const ownerTone = station.team === "blue" ? "blue" : (station.team === "red" ? "red" : "neutral");
  const sections = [
    `<div class="station-overview">
      <dl class="station-summary">
       <div class="station-summary-row"><dt>Status</dt><dd class="station-status station-status-${escapeHtml(station.state)}">${escapeHtml(stateLabel)}</dd></div>
       <div class="station-summary-row"><dt>Controlled by</dt><dd class="station-owner station-owner-${ownerTone}">${escapeHtml(ownerLabel(station))}</dd></div>
      </dl>
      <div class="station-vitals">
        ${renderMeter("Hull", Number(station.hp) || 0, Number(station.maxHp) || 0, "hull")}
        ${Number(station.maxShield) > 0 ? renderMeter("Shield", Number(station.shield) || 0, Number(station.maxShield) || 0, "shield") : ""}
      </div>
    </div>`
  ];
  if (station.stationType === "home") {
    sections.push(`<div class="station-subhead"><h3>Launch Bays</h3></div>`);
    sections.push(renderProductionQueue(station));
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
