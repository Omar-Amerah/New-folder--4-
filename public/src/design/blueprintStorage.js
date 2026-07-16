// Handles localStorage persistence, blueprint validation wrappers, default designs, and versioned storage.
// Schema v2 stores { modules, wiring } together; older storage versions/keys are
// intentionally discarded (no migration) — stale data falls back to the default ship.

import { LOCAL_DESIGN_KEY, LOCAL_DESIGN_BACKUP_KEY, LOCAL_SAVED_DESIGNS_KEY, LOCAL_LOADOUTS_KEY } from "../constants.js";
import { PART_DEFS, PART_STATS, isRotatablePart } from "./parts.js";
import { maneuverThrusterAutoRotation, normalizeRotation } from "./rotation.js";
import { validateBlueprint } from "./blueprintValidation.js";
import { getOccupiedCells } from "./footprint.js";
import { computeStats } from "./componentStats.js";

export const BLUEPRINT_STORAGE_VERSION = 2;
export const MAX_SAVED_DESIGNS = 12;
export const MAX_LOADOUTS = 8;

function wiringRules() {
  // Loaded as a classic shared script (public/src/shared/wiringRules.js) before
  // the module entry point, exactly like HeatRules/EngineExhaustRules.
  return globalThis.WiringRules || null;
}

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

// Default Power wiring: one bus along the y=7 grid line plus a drop to the
// engine. It joins the Core, Reactor and Aux Generator to every powered
// component of the default layout. The default ship carries no Data-support
// module, so its Data wiring is empty. Kept in sync with
// src/server/config.js DEFAULT_WIRING.
export function defaultWiring() {
  return {
    version: 1,
    power: [
      { x1: 5, y1: 7, x2: 6, y2: 7 },
      { x1: 6, y1: 7, x2: 7, y2: 7 },
      { x1: 7, y1: 7, x2: 8, y2: 7 },
      { x1: 8, y1: 7, x2: 9, y2: 7 },
      { x1: 7, y1: 7, x2: 7, y2: 8 },
      { x1: 7, y1: 8, x2: 7, y2: 9 }
    ],
    data: []
  };
}

export function normalizeWiring(wiring, modules) {
  const rules = wiringRules();
  if (!rules) return preservedWiringFallback(wiring);
  return rules.normalizeWiring(wiring, modules, PART_STATS).wiring;
}

