// Handles localStorage persistence, blueprint validation wrappers, default designs, and versioned storage.
// The current schema stores modules and explicit logical Data Links.

import "../shared/componentTransform.js";
import "../shared/dataSupportRules.js";
import "../shared/droneBayRules.js";
import "../shared/legacyComponentRules.js";
import { LOCAL_DESIGN_KEY, LOCAL_DESIGN_BACKUP_KEY, LOCAL_DESIGN_PREMIGRATION_KEY, LOCAL_SAVED_DESIGNS_KEY, LOCAL_LOADOUTS_KEY } from "../constants.js";
import { PART_DEFS, PART_STATS, isRotatablePart } from "./parts.js";
import { maneuverThrusterAutoRotation, normalizeRotation } from "./rotation.js";
import { validateBlueprint } from "./blueprintValidation.js";
import { getOccupiedCells } from "./footprint.js";
import { computeStats } from "./componentStats.js";

const ComponentTransform = globalThis.ComponentTransform;
const LegacyComponentRules = globalThis.LegacyComponentRules;

export const BLUEPRINT_STORAGE_VERSION = 3;
// Schema v2 stored physical Power/Data Wiring. The modules, logical Data
// Links, combat style, and loadout references remain usable after Wiring was
// removed, so v2 envelopes are intentionally readable and normalized into v3.
const LEGACY_WIRING_STORAGE_VERSION = 2;
export const MAX_SAVED_DESIGNS = 24;
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
function safeStyle(value, fallback = "hold") {
  if (["charge", "hold", "orbit", "kite", "static"].includes(value)) return value;
  if (value === "circle" || value === "evasive") return "orbit";
  if (value === "direct" || value === "interceptor" || value === "brawler") return "charge";
  if (value === "maintain" || value === "sentry" || value === "heavy") return "hold";
  return ["charge", "hold", "orbit", "kite", "static"].includes(fallback) ? fallback : "hold";
}
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
function isSupportedStorageEnvelope(value, kind) {
  if (!isEnvelope(value, kind)) return false;
  const version = Number(value.schemaVersion);
  return version === BLUEPRINT_STORAGE_VERSION || version === LEGACY_WIRING_STORAGE_VERSION;
}

export function makeDesignPart(x, y, type, previousRotation = 0, previousFlipped = false) {
  const allowed = PART_STATS[type]?.allowedRotations;
  const rotation = type === "maneuverThruster"
    ? maneuverThrusterAutoRotation(x)
    : isRotatablePart(type) ? normalizeRotation(previousRotation, allowed, x) : 0;
  // `flipped` is written only when it is actually true on a flippable part, so
  // every blueprint saved before mirroring existed stays byte-identical and an
  // absent field keeps meaning "not mirrored".
  const flipped = ComponentTransform.normalizePartFlip(PART_STATS[type], previousFlipped);
  const base = type === "droneBay"
    ? { x, y, type, rotation: 0, droneType: null }
    : { x, y, type, rotation };
  return flipped ? { ...base, flipped: true } : base;
}

function footprintCellsFit(x, y, footprint, rotation, flipped, occupied) {
  const cells = getOccupiedCells(x, y, footprint, rotation, flipped);
  return cells.every((cell) => cell.x >= 0 && cell.x <= 14 && cell.y >= 0 && cell.y <= 14
    && !occupied.has(`${cell.x},${cell.y}`));
}

function addFootprintCells(occupied, x, y, footprint, rotation, flipped) {
  for (const cell of getOccupiedCells(x, y, footprint, rotation, flipped)) occupied.add(`${cell.x},${cell.y}`);
}

