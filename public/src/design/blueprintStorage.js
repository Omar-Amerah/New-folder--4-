// Handles localStorage persistence, blueprint validation wrappers, default designs, and formatting migrations.

import { LOCAL_DESIGN_KEY, LOCAL_SAVED_DESIGNS_KEY, LOCAL_LOADOUTS_KEY } from "../constants.js";
import { PART_DEFS, PART_STATS, isRotatablePart } from "./parts.js";
import { maneuverThrusterAutoRotation, normalizeRotation } from "./rotation.js";
import { isConnected, isOutOfBounds, isOverlapping } from "./blueprintValidation.js";
import { getOccupiedCells } from "./footprint.js";

export function defaultDesign() {
  return [
    { x: 7, y: 7, type: "core" },
    { x: 7, y: 8, type: "frame" },
    { x: 6, y: 8, type: "engine" },
    { x: 8, y: 8, type: "engine" },
    { x: 6, y: 7, type: "blaster" },
    { x: 8, y: 7, type: "blaster" },
    // Side maneuvering thrusters: main engines no longer turn the ship, so the
    // starting design needs off-centre thrusters to steer.
    { x: 5, y: 7, type: "maneuverThruster" },
    { x: 9, y: 7, type: "maneuverThruster" },
    { x: 7, y: 6, type: "shield" },
    { x: 6, y: 6, type: "armor" },
    { x: 8, y: 6, type: "armor" },
    { x: 7, y: 9, type: "battery" }
  ];
}

export function makeDesignPart(x, y, type, previousRotation = 0) {
  const rotation = type === "maneuverThruster"
    ? maneuverThrusterAutoRotation(x)
    : isRotatablePart(type) ? normalizeRotation(previousRotation) : 0;
  return { x, y, type, rotation };
}

export function normalizeDesign(input) {
  const fallback = defaultDesign();
  const source = Array.isArray(input) ? input : fallback;

  // If this is an old blueprint centered on 3,3 (core at 3,3), shift it by +4,+4 to center it in 15x15.
  const oldCore = source.find(p => p && p.type === "core" && Math.trunc(Number(p.x)) === 3 && Math.trunc(Number(p.y)) === 3);
  const offsetX = oldCore ? 4 : 0;
  const offsetY = oldCore ? 4 : 0;

  const occupied = new Set();
  const clean = [];

  for (const raw of source) {
    const x = Math.trunc(Number(raw?.x)) + offsetX;
    const y = Math.trunc(Number(raw?.y)) + offsetY;
    const type = String(raw?.type || "");

    if (x < 0 || x > 14 || y < 0 || y > 14 || !PART_DEFS[type]) continue;

    const newPart = makeDesignPart(x, y, type, raw?.rotation);
    const stat = PART_STATS[type] || PART_STATS.frame;
    const footprint = stat.footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(x, y, footprint, newPart.rotation);

    let overlap = false;
    let outOfBounds = false;
    for (const cell of cells) {
      if (cell.x < 0 || cell.x > 14 || cell.y < 0 || cell.y > 14) outOfBounds = true;
      if (occupied.has(`${cell.x},${cell.y}`)) overlap = true;
    }

    if (overlap || outOfBounds) continue;

    for (const cell of cells) {
      occupied.add(`${cell.x},${cell.y}`);
    }

    clean.push(newPart);
  }

  if (clean.filter((part) => part.type === "core").length !== 1 || !isConnected(clean)) return fallback;
  return clean;
}

export function loadDesign() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_DESIGN_KEY) || "null");
    if (saved && !Array.isArray(saved) && Array.isArray(saved.modules)) {
      return {
        modules: normalizeDesign(saved.modules),
        combatStyle: saved.combatStyle || "sentry"
      };
    }
    return {
      modules: normalizeDesign(saved),
      combatStyle: "sentry"
    };
  } catch {
    return {
      modules: normalizeDesign(null),
      combatStyle: "sentry"
    };
  }
}

export function persistDesign(design, combatStyle = "sentry") {
  localStorage.setItem(LOCAL_DESIGN_KEY, JSON.stringify({ modules: design, combatStyle }));
}

export function loadSavedDesigns() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_SAVED_DESIGNS_KEY) || "[]");
    if (!Array.isArray(saved)) return [];
    return saved.map((design, index) => ({
      id: String(design.id || `saved-${index}`),
      name: String(design.name || `Design ${index + 1}`).slice(0, 28),
      blueprint: normalizeDesign(design.blueprint),
      combatStyle: design.combatStyle || "sentry",
      cost: Number(design.cost) || 0,
      weapons: String(design.weapons || "0/0/0"),
      speed: Number(design.speed) || 0,
      createdAt: Number(design.createdAt) || Date.now(),
      updatedAt: Number(design.updatedAt) || Date.now()
    })).slice(0, 12);
  } catch {
    return [];
  }
}

export function persistSavedDesigns(savedDesigns) {
  localStorage.setItem(LOCAL_SAVED_DESIGNS_KEY, JSON.stringify(savedDesigns.slice(0, 12)));
}

// Loadouts are named tabs in the purchase bar, each a curated list of saved-design
// ids. The implicit "All" tab is not stored; only user-created loadouts persist.
export function loadLoadouts() {
  try {
    const stored = JSON.parse(localStorage.getItem(LOCAL_LOADOUTS_KEY) || "[]");
    if (!Array.isArray(stored)) return [];
    return stored.slice(0, 8).map((lo, index) => ({
      id: String(lo.id || `loadout-${index}`),
      name: String(lo.name || `Loadout ${index + 1}`).slice(0, 20),
      designIds: Array.isArray(lo.designIds) ? lo.designIds.map(String).slice(0, 12) : []
    }));
  } catch {
    return [];
  }
}

export function persistLoadouts(loadouts) {
  localStorage.setItem(LOCAL_LOADOUTS_KEY, JSON.stringify(loadouts.slice(0, 8)));
}
