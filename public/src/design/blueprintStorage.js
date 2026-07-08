// Handles localStorage persistence, blueprint validation wrappers, default designs, and formatting migrations.

import { LOCAL_DESIGN_KEY, LOCAL_SAVED_DESIGNS_KEY } from "../constants.js";
import { PART_DEFS, isRotatablePart } from "./parts.js";
import { normalizeRotation } from "./rotation.js";
import { isConnected } from "./blueprintValidation.js";

export function defaultDesign() {
  return [
    { x: 3, y: 3, type: "core" },
    { x: 3, y: 4, type: "reactor" },
    { x: 2, y: 4, type: "engine" },
    { x: 4, y: 4, type: "engine" },
    { x: 2, y: 3, type: "blaster" },
    { x: 4, y: 3, type: "blaster" },
    { x: 3, y: 2, type: "shield" },
    { x: 2, y: 2, type: "armor" },
    { x: 4, y: 2, type: "armor" },
    { x: 3, y: 5, type: "battery" }
  ];
}

export function makeDesignPart(x, y, type, previousRotation = 0) {
  const rotation = isRotatablePart(type) ? normalizeRotation(previousRotation) : 0;
  return { x, y, type, rotation };
}

export function normalizeDesign(input) {
  const fallback = defaultDesign();
  const source = Array.isArray(input) ? input : fallback;
  const seen = new Set();
  const clean = [];

  for (const raw of source) {
    const x = Math.trunc(Number(raw?.x));
    const y = Math.trunc(Number(raw?.y));
    const type = String(raw?.type || "");
    const key = `${x},${y}`;
    if (x < 0 || x > 6 || y < 0 || y > 6 || !PART_DEFS[type] || seen.has(key)) continue;
    seen.add(key);
    clean.push(makeDesignPart(x, y, type, raw?.rotation));
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
        combatStyle: saved.combatStyle || "charge"
      };
    }
    return {
      modules: normalizeDesign(saved),
      combatStyle: "charge"
    };
  } catch {
    return {
      modules: normalizeDesign(null),
      combatStyle: "charge"
    };
  }
}

export function persistDesign(design, combatStyle = "charge") {
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
      combatStyle: design.combatStyle || "charge",
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