function nearestOpenFootprint(x, y, footprint, rotation, flipped, occupied) {
  let best = null;
  let bestDistance = Infinity;
  for (let candidateX = 0; candidateX <= 14; candidateX += 1) {
    for (let candidateY = 0; candidateY <= 14; candidateY += 1) {
      if (!footprintCellsFit(candidateX, candidateY, footprint, rotation, flipped, occupied)) continue;
      const distance = (candidateX - x) ** 2 + (candidateY - y) ** 2;
      if (distance < bestDistance
        || (distance === bestDistance && (candidateY < best.y || (candidateY === best.y && candidateX < best.x)))) {
        best = { x: candidateX, y: candidateY };
        bestDistance = distance;
      }
    }
  }
  return best;
}

/**
 * Replace hidden legacy sensor identifiers before the normalizer checks the
 * current catalogue. Large sensors have wider footprints, so keep the old
 * anchor/rotation when it fits and otherwise move the component to the nearest
 * deterministic free pose. A completely full design is reported explicitly so
 * it cannot silently become an overlapping blueprint.
 */
export function migrateLegacySensorFootprints(input) {
  if (!Array.isArray(input)) return { modules: input, changed: false, unmigratable: new Set() };
  const occupied = new Set();
  for (const part of input) {
    if (!part || LegacyComponentRules.isMigratedType(part.type)) continue;
    const x = Math.trunc(Number(part.x));
    const y = Math.trunc(Number(part.y));
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    const stat = PART_STATS[String(part.type)] || PART_STATS.frame;
    const rotation = normalizeRotation(part.rotation, stat.allowedRotations, x);
    const flipped = ComponentTransform.normalizePartFlip(stat, part.flipped);
    addFootprintCells(occupied, x, y, stat.footprint || { width: 1, height: 1 }, rotation, flipped);
  }

  const unmigratable = new Set();
  let changed = false;
  const modules = input.map((part, inputIndex) => {
    if (!part || !LegacyComponentRules.isMigratedType(part.type)) return part;
    changed = true;
    const type = LegacyComponentRules.replacementType(part.type);
    const x = Math.trunc(Number(part.x));
    const y = Math.trunc(Number(part.y));
    if (!Number.isInteger(x) || !Number.isInteger(y)) return { ...part, type };
    const stat = PART_STATS[type] || PART_STATS.frame;
    const rotation = normalizeRotation(part.rotation, stat.allowedRotations, x);
    const flipped = ComponentTransform.normalizePartFlip(stat, part.flipped);
    const footprint = stat.footprint || { width: 1, height: 1 };
    const destination = footprintCellsFit(x, y, footprint, rotation, flipped, occupied)
      ? { x, y }
      : nearestOpenFootprint(x, y, footprint, rotation, flipped, occupied);
    if (!destination) {
      unmigratable.add(inputIndex);
      return { ...part, type };
    }
    addFootprintCells(occupied, destination.x, destination.y, footprint, rotation, flipped);
    return { ...part, type, x: destination.x, y: destination.y };
  });
  return { modules, changed, unmigratable };
}

const COMMAND_COMPONENT_TYPES = new Set([
  "backupCore", "fireControlCommandCentre", "fleetDefenceCoordinator",
  "shieldCommandRelay", "engineeringCommandCentre", "propulsionCommandRelay",
  "electronicWarfareCommandCentre"
]);

/**
 * Migrate saved designs where command components had 1x1 footprints but now
 * occupy multi-cell spaces.  For each command component whose new footprint
 * would go out-of-bounds or overlap another part, attempt to shift it to the
 * nearest valid position.  Components that cannot be relocated are left in
 * place so normalizeDesignDetailed can report them as issues rather than
 * silently dropping them.
 */
