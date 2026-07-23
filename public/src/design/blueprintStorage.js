// Handles localStorage persistence, blueprint validation wrappers, default designs, and versioned storage.
// Schema v2 stores { modules, wiring } together; older storage versions/keys are
// intentionally discarded (no migration) — stale data falls back to the default ship.

import "../shared/dataSupportRules.js";
import "../shared/switchgearRules.js";
import "../shared/wiringRules.js";
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

export function defaultWiring() {
  const modules = defaultDesign();
  const rules = wiringRules();
  if (!rules?.createGeneratedPowerWiring) throw new Error("WiringRules.createGeneratedPowerWiring must load before defaultWiring()");
  return rules.createGeneratedPowerWiring(modules, PART_STATS);
}

export function normalizeWiring(wiring, modules) {
  const rules = wiringRules();
  if (!rules) return preservedWiringFallback(wiring);
  return rules.normalizeWiring(wiring, modules, PART_STATS).wiring;
}

// If the shared engine script is unavailable (stale-cached index.html, a test
// importing this module without the shim), preserve bounded v2 routes rather
// than returning empty wiring — otherwise the next
// persistDesign() would permanently wipe the user's saved wiring. Real
// normalization happens once the engine is present again.
const FALLBACK_POWER_TIERS = new Set(["light", "standard", "heavy"]);

function fallbackTier(kind, value) {
  if (kind === "power" && FALLBACK_POWER_TIERS.has(value)) return value;
  return "standard";
}

const DEFAULT_POWER_POLICY = Object.freeze({
  preset: "balanced",
  customOrder: Object.freeze(["command", "propulsion", "shields", "pointDefence", "weapons", "coolingSupport"])
});

function fallbackPowerPolicy(policy) {
  const source = policy && typeof policy === "object" && !Array.isArray(policy) ? policy : {};
  const preset = ["balanced", "defensive", "offensive", "mobility", "custom"].includes(source.preset) ? source.preset : "balanced";
  const order = Array.isArray(source.customOrder)
    ? source.customOrder.filter((value) => DEFAULT_POWER_POLICY.customOrder.includes(value))
    : [];
  const seen = new Set(order);
  for (const category of DEFAULT_POWER_POLICY.customOrder) if (!seen.has(category)) { seen.add(category); order.push(category); }
  return { preset, customOrder: order };
}

// Fallback preserves bounded Wiring v2/v3 routes when the shared engine script
// is unavailable, always emitting the current v3 shape so a later persist does
// not wipe user routes. Real migration/normalization happens once the engine
// is present again.
function preservedWiringFallback(wiring) {
  const empty = () => ({ sections: [], connections: [] });
  const version = wiring?.version;
  if (version !== 2 && version !== 3) return { version: 3, power: empty(), data: empty(), powerPolicy: fallbackPowerPolicy(null) };
  const kind = (value, wiringKind) => ({
    sections: Array.isArray(value?.sections) ? value.sections.slice(0, 480).map((section) => ({
      id: String(section?.id || ""), x1: Math.trunc(Number(section?.x1)), y1: Math.trunc(Number(section?.y1)),
      x2: Math.trunc(Number(section?.x2)), y2: Math.trunc(Number(section?.y2)),
      // Fallback preserves reserved Power tier schema values; it does not
      // implement tier capacity or gameplay. Data wiring remains standard-only.
      tier: fallbackTier(wiringKind, section?.tier)
    })) : [],
    connections: Array.isArray(value?.connections) ? value.connections.slice(0, 240).map((connection) => ({
      sourceIndex: Math.trunc(Number(connection?.sourceIndex)), targetIndex: Math.trunc(Number(connection?.targetIndex)),
      sectionIds: Array.isArray(connection?.sectionIds) ? connection.sectionIds.slice(0, 224).map(String) : []
    })) : []
  });
  return { version: 3, power: kind(wiring.power, "power"), data: kind(wiring.data, "data"), powerPolicy: fallbackPowerPolicy(wiring?.powerPolicy) };
}

function nowIso() { return new Date().toISOString(); }
function safeStyle(value, fallback = "hold") { return ["charge", "circle", "sentry", "hold"].includes(value) ? value : fallback; }
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

