// Handles localStorage persistence, blueprint validation wrappers, default designs, and formatting migrations.

import { LOCAL_DESIGN_KEY, LOCAL_SAVED_DESIGNS_KEY } from "../constants.js";
import { PART_DEFS, isRotatablePart } from "./parts.js";
import { normalizeRotation } from "./rotation.js";
import { isConnected } from "./blueprintValidation.js";

export function defaultDesign() {
  return [
    { x: 7, y: 7, type: "core" },
    { x: 7, y: 8, type: "reactor" },
    { x: 6, y: 8, type: "engine" },
    { x: 8, y: 8, type: "engine" },
    { x: 6, y: 7, type: "blaster" },
    { x: 8, y: 7, type: "blaster" },
    { x: 7, y: 6, type: "shield" },
    { x: 6, y: 6, type: "armor" },
    { x: 8, y: 6, type: "armor" },
    { x: 7, y: 9, type: "battery" }
  ];
}

export function makeDesignPart(x, y, type, previousRotation = 0) {
  const rotation = isRotatablePart(type) ? normalizeRotation(previousRotation) : 0;
  return { x, y, type, rotation };
}

export function normalizeDesign(input) {
  const fallback = defaultDesign();
  const source = Array.isArray(input) ? input : fallback;

  // If this is an old blueprint centered on 3,3 (core at 3,3), shift it by +4,+4 to center it in 15x15.
  const oldCore = source.find(p => p && p.type === "core" && Math.trunc(Number(p.x)) === 3 && Math.trunc(Number(p.y)) === 3);
  const offsetX = oldCore ? 4 : 0;
  const offsetY = oldCore ? 4 : 0;

  const seen = new Set();
  const clean = [];

  for (const raw of source) {
    const x = Math.trunc(Number(raw?.x)) + offsetX;
    const y = Math.trunc(Number(raw?.y)) + offsetY;
    const type = String(raw?.type || "");
    const key = `${x},${y}`;
    if (x < 0 || x > 14 || y < 0 || y > 14 || !PART_DEFS[type] || seen.has(key)) continue;
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