export function migrateCommandFootprints(input) {
  if (!Array.isArray(input)) return input;
  const commandTypes = new Set();
  for (const part of input) {
    if (part && COMMAND_COMPONENT_TYPES.has(String(part.type))) commandTypes.add(String(part.type));
  }
  if (!commandTypes.size) return input;

  const occupied = new Set();
  for (const part of input) {
    if (!part) continue;
    const type = String(part.type);
    if (COMMAND_COMPONENT_TYPES.has(type)) continue;
    const fp = (PART_STATS[type] || PART_STATS.frame).footprint || { width: 1, height: 1 };
    for (const cell of getOccupiedCells(Math.trunc(Number(part.x)), Math.trunc(Number(part.y)), fp, part.rotation || 0)) {
      occupied.add(`${cell.x},${cell.y}`);
    }
  }

  const result = input.map((part) => {
    if (!part) return part;
    const type = String(part.type);
    if (!COMMAND_COMPONENT_TYPES.has(type)) return part;
    const fp = (PART_STATS[type] || PART_STATS.frame).footprint || { width: 1, height: 1 };
    const rot = part.rotation || 0;
    const origX = Math.trunc(Number(part.x));
    const origY = Math.trunc(Number(part.y));
    const cells = getOccupiedCells(origX, origY, fp, rot);
    const fits = cells.every((c) => c.x >= 0 && c.x <= 14 && c.y >= 0 && c.y <= 14 && !occupied.has(`${c.x},${c.y}`));
    if (fits) {
      for (const c of cells) occupied.add(`${c.x},${c.y}`);
      return part;
    }
    // Search outward from the original position for the nearest valid spot.
    let best = null;
    let bestDist = Infinity;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        const nx = origX + dx;
        const ny = origY + dy;
        const tryCells = getOccupiedCells(nx, ny, fp, rot);
        const tryFits = tryCells.every((c) => c.x >= 0 && c.x <= 14 && c.y >= 0 && c.y <= 14 && !occupied.has(`${c.x},${c.y}`));
        if (tryFits) {
          const dist = dx * dx + dy * dy;
          if (dist < bestDist) { bestDist = dist; best = { x: nx, y: ny }; }
        }
      }
    }
    if (best) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nx = best.x + dx;
          const ny = best.y + dy;
          const tryCells = getOccupiedCells(nx, ny, fp, rot);
          const tryFits = tryCells.every((c) => c.x >= 0 && c.x <= 14 && c.y >= 0 && c.y <= 14 && !occupied.has(`${c.x},${c.y}`));
          if (tryFits) {
            const dist = (nx - origX) ** 2 + (ny - origY) ** 2;
            if (dist < bestDist) { bestDist = dist; best = { x: nx, y: ny }; }
          }
        }
      }
      const newCells = getOccupiedCells(best.x, best.y, fp, rot);
      for (const c of newCells) occupied.add(`${c.x},${c.y}`);
      return { ...part, x: best.x, y: best.y };
    }
    // Could not relocate : leave in place; normalizeDesignDetailed will report it.
    for (const c of cells) occupied.add(`${c.x},${c.y}`);
    return part;
  });
  return result;
}

