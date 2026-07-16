// Handles localStorage persistence, blueprint validation wrappers, default designs, and versioned storage migrations.

import { LOCAL_DESIGN_KEY, LOCAL_DESIGN_BACKUP_KEY, LOCAL_SAVED_DESIGNS_KEY, LOCAL_LOADOUTS_KEY } from "../constants.js";
import { PART_DEFS, PART_STATS, isRotatablePart } from "./parts.js";
import { maneuverThrusterAutoRotation, normalizeRotation } from "./rotation.js";
import { validateBlueprint } from "./blueprintValidation.js";
import { getOccupiedCells } from "./footprint.js";
import { computeStats } from "./componentStats.js";

export const BLUEPRINT_STORAGE_VERSION = 1;
export const MAX_SAVED_DESIGNS = 12;
export const MAX_LOADOUTS = 8;

export function defaultDesign() {
  return [
    { x: 7, y: 7, type: "core" },

    { x: 6, y: 5, type: "armor" },
    { x: 7, y: 5, type: "armor" },
    { x: 8, y: 5, type: "compositeArmor" },

    { x: 5, y: 6, type: "radiator" },
    { x: 6, y: 6, type: "reactor", rotation: 90 },
    { x: 7, y: 6, type: "shield" },
    { x: 8, y: 6, type: "missile", rotation: 0 },

    { x: 5, y: 7, type: "shield" },
    { x: 8, y: 7, type: "gyroscope" },
    { x: 9, y: 7, type: "frame" },

    { x: 6, y: 8, type: "auxGenerator" },
    { x: 7, y: 8, type: "frame" },

    { x: 7, y: 9, type: "engine" }
  ];
}
function nowIso() { return new Date().toISOString(); }
function safeStyle(value, fallback = "sentry") { return ["charge", "circle", "sentry", "hold"].includes(value) ? value : fallback; }
function storage() {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return null;
    return localStorage;
  } catch { return null; }
}
function readJson(key, fallback) {
  const s = storage();
  if (!s) return { ok: false, unavailable: true, value: fallback };
  try {
    const raw = s.getItem(key);
    if (raw == null || raw === "") return { ok: true, value: fallback, empty: true };
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, corrupt: true, error, value: fallback };
  }
}
function writeJson(key, value) {
  const s = storage();
  if (!s) return false;
  try { s.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
function envelope(kind, payload, timestamps = {}) {
  const stamp = nowIso();
  return { schemaVersion: BLUEPRINT_STORAGE_VERSION, kind, payload, createdAt: timestamps.createdAt || stamp, updatedAt: timestamps.updatedAt || stamp };
}
function isEnvelope(value, kind) {
  return value && typeof value === "object" && !Array.isArray(value) && value.kind === kind && Object.hasOwn(value, "schemaVersion") && Object.hasOwn(value, "payload");
}

export function makeDesignPart(x, y, type, previousRotation = 0) {
  const allowed = PART_STATS[type]?.allowedRotations;
  const rotation = type === "maneuverThruster"
    ? maneuverThrusterAutoRotation(x)
    : isRotatablePart(type) ? normalizeRotation(previousRotation, allowed, x) : 0;
  return { x, y, type, rotation };
}

export function normalizeDesign(input, options = {}) {
  const { fallbackOnInvalid = true, allowEmpty = false } = options;
  const fallback = defaultDesign();
  const source = Array.isArray(input) ? input : fallback;
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
    const footprint = (PART_STATS[type] || PART_STATS.frame).footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(x, y, footprint, newPart.rotation);
    let bad = false;
    for (const cell of cells) {
      if (cell.x < 0 || cell.x > 14 || cell.y < 0 || cell.y > 14 || occupied.has(`${cell.x},${cell.y}`)) bad = true;
    }
    if (bad) continue;
    for (const cell of cells) occupied.add(`${cell.x},${cell.y}`);
    clean.push(newPart);
  }
  if (allowEmpty && clean.length === 0) return clean;
  const validation = validateBlueprint(clean);
  if (!validation.ok) return fallbackOnInvalid ? fallback : clean;
  return clean;
}

const PREVIOUS_STOCK_DEFAULTS = [
  [
    { x: 7, y: 7, type: "core" },
    { x: 6, y: 8, type: "frame" },
    { x: 7, y: 8, type: "frame" },
    { x: 8, y: 8, type: "frame" },
    { x: 7, y: 9, type: "engine" },
    { x: 5, y: 7, type: "reactor", rotation: 0 },
    { x: 8, y: 6, type: "beamEmitter", rotation: 0 },
    { x: 7, y: 6, type: "shield" },
    { x: 5, y: 8, type: "gyroscope" },
    { x: 9, y: 7, type: "auxGenerator" },
    { x: 5, y: 6, type: "radiator" },
    { x: 9, y: 6, type: "radiator" }
  ],
  [
    { x: 7, y: 7, type: "core" },
    { x: 7, y: 8, type: "frame" },
    { x: 6, y: 8, type: "engine" },
    { x: 8, y: 8, type: "engine" },
    { x: 6, y: 7, type: "blaster" },
    { x: 8, y: 7, type: "blaster" },
    { x: 5, y: 7, type: "maneuverThruster" },
    { x: 9, y: 7, type: "maneuverThruster" },
    { x: 7, y: 6, type: "shield" },
    { x: 6, y: 6, type: "armor" },
    { x: 8, y: 6, type: "armor" },
    { x: 7, y: 9, type: "battery" }
  ],
  [
    { x: 7, y: 7, type: "core" },
    { x: 7, y: 8, type: "frame" },
    { x: 6, y: 8, type: "engine" },
    { x: 8, y: 8, type: "engine" },
    { x: 6, y: 7, type: "blaster" },
    { x: 8, y: 7, type: "blaster" },
    { x: 5, y: 7, type: "maneuverThruster" },
    { x: 9, y: 7, type: "maneuverThruster" },
    { x: 7, y: 6, type: "shield" },
    { x: 6, y: 6, type: "armor" },
    { x: 8, y: 6, type: "armor" }
  ]
];

function designSignature(design) {
  return normalizeDesign(design, { fallbackOnInvalid: false, allowEmpty: true })
    .map((part) => `${part.x},${part.y},${part.type},${part.rotation || 0}`)
    .sort()
    .join("|");
}
function matchesPreviousStockDefault(design) {
  const signature = designSignature(design);
  return PREVIOUS_STOCK_DEFAULTS.some((stock) => designSignature(stock) === signature);
}

function savedDesignSummary(blueprint) {
  const stats = computeStats(blueprint);
  return { cost: stats.unitCost, weapons: `${stats.weaponDps} DPS`, speed: Math.round(stats.maxSpeed) };
}
function normalizeSavedDesign(design, index) {
  if (!design || typeof design !== "object" || Array.isArray(design)) return null;
  const blueprint = normalizeDesign(design.blueprint || design.modules || design.design, { fallbackOnInvalid: false, allowEmpty: true });
  if (!blueprint.length) return null;
  const validation = validateBlueprint(blueprint);
  const summary = savedDesignSummary(blueprint);
  return {
    id: String(design.id || `saved-${index}`).slice(0, 64),
    name: String(design.name || `Design ${index + 1}`).slice(0, 28),
    blueprint,
    invalid: !validation.ok,
    invalidReason: validation.errors[0] || "Invalid blueprint.",
    combatStyle: safeStyle(design.combatStyle, "sentry"),
    cost: summary.cost,
    weapons: summary.weapons,
    speed: summary.speed,
    createdAt: Number(design.createdAt) || Date.now(),
    updatedAt: Number(design.updatedAt) || Date.now()
  };
}

export function migrateDesignStorage(value) {
  if (isEnvelope(value, "current-design")) {
    if (value.schemaVersion > BLUEPRINT_STORAGE_VERSION) return { modules: defaultDesign(), combatStyle: "sentry", unknownVersion: true };
    value = value.payload;
  }
  if (value && !Array.isArray(value) && typeof value === "object" && Array.isArray(value.modules)) {
    const modules = matchesPreviousStockDefault(value.modules) ? defaultDesign() : normalizeDesign(value.modules, { allowEmpty: true });
    return { modules, combatStyle: safeStyle(value.combatStyle, "sentry") };
  }
  const modules = matchesPreviousStockDefault(value) ? defaultDesign() : normalizeDesign(value, { allowEmpty: true });
  return { modules, combatStyle: "sentry" };
}
export function designEnvelope(design, combatStyle = "sentry", timestamps = {}) {
  return envelope("current-design", { modules: normalizeDesign(design, { allowEmpty: true }), combatStyle: safeStyle(combatStyle, "sentry") }, timestamps);
}
export function loadDesign() {
  const read = readJson(LOCAL_DESIGN_KEY, null);
  if (!read.ok) {
    const backup = readJson(LOCAL_DESIGN_BACKUP_KEY, null);
    if (backup.ok && backup.value) return { ...migrateDesignStorage(backup.value), recovered: true };
    return { modules: normalizeDesign(null), combatStyle: "sentry", recovered: Boolean(read.corrupt), fallback: true };
  }
  const migrated = migrateDesignStorage(read.value);
  if (migrated.unknownVersion) return { ...migrated, recovered: true };
  return migrated;
}
export function persistDesign(design, combatStyle = "sentry") {
  const env = designEnvelope(design, combatStyle);
  const ok = writeJson(LOCAL_DESIGN_KEY, env);
  if (ok && validateBlueprint(env.payload.modules).ok) writeJson(LOCAL_DESIGN_BACKUP_KEY, env);
  return ok;
}

export function migrateSavedDesignsStorage(value) {
  if (isEnvelope(value, "saved-designs")) {
    if (value.schemaVersion > BLUEPRINT_STORAGE_VERSION) return [];
    value = value.payload;
  }
  const list = Array.isArray(value) ? value : Array.isArray(value?.designs) ? value.designs : [];
  return list.map(normalizeSavedDesign).filter(Boolean).slice(0, MAX_SAVED_DESIGNS);
}
export function savedDesignsEnvelope(savedDesigns, timestamps = {}) { return envelope("saved-designs", migrateSavedDesignsStorage(savedDesigns), timestamps); }
export function loadSavedDesigns() { const read = readJson(LOCAL_SAVED_DESIGNS_KEY, []); return read.ok ? migrateSavedDesignsStorage(read.value) : []; }
export function persistSavedDesigns(savedDesigns) { return writeJson(LOCAL_SAVED_DESIGNS_KEY, savedDesignsEnvelope(savedDesigns)); }

export function migrateLoadoutsStorage(value) {
  if (isEnvelope(value, "loadouts")) {
    if (value.schemaVersion > BLUEPRINT_STORAGE_VERSION) return [];
    value = value.payload;
  }
  const list = Array.isArray(value) ? value : Array.isArray(value?.loadouts) ? value.loadouts : [];
  return list.slice(0, MAX_LOADOUTS).map((lo, index) => ({
    id: String(lo?.id || `loadout-${index}`).slice(0, 64),
    name: String(lo?.name || `Loadout ${index + 1}`).slice(0, 20),
    designIds: Array.isArray(lo?.designIds) ? lo.designIds.map(String).slice(0, MAX_SAVED_DESIGNS) : []
  }));
}
export function loadoutsEnvelope(loadouts, timestamps = {}) { return envelope("loadouts", migrateLoadoutsStorage(loadouts), timestamps); }
export function loadLoadouts() { const read = readJson(LOCAL_LOADOUTS_KEY, []); return read.ok ? migrateLoadoutsStorage(read.value) : []; }
export function persistLoadouts(loadouts) { return writeJson(LOCAL_LOADOUTS_KEY, loadoutsEnvelope(loadouts)); }


export function exportBlueprints(savedDesigns, loadouts = []) {
  return envelope("blueprint-export", { designs: migrateSavedDesignsStorage(savedDesigns), loadouts: migrateLoadoutsStorage(loadouts) });
}

export function importBlueprints(value, existingDesigns = [], existingLoadouts = []) {
  const source = isEnvelope(value, "blueprint-export") ? value.payload : value;
  if (isEnvelope(value, "blueprint-export") && value.schemaVersion > BLUEPRINT_STORAGE_VERSION) {
    return { designs: existingDesigns.slice(0, MAX_SAVED_DESIGNS), loadouts: existingLoadouts.slice(0, MAX_LOADOUTS), accepted: 0, rejected: 0, futureVersion: true };
  }
  const incoming = Array.isArray(source?.designs) ? source.designs : Array.isArray(source) ? source : [];
  const byId = new Set(existingDesigns.map((d) => String(d.id)));
  const out = existingDesigns.slice(0, MAX_SAVED_DESIGNS);
  let accepted = 0;
  let rejected = 0;
  for (let i = 0; i < incoming.length; i += 1) {
    if (out.length >= MAX_SAVED_DESIGNS) { rejected += 1; continue; }
    const normalized = normalizeSavedDesign(incoming[i], i);
    if (!normalized || normalized.invalid) { rejected += 1; continue; }
    let id = normalized.id;
    if (byId.has(id)) id = `${id}-import-${Date.now().toString(36)}-${i}`.slice(0, 64);
    normalized.id = id;
    byId.add(id);
    out.push(normalized);
    accepted += 1;
  }
  return { designs: out, loadouts: migrateLoadoutsStorage(existingLoadouts), accepted, rejected };
}