// If the shared engine script is unavailable (stale-cached index.html, a test
// importing this module without the shim), pass stored segments through with a
// bounded shape instead of returning empty wiring — otherwise the next
// persistDesign() would permanently wipe the user's saved wiring. Real
// normalization happens once the engine is present again.
function preservedWiringFallback(wiring) {
  const list = (value) => Array.isArray(value)
    ? value.slice(0, 240).map((segment) => ({
        x1: Math.trunc(Number(segment?.x1)) || 0,
        y1: Math.trunc(Number(segment?.y1)) || 0,
        x2: Math.trunc(Number(segment?.x2)) || 0,
        y2: Math.trunc(Number(segment?.y2)) || 0
      }))
    : [];
  return { version: 1, power: list(wiring?.power), data: list(wiring?.data) };
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
function isCurrentEnvelope(value, kind) {
  return isEnvelope(value, kind) && value.schemaVersion === BLUEPRINT_STORAGE_VERSION;
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
  const occupied = new Set();
  const clean = [];
  for (const raw of source) {
    const x = Math.trunc(Number(raw?.x));
    const y = Math.trunc(Number(raw?.y));
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

function defaultCurrentDesign() {
  const modules = defaultDesign();
  return { modules, wiring: normalizeWiring(defaultWiring(), modules), combatStyle: "sentry" };
}

function savedDesignSummary(blueprint) {
  const stats = computeStats(blueprint);
  return { cost: stats.unitCost, weapons: `${stats.weaponDps} DPS`, speed: Math.round(stats.maxSpeed) };
}
function normalizeSavedDesign(design, index) {
  if (!design || typeof design !== "object" || Array.isArray(design)) return null;
  const blueprint = normalizeDesign(design.blueprint || design.modules, { fallbackOnInvalid: false, allowEmpty: true });
  if (!blueprint.length) return null;
  const validation = validateBlueprint(blueprint);
  const summary = savedDesignSummary(blueprint);
  return {
    id: String(design.id || `saved-${index}`).slice(0, 64),
    name: String(design.name || `Design ${index + 1}`).slice(0, 28),
    blueprint,
    // Each saved design keeps an independent, normalized copy of its wiring.
    wiring: normalizeWiring(design.wiring, blueprint),
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

// Storage schema v2 accepts only v2 "current-design" envelopes. Everything
// else — legacy arrays, v1 envelopes, future versions — resolves to the
// current default ship with its default wiring. There is no migration path.
export function migrateDesignStorage(value) {
  if (!isCurrentEnvelope(value, "current-design")) return { ...defaultCurrentDesign(), discarded: value != null };
  const payload = value.payload;
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.modules)) return { ...defaultCurrentDesign(), discarded: true };
  const modules = normalizeDesign(payload.modules, { allowEmpty: true });
  return {
    modules,
    wiring: normalizeWiring(payload.wiring, modules),
    combatStyle: safeStyle(payload.combatStyle, "sentry")
  };
}
export function designEnvelope(design, wiring, combatStyle = "sentry", timestamps = {}) {
  const modules = normalizeDesign(design, { allowEmpty: true });
  return envelope("current-design", {
    modules,
    wiring: normalizeWiring(wiring, modules),
    combatStyle: safeStyle(combatStyle, "sentry")
  }, timestamps);
}
export function loadDesign() {
  const read = readJson(LOCAL_DESIGN_KEY, null);
  if (!read.ok) {
    const backup = readJson(LOCAL_DESIGN_BACKUP_KEY, null);
    if (backup.ok && backup.value) return { ...migrateDesignStorage(backup.value), recovered: true };
    return { ...defaultCurrentDesign(), recovered: Boolean(read.corrupt), fallback: true };
  }
  if (read.empty) return defaultCurrentDesign();
  return migrateDesignStorage(read.value);
}
export function persistDesign(design, wiring, combatStyle = "sentry") {
  const env = designEnvelope(design, wiring, combatStyle);
  const ok = writeJson(LOCAL_DESIGN_KEY, env);
  if (ok && validateBlueprint(env.payload.modules).ok) writeJson(LOCAL_DESIGN_BACKUP_KEY, env);
  return ok;
}

export function migrateSavedDesignsStorage(value) {
  if (!isCurrentEnvelope(value, "saved-designs")) return [];
  const list = Array.isArray(value.payload) ? value.payload : [];
  return list.map(normalizeSavedDesign).filter(Boolean).slice(0, MAX_SAVED_DESIGNS);
}
function normalizeSavedDesignList(value) {
  const list = Array.isArray(value) ? value : [];
  return list.map(normalizeSavedDesign).filter(Boolean).slice(0, MAX_SAVED_DESIGNS);
}
export function savedDesignsEnvelope(savedDesigns, timestamps = {}) { return envelope("saved-designs", normalizeSavedDesignList(savedDesigns), timestamps); }
export function loadSavedDesigns() { const read = readJson(LOCAL_SAVED_DESIGNS_KEY, []); return read.ok ? migrateSavedDesignsStorage(read.value) : []; }
export function persistSavedDesigns(savedDesigns) { return writeJson(LOCAL_SAVED_DESIGNS_KEY, savedDesignsEnvelope(savedDesigns)); }

function normalizeLoadoutList(value) {
  const list = Array.isArray(value) ? value : [];
  return list.slice(0, MAX_LOADOUTS).map((lo, index) => ({
    id: String(lo?.id || `loadout-${index}`).slice(0, 64),
    name: String(lo?.name || `Loadout ${index + 1}`).slice(0, 20),
    designIds: Array.isArray(lo?.designIds) ? lo.designIds.map(String).slice(0, MAX_SAVED_DESIGNS) : []
  }));
}
export function migrateLoadoutsStorage(value) {
  if (!isCurrentEnvelope(value, "loadouts")) return [];
  return normalizeLoadoutList(value.payload);
}
export function loadoutsEnvelope(loadouts, timestamps = {}) { return envelope("loadouts", normalizeLoadoutList(loadouts), timestamps); }
export function loadLoadouts() { const read = readJson(LOCAL_LOADOUTS_KEY, []); return read.ok ? migrateLoadoutsStorage(read.value) : []; }
export function persistLoadouts(loadouts) { return writeJson(LOCAL_LOADOUTS_KEY, loadoutsEnvelope(loadouts)); }


export function exportBlueprints(savedDesigns, loadouts = []) {
  return envelope("blueprint-export", { designs: normalizeSavedDesignList(savedDesigns), loadouts: normalizeLoadoutList(loadouts) });
}

export function importBlueprints(value, existingDesigns = [], existingLoadouts = []) {
  if (isEnvelope(value, "blueprint-export") && value.schemaVersion !== BLUEPRINT_STORAGE_VERSION) {
    return { designs: existingDesigns.slice(0, MAX_SAVED_DESIGNS), loadouts: existingLoadouts.slice(0, MAX_LOADOUTS), accepted: 0, rejected: 0, incompatibleVersion: true };
  }
  const source = isEnvelope(value, "blueprint-export") ? value.payload : value;
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
  return { designs: out, loadouts: normalizeLoadoutList(existingLoadouts), accepted, rejected };
}