function normalizationIssue(code, inputIndex) {
  const messages = {
    "invalid-blueprint-shape": "Invalid design: blueprint modules must be an array.",
    "invalid-coordinate": "Invalid design: module has invalid coordinates.",
    "unknown-module": "Invalid design: unknown module type.",
    "out-of-bounds": "Invalid design: modules outside build grid.",
    overlap: "Invalid design: overlapping modules.",
    "legacy-component-migration": "Invalid design: a legacy sensor could not be migrated without overlap or leaving the build grid."
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
  const legacyMigration = migrateLegacySensorFootprints(input);
  const source = migrateCommandFootprints(legacyMigration.modules);
  const occupied = new Set();
  const modules = [];
  const issues = [];
  for (let inputIndex = 0; inputIndex < source.length; inputIndex += 1) {
    const raw = source[inputIndex];
    if (legacyMigration.unmigratable.has(inputIndex)) {
      issues.push(normalizationIssue("legacy-component-migration", inputIndex));
      continue;
    }
    const x = Math.trunc(Number(raw?.x));
    const y = Math.trunc(Number(raw?.y));
    const type = String(raw?.type || "");
    if (!Number.isInteger(x) || !Number.isInteger(y)) { issues.push(normalizationIssue("invalid-coordinate", inputIndex)); continue; }
    if (!PART_DEFS[type]) { issues.push(normalizationIssue("unknown-module", inputIndex)); continue; }
    let newPart = makeDesignPart(x, y, type, raw?.rotation, raw?.flipped);
    if (type === "droneBay") newPart = { ...newPart, rotation: 0, droneType: globalThis.DroneBayRules?.normalizeDroneType(raw?.droneType) || null };
    const footprint = (PART_STATS[type] || PART_STATS.frame).footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(x, y, footprint, newPart.rotation, newPart.flipped === true);
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
  return {
    modules: allowEmpty || modules.length ? modules : [],
    issues,
    changed: legacyMigration.changed || issues.length > 0 || modules.length !== source.length,
    droppedCount: issues.length
  };
}

export function normalizeDesign(input, options = {}) {
  const { fallbackOnInvalid = true, allowEmpty = false } = options;
  const detailed = normalizeDesignDetailed(input, { allowEmpty });
  if (allowEmpty && detailed.modules.length === 0) return detailed.modules;
  const validation = validateBlueprint(detailed.modules, { requireThrust: false, normalizationIssues: detailed.issues });
  if (!validation.ok) return fallbackOnInvalid ? defaultDesign() : detailed.modules;
  return detailed.modules;
}


function defaultCurrentDesign() {
  const modules = defaultDesign();
  return { modules, dataLinks: [], combatStyle: "hold" };
}

function savedDesignSummary(blueprint, dataLinks) {
  const stats = computeStats(blueprint, { dataLinks });
  const dpsLabel = stats.weaponDpsLabel === "Weapon DPS" ? "DPS" : (stats.weaponDpsLabel || "DPS");
  return { cost: stats.unitCost, weapons: `${stats.weaponDps} ${dpsLabel}`, speed: Math.round(stats.maxSpeed) };
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
      dataLinks: [],
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
  const dataLinks = globalThis.DataSupportRules?.normalizeDataLinks(blueprint, design.dataLinks, PART_STATS) || [];
  const summary = savedDesignSummary(blueprint, dataLinks);
  return {
    id: String(design.id || `saved-${index}`).slice(0, 64),
    name: String(design.name || `Design ${index + 1}`).slice(0, 28),
    blueprint,
    dataLinks,
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

// Build a normalized current-design result from a { modules, dataLinks?, combatStyle? }
// payload, preserving component-specific configuration (drone type via
// normalizeDesignDetailed) and explicit Data Links
// Returns null when the payload has no usable modules.
function buildCurrentDesignFromPayload(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.modules)) return null;
  const detailed = normalizeDesignDetailed(payload.modules, { allowEmpty: true });
  const modules = detailed.modules;
  if (!modules.length) return null;
  const rules = globalThis.DataSupportRules;
  const dataLinks = rules?.normalizeDataLinks(modules, payload.dataLinks, PART_STATS) || [];
  return {
    modules,
    normalizationIssues: detailed.issues,
    needsAttention: detailed.issues.length > 0,
    migrated: detailed.changed,
    dataLinks,
    combatStyle: safeStyle(payload.combatStyle, "hold")
  };
}

// Recognize a payload from a KNOWN older current-design format:
//  - a bare array of modules (oldest storage),
//  - a pre-envelope object storing { modules|design, dataLinks?, combatStyle? },
//  - an older versioned "current-design" envelope (schemaVersion < current).
// Returns a { modules, dataLinks, combatStyle } payload, or null if unrecognized.
function legacyCurrentDesignPayload(value) {
  if (Array.isArray(value)) return { modules: value, dataLinks: [], combatStyle: "hold" };
  if (!value || typeof value !== "object") return null;
  if (isEnvelope(value, "current-design") && Number(value.schemaVersion) < BLUEPRINT_STORAGE_VERSION) {
    return value.payload && typeof value.payload === "object" ? value.payload : null;
  }
  if (!Object.hasOwn(value, "schemaVersion")) {
    if (Array.isArray(value.modules)) return { modules: value.modules, dataLinks: value.dataLinks ?? [], combatStyle: value.combatStyle };
    if (Array.isArray(value.design)) return { modules: value.design, dataLinks: value.dataLinks ?? [], combatStyle: value.combatStyle };
  }
  return null;
}

// Storage schema v3 loads current envelopes directly and migrates known older
// formats into the current { modules, dataLinks, combatStyle } shape while
// preserving specialised component settings and combat style, and refuses to silently
// overwrite an unknown FUTURE schema. Anything genuinely unmigratable resolves
// to the default ship (with a warning) so startup never crashes.
export function migrateDesignStorage(value) {
  if (isCurrentEnvelope(value, "current-design")) {
    const built = buildCurrentDesignFromPayload(value.payload);
    return built || { ...defaultCurrentDesign(), discarded: true, fallback: true };
  }
  // A newer-than-supported envelope is left untouched: do not overwrite it with
  // migrated/default data. Load the default ship for this session only.
  if (isEnvelope(value, "current-design") && Number(value.schemaVersion) > BLUEPRINT_STORAGE_VERSION) {
    return {
      ...defaultCurrentDesign(),
      fallback: true,
      unsupportedFuture: true,
      preserveStored: true,
      migrationWarning: `Saved design uses a newer storage format (v${value.schemaVersion}); it was left untouched and the default ship was loaded. Update the app to use it.`
    };
  }
  const legacyPayload = legacyCurrentDesignPayload(value);
  if (legacyPayload) {
    const built = buildCurrentDesignFromPayload(legacyPayload);
    if (built) return { ...built, migrated: true };
  }
  return {
    ...defaultCurrentDesign(),
    discarded: value != null,
    fallback: value != null,
    migrationWarning: value != null ? "Saved current design could not be migrated; the default ship was loaded (your data was backed up)." : null
  };
}

// Preserve the exact original stored value before a migration/unsupported load,
// without clobbering an earlier pre-migration backup.
function backupPreMigrationDesign(original) {
  const s = storage();
  if (!s) return;
  try {
    if (s.getItem(LOCAL_DESIGN_PREMIGRATION_KEY) == null) {
      s.setItem(LOCAL_DESIGN_PREMIGRATION_KEY, JSON.stringify(original));
    }
  } catch { /* storage full/unavailable : best effort */ }
}
export function designEnvelope(design, dataLinks, combatStyle = "hold", timestamps = {}) {
  const modules = normalizeDesign(design, { allowEmpty: true });
  const rules = globalThis.DataSupportRules;
  return envelope("current-design", {
    modules,
    dataLinks: rules?.normalizeDataLinks(modules, dataLinks, PART_STATS) || [],
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
  const result = migrateDesignStorage(read.value);
  // Preserve the original data before it can be overwritten by a later
  // persistDesign() in the current format, and surface a clear warning.
  if (result.migrated || result.unsupportedFuture || result.discarded) {
    backupPreMigrationDesign(read.value);
  }
  if (result.migrationWarning && typeof console !== "undefined") console.warn(`[mfa] ${result.migrationWarning}`);
  else if (result.migrated && typeof console !== "undefined") console.info("[mfa] Migrated an older saved current design into the current format.");
  return result;
}
export function persistDesign(design, dataLinks, combatStyle = "hold") {
  const env = designEnvelope(design, dataLinks, combatStyle);
  const ok = writeJson(LOCAL_DESIGN_KEY, env);
  if (ok && validateBlueprint(env.payload.modules).ok) writeJson(LOCAL_DESIGN_BACKUP_KEY, env);
  return ok;
}

export function migrateSavedDesignsStorage(value) {
  if (!isSupportedStorageEnvelope(value, "saved-designs")) return [];
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
  if (!isSupportedStorageEnvelope(value, "loadouts")) return [];
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
  if (isEnvelope(value, "blueprint-export") && !isSupportedStorageEnvelope(value, "blueprint-export")) {
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