function normalizationIssue(code, inputIndex) {
  const messages = {
    "invalid-blueprint-shape": "Invalid design: blueprint modules must be an array.",
    "invalid-coordinate": "Invalid design: module has invalid coordinates.",
    "unknown-module": "Invalid design: unknown module type.",
    "out-of-bounds": "Invalid design: modules outside build grid.",
    overlap: "Invalid design: overlapping modules."
  };
  return { code, message: messages[code] || "Invalid design: invalid module.", inputIndex };
}

export function normalizeDesignDetailed(input, options = {}) {
  const { allowEmpty = false, fallbackToDefault = false } = options;
  if (!Array.isArray(input)) {
    if (!fallbackToDefault) {
      return { modules: [], issues: [normalizationIssue("invalid-blueprint-shape", null)], changed: true, droppedCount: 0 };
    }
    input = defaultDesign();
  }
  const source = input;
  const occupied = new Set();
  const modules = [];
  const issues = [];
  for (let inputIndex = 0; inputIndex < source.length; inputIndex += 1) {
    const raw = source[inputIndex];
    const x = Math.trunc(Number(raw?.x));
    const y = Math.trunc(Number(raw?.y));
    const type = String(raw?.type || "");
    if (!Number.isInteger(x) || !Number.isInteger(y)) { issues.push(normalizationIssue("invalid-coordinate", inputIndex)); continue; }
    if (!PART_DEFS[type]) { issues.push(normalizationIssue("unknown-module", inputIndex)); continue; }
    let newPart = makeDesignPart(x, y, type, raw?.rotation);
    if (type === "switchgear" && globalThis.SwitchgearRules) newPart = globalThis.SwitchgearRules.normalizeDesignPart({ ...newPart, switchgearMode: raw?.switchgearMode, switchgearRatingTier: raw?.switchgearRatingTier });
    const footprint = (PART_STATS[type] || PART_STATS.frame).footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(x, y, footprint, newPart.rotation);
    let outOfBounds = false;
    let overlap = false;
    for (const cell of cells) {
      if (cell.x < 0 || cell.x > 14 || cell.y < 0 || cell.y > 14) outOfBounds = true;
      if (occupied.has(`${cell.x},${cell.y}`)) overlap = true;
    }
    if (outOfBounds) { issues.push(normalizationIssue("out-of-bounds", inputIndex)); continue; }
    if (overlap) { issues.push(normalizationIssue("overlap", inputIndex)); continue; }
    for (const cell of cells) occupied.add(`${cell.x},${cell.y}`);
    modules.push(newPart);
  }
  return { modules: allowEmpty || modules.length ? modules : [], issues, changed: issues.length > 0 || modules.length !== source.length, droppedCount: issues.length };
}

export function normalizeDesign(input, options = {}) {
  const { fallbackOnInvalid = true, allowEmpty = false } = options;
  const detailed = normalizeDesignDetailed(input, { allowEmpty });
  if (allowEmpty && detailed.modules.length === 0) return detailed.modules;
  const validation = validateBlueprint(detailed.modules, { requireThrust: false, normalizationIssues: detailed.issues });
  if (!validation.ok) return fallbackOnInvalid ? defaultDesign() : detailed.modules;
  return detailed.modules;
}


function normalizedDesignKey(modules) { return JSON.stringify(normalizeDesignDetailed(modules, { allowEmpty: true }).modules); }
function isEmptyWiringValue(wiring) {
  return (wiring?.version === 2 || wiring?.version === 3)
    && (!Array.isArray(wiring?.power?.sections) || wiring.power.sections.length === 0)
    && (!Array.isArray(wiring?.power?.connections) || wiring.power.connections.length === 0)
    && (!Array.isArray(wiring?.data?.sections) || wiring.data.sections.length === 0)
    && (!Array.isArray(wiring?.data?.connections) || wiring.data.connections.length === 0);
}
function isRecognizedUntouchedStockDefault(modules) {
  const current = normalizedDesignKey(defaultDesign());
  const normalized = normalizedDesignKey(modules);
  if (Array.isArray(modules) && modules.length === defaultDesign().length && normalized === current) return true;
  const previous = defaultDesign().map((part) => ({ ...part, x: part.x - 4, y: part.y - 4 }));
  return Array.isArray(modules) && modules.length === previous.length && normalized === normalizedDesignKey(previous);
}
function normalizeStoredWiringForDesign(wiring, modules) {
  // Narrow bug migration: exact untouched stock/default blueprints saved while
  // default Wiring v2 was empty receive the trusted generated default wiring.
  // Custom, imported, or modified designs remain user-authored and are never
  // silently auto-wired.
  if (isEmptyWiringValue(wiring) && isRecognizedUntouchedStockDefault(modules)) return normalizeWiring(defaultWiring(), modules);
  return normalizeWiring(wiring, modules);
}

