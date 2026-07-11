// Selected-ship damage panel: a compact blueprint-style diagram coloured by
// component status, a hover readout (name, hp, status), the recent-damage feed,
// and core warnings. Everything renders from the client-side ship/component
// state already received — no extra server traffic or state.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { PART_STATS } from "../design/parts.js";
import { getOccupiedCells } from "../design/footprint.js";
import {
  componentMaxFromShip,
  partDisplayName,
  recentDamageFeed,
  activeCoreWarning,
  CRITICAL_RATIO,
  DAMAGED_RATIO
} from "../game/componentDamage.js";

const STATUS_COLORS = {
  healthy: "#3f4c60",
  damaged: "#fbb040",
  critical: "#ef4444",
  destroyed: "#2a2e35"
};

let bound = false;
let hoverContext = null; // { cellMap, ship, cellSize, offsetX, offsetY }

function statusFor(ratio) {
  if (ratio <= 0) return "destroyed";
  if (ratio <= CRITICAL_RATIO) return "critical";
  if (ratio < DAMAGED_RATIO) return "damaged";
  return "healthy";
}

function statusLabel(status) {
  if (status === "healthy") return "Operational";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function selectedSingleShip() {
  if (state.selectedShipIds.size !== 1) return null;
  const [id] = state.selectedShipIds;
  const ship = state.snapshot?.ships?.find((candidate) => candidate.id === id);
  if (!ship || !ship.design || !ship.chp) return null;
  return ship;
}

function bindOnce() {
  if (bound) return;
  bound = true;
  const canvas = dom.shipDamageCanvas;
  if (canvas) {
    canvas.addEventListener("mousemove", handleDiagramHover);
    canvas.addEventListener("mouseleave", () => {
      if (dom.shipDamageHover) dom.shipDamageHover.textContent = "Hover a component";
    });
  }
  if (dom.damageViewToggle) {
    dom.damageViewToggle.addEventListener("click", () => {
      state.componentDamageView = !state.componentDamageView;
      renderShipDamagePanel();
    });
  }
}

function handleDiagramHover(event) {
  if (!hoverContext || !dom.shipDamageHover) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (event.currentTarget.width / rect.width);
  const y = (event.clientY - rect.top) * (event.currentTarget.height / rect.height);
  const cellX = Math.floor((x - hoverContext.offsetX) / hoverContext.cellSize);
  const cellY = Math.floor((y - hoverContext.offsetY) / hoverContext.cellSize);
  const index = hoverContext.cellMap.get(`${cellX},${cellY}`);
  if (index === undefined) {
    dom.shipDamageHover.textContent = "Hover a component";
    return;
  }
  const ship = hoverContext.ship;
  const part = ship.design[index];
  const max = componentMaxFromShip(ship, index);
  const hp = ship.chp[index] ?? 0;
  const status = statusFor(max > 0 ? hp / max : 0);
  dom.shipDamageHover.textContent = `${partDisplayName(part.type)} — ${Math.max(0, Math.round(hp))}/${Math.round(max)} — ${statusLabel(status)}`;
}

function drawDiagram(ship) {
  const canvas = dom.shipDamageCanvas;
  const drawCtx = canvas?.getContext("2d");
  if (!drawCtx) return;
  drawCtx.clearRect(0, 0, canvas.width, canvas.height);

  // Collect occupied cells per component and the design's bounding box.
  const cellMap = new Map();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  ship.design.forEach((part, i) => {
    const footprint = PART_STATS[part.type]?.footprint || { width: 1, height: 1 };
    for (const cell of getOccupiedCells(part.x, part.y, footprint, part.rotation || 0)) {
      cellMap.set(`${cell.x},${cell.y}`, i);
      if (cell.x < minX) minX = cell.x;
      if (cell.y < minY) minY = cell.y;
      if (cell.x > maxX) maxX = cell.x;
      if (cell.y > maxY) maxY = cell.y;
    }
  });
  const cols = maxX - minX + 1;
  const rows = maxY - minY + 1;
  const cellSize = Math.floor(Math.min(canvas.width / cols, canvas.height / rows));
  const offsetX = Math.floor((canvas.width - cols * cellSize) / 2);
  const offsetY = Math.floor((canvas.height - rows * cellSize) / 2);

  // Remap cells to diagram space for hover lookups.
  const diagramCells = new Map();
  for (const [key, index] of cellMap) {
    const [x, y] = key.split(",").map(Number);
    diagramCells.set(`${x - minX},${y - minY}`, index);
  }
  hoverContext = { cellMap: diagramCells, ship, cellSize, offsetX, offsetY };

  for (const [key, index] of diagramCells) {
    const [cx, cy] = key.split(",").map(Number);
    const max = componentMaxFromShip(ship, index);
    const ratio = max > 0 ? (ship.chp[index] ?? 0) / max : 0;
    const status = statusFor(ratio);
    const px = offsetX + cx * cellSize;
    const py = offsetY + cy * cellSize;
    drawCtx.fillStyle = STATUS_COLORS[status];
    drawCtx.fillRect(px + 1, py + 1, cellSize - 2, cellSize - 2);
    if (status === "destroyed") {
      drawCtx.strokeStyle = "rgba(0,0,0,0.7)";
      drawCtx.lineWidth = 1;
      drawCtx.beginPath();
      drawCtx.moveTo(px + 2, py + 2);
      drawCtx.lineTo(px + cellSize - 2, py + cellSize - 2);
      drawCtx.moveTo(px + cellSize - 2, py + 2);
      drawCtx.lineTo(px + 2, py + cellSize - 2);
      drawCtx.stroke();
    }
    if (ship.design[index].type === "core") {
      drawCtx.strokeStyle = "#8fd8ff";
      drawCtx.lineWidth = Math.max(1.5, cellSize * 0.12);
      drawCtx.strokeRect(px + 1.5, py + 1.5, cellSize - 3, cellSize - 3);
    }
  }
}

function renderCoreStatus(ship) {
  const label = dom.coreStatusLabel;
  if (!label) return;
  const coreIndex = ship.design.findIndex((part) => part.type === "core");
  const coreMax = coreIndex >= 0 ? componentMaxFromShip(ship, coreIndex) : 0;
  const coreHp = coreIndex >= 0 ? ship.chp[coreIndex] ?? 0 : 0;
  const warning = activeCoreWarning(ship.id, performance.now());

  let text = "";
  let tone = "";
  if (!ship.alive || coreHp <= 0) {
    text = "SHIP LOST";
    tone = "destroyed";
  } else if (coreMax > 0 && coreHp / coreMax <= CRITICAL_RATIO) {
    text = "CORE CRITICAL";
    tone = "critical";
  } else if (warning) {
    text = warning.text;
    tone = warning.text === "CORE EXPOSED" ? "exposed" : "critical";
  }

  label.hidden = !text;
  if (text) {
    label.textContent = text;
    label.dataset.tone = tone;
  }
}

function renderFeed(ship) {
  const list = dom.damageFeed;
  if (!list) return;
  const entries = recentDamageFeed(ship.id, performance.now());
  const html = entries
    .map((entry) => `<li class="damage-feed-${entry.tone}">${entry.text}</li>`)
    .reverse()
    .join("");
  if (list.dataset.rendered !== html) {
    list.dataset.rendered = html;
    list.innerHTML = html;
  }
}

export function renderShipDamagePanel() {
  const panel = dom.shipDamagePanel;
  if (!panel) return;
  bindOnce();

  if (dom.damageViewToggle) {
    dom.damageViewToggle.classList.toggle("active", Boolean(state.componentDamageView));
  }

  const ship = selectedSingleShip();
  if (!ship) {
    if (!panel.hidden) panel.hidden = true;
    hoverContext = null;
    return;
  }
  panel.hidden = false;
  drawDiagram(ship);
  renderCoreStatus(ship);
  renderFeed(ship);
}