function defaultCurrentDesign() {
  const modules = defaultDesign();
  return { modules, wiring: normalizeWiring(defaultWiring(), modules), combatStyle: "hold" };
}

function savedDesignSummary(blueprint, wiring) {
  const stats = computeStats(blueprint, { wiring });
  return { cost: stats.unitCost, weapons: `${stats.weaponDps} DPS`, speed: Math.round(stats.maxSpeed) };
}
function normalizeSavedDesign(design, index) {
  if (!design || typeof design !== "object" || Array.isArray(design)) return null;
  const source = Object.hasOwn(design, "blueprint") ? design.blueprint : design.modules;
  const detailed = normalizeDesignDetailed(source, { allowEmpty: true });
  const blueprint = detailed.modules;
  if (!blueprint.length && detailed.issues.some((issue) => issue.code === "invalid-blueprint-shape")) {
    return {
      id: String(design.id || `saved-${index}`).slice(0, 64),
      name: String(design.name || `Design ${index + 1}`).slice(0, 28),
      blueprint: [],
      wiring: normalizeWiring(design.wiring, []),
      invalid: true,
      invalidReason: detailed.issues[0].message,
      invalidCode: detailed.issues[0].code,
      combatStyle: safeStyle(design.combatStyle, "hold"),
      cost: 0,
      weapons: "0 DPS",
      speed: 0,
      createdAt: Number(design.createdAt) || Date.now(),
      updatedAt: Number(design.updatedAt) || Date.now()
    };
  }
  if (!blueprint.length) return null;
  const validation = validateBlueprint(blueprint, { requireThrust: true, normalizationIssues: detailed.issues });
  const wiring = normalizeStoredWiringForDesign(design.wiring, blueprint);
  const summary = savedDesignSummary(blueprint, wiring);
  return {
    id: String(design.id || `saved-${index}`).slice(0, 64),
    name: String(design.name || `Design ${index + 1}`).slice(0, 28),
    blueprint,
    // Each saved design keeps an independent, normalized copy of its wiring.
    wiring,
    invalid: !validation.ok,
    invalidReason: validation.errors[0] || "Invalid blueprint.",
    combatStyle: safeStyle(design.combatStyle, "hold"),
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
  if (!isCurrentEnvelope(value, "current-design")) return { ...defaultCurrentDesign(), discarded: value != null, fallback: value != null };
  const payload = value.payload;
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.modules)) return { ...defaultCurrentDesign(), discarded: true, fallback: true };
  const detailed = normalizeDesignDetailed(payload.modules, { allowEmpty: true });
  const modules = detailed.modules;
  return {
    modules,
    normalizationIssues: detailed.issues,
    needsAttention: detailed.issues.length > 0,
    wiring: normalizeStoredWiringForDesign(payload.wiring, modules),
    combatStyle: safeStyle(payload.combatStyle, "hold")
  };
}
export function designEnvelope(design, wiring, combatStyle = "hold", timestamps = {}) {
  const modules = normalizeDesign(design, { allowEmpty: true });
  return envelope("current-design", {
    modules,
    wiring: normalizeWiring(wiring, modules),
    combatStyle: safeStyle(combatStyle, "hold")
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
export function persistDesign(design, wiring, combatStyle = "hold") {
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

function uniqueImportedId(base, used) {
  const cleanBase = String(base || "imported").slice(0, 64) || "imported";
  if (!used.has(cleanBase)) return cleanBase;
  for (let n = 1; n < 1000; n += 1) {
    const suffix = `-import-${n}`;
    const candidate = `${cleanBase.slice(0, 64 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

export function importBlueprints(value, existingDesigns = [], existingLoadouts = []) {
  const baseResult = () => ({
    designs: existingDesigns.slice(0, MAX_SAVED_DESIGNS),
    loadouts: normalizeLoadoutList(existingLoadouts),
    accepted: 0,
    rejected: 0,
    acceptedDesigns: 0,
    rejectedDesigns: 0,
    acceptedLoadouts: 0,
    rejectedLoadouts: 0,
    designIdMap: {},
    warnings: []
  });
  if (isEnvelope(value, "blueprint-export") && value.schemaVersion !== BLUEPRINT_STORAGE_VERSION) {
    return { ...baseResult(), incompatibleVersion: true };
  }
  const source = isEnvelope(value, "blueprint-export") ? value.payload : value;
  const envelopeImport = isEnvelope(value, "blueprint-export") || (source && typeof source === "object" && !Array.isArray(source));
  const incoming = Array.isArray(source?.designs) ? source.designs : Array.isArray(source) ? source : [];
  const incomingLoadouts = envelopeImport && Array.isArray(source?.loadouts) ? source.loadouts : [];
  const result = baseResult();
  const designIds = new Set(result.designs.map((d) => String(d.id)));
  const sourceCounts = new Map();
  for (let i = 0; i < incoming.length; i += 1) {
    const id = String(incoming[i]?.id || `saved-${i}`).slice(0, 64);
    sourceCounts.set(id, (sourceCounts.get(id) || 0) + 1);
  }
  const duplicateSourceIds = new Set([...sourceCounts].filter(([, count]) => count > 1).map(([id]) => id));

  for (let i = 0; i < incoming.length; i += 1) {
    const sourceId = String(incoming[i]?.id || `saved-${i}`).slice(0, 64);
    if (duplicateSourceIds.has(sourceId)) {
      result.rejectedDesigns += 1;
      result.warnings.push(`Skipped blueprint ${sourceId}: duplicate incoming design ID.`);
      continue;
    }
    if (result.designs.length >= MAX_SAVED_DESIGNS) {
      result.rejectedDesigns += 1;
      result.warnings.push(`Skipped blueprint ${sourceId}: saved design capacity limit reached.`);
      continue;
    }
    const normalized = normalizeSavedDesign(incoming[i], i);
    if (!normalized || normalized.invalid) {
      result.rejectedDesigns += 1;
      result.warnings.push(`Skipped blueprint ${sourceId}: ${normalized?.invalidReason || "invalid design"}`);
      continue;
    }
    const finalId = uniqueImportedId(normalized.id, designIds);
    if (!finalId) {
      result.rejectedDesigns += 1;
      result.warnings.push(`Skipped blueprint ${sourceId}: unable to assign a unique ID.`);
      continue;
    }
    normalized.id = finalId;
    designIds.add(finalId);
    result.designIdMap[sourceId] = finalId;
    result.designs.push(normalized);
    result.acceptedDesigns += 1;
  }

  const loadoutIds = new Set(result.loadouts.map((lo) => String(lo.id)));
  for (let i = 0; i < incomingLoadouts.length; i += 1) {
    if (result.loadouts.length >= MAX_LOADOUTS) {
      result.rejectedLoadouts += 1;
      result.warnings.push(`Skipped loadout ${String(incomingLoadouts[i]?.id || `loadout-${i}`)}: loadout capacity limit reached.`);
      continue;
    }
    const raw = incomingLoadouts[i] || {};
    const originalId = String(raw.id || `loadout-${i}`).slice(0, 64);
    const name = String(raw.name || `Loadout ${i + 1}`).slice(0, 20);
    const seenRefs = new Set();
    const designIdsForLoadout = [];
    for (const ref of Array.isArray(raw.designIds) ? raw.designIds : []) {
      const mapped = result.designIdMap[String(ref)];
      if (!mapped) {
        result.warnings.push(`Removed loadout ${originalId} reference ${String(ref)}: design was missing, rejected or not imported.`);
        continue;
      }
      if (!seenRefs.has(mapped)) { seenRefs.add(mapped); designIdsForLoadout.push(mapped); }
    }
    if (!designIdsForLoadout.length) {
      result.rejectedLoadouts += 1;
      result.warnings.push(`Skipped loadout ${originalId}: no imported design references remain.`);
      continue;
    }
    const finalId = uniqueImportedId(originalId, loadoutIds);
    if (!finalId) {
      result.rejectedLoadouts += 1;
      result.warnings.push(`Skipped loadout ${originalId}: unable to assign a unique ID.`);
      continue;
    }
    loadoutIds.add(finalId);
    result.loadouts.push({ id: finalId, name, designIds: designIdsForLoadout.slice(0, MAX_SAVED_DESIGNS) });
    result.acceptedLoadouts += 1;
  }
  result.accepted = result.acceptedDesigns;
  result.rejected = result.rejectedDesigns;
  return result;
}
