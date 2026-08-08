// Shared cache for expensive Blueprint analysis used by the purchase bar, saved
// Blueprint library, and any other UI that needs normalized modules, stats,
// validation, and a stable thumbnail key.
//
// The cache is keyed by object identity / explicit revisions, not by TTLs or
// expensive JSON snapshots. It is invalidated explicitly at mutation boundaries
// where the editor persists or reloads Blueprint data.

import { computeStats } from "./componentStats.js";
import { validateBlueprint } from "./blueprintValidation.js";
import { normalizeDesignDetailed, normalizeWiring } from "./blueprintStorage.js";
import { normalizeRotation } from "./rotation.js";
import { getBalanceStatus } from "../balanceStatus.js";

function currentBalanceRevision() {
  const s = getBalanceStatus();
  return s?.serverRevision || s?.clientRevision || null;
}

export const counters = {
  computeStats: 0,
  normalizeDesign: 0,
  normalizeWiring: 0,
  validateBlueprint: 0,
  powerFlow: 0, // incremented by a shim below
  thumbnailKey: 0,
  catalogueRebuild: 0,
  availabilityUpdate: 0,
  cacheHit: 0,
  cacheMiss: 0
};

export function resetBlueprintAnalysisCounters() {
  counters.computeStats = 0;
  counters.normalizeDesign = 0;
  counters.normalizeWiring = 0;
  counters.validateBlueprint = 0;
  counters.powerFlow = 0;
  counters.thumbnailKey = 0;
  counters.catalogueRebuild = 0;
  counters.availabilityUpdate = 0;
  counters.cacheHit = 0;
  counters.cacheMiss = 0;
}

// The current editor Blueprint has a single cached entry keyed by design/wiring
// references and combat style. Replacing the arrays immutably is the normal way
// to invalidate this; explicit invalidation is also provided for safety.
let currentEntry = null;

// Saved Blueprints are keyed by the saved design ID. Each entry stores the
// references used to generate it so a caller can tell whether it is stale.
const savedCache = new Map();

function makeThumbnailKey(parts) {
  counters.thumbnailKey++;
  if (!Array.isArray(parts) || parts.length === 0) return "";
  return parts
    .map((p) => `${p.x},${p.y},${p.type},${normalizeRotation(p.rotation) || 0}${p.flipped === true ? ",m" : ""}`)
    .join(";");
}

function analyseRaw({ blueprint, wiring, combatStyle = "hold" }) {
  counters.normalizeDesign++;
  const { modules: normalizedBlueprint } = normalizeDesignDetailed(blueprint, { allowEmpty: true });

  counters.normalizeWiring++;
  const normalizedWiring = normalizeWiring(wiring, normalizedBlueprint);

  counters.computeStats++;
  const stats = computeStats(normalizedBlueprint, { wiring: normalizedWiring });

  counters.validateBlueprint++;
  const validation = validateBlueprint(normalizedBlueprint, { requireThrust: true, stats });

  return {
    normalizedBlueprint,
    normalizedWiring,
    stats,
    validation,
    weaponSummary: `${stats.weaponDps} DPS`,
    thumbnailKey: makeThumbnailKey(normalizedBlueprint),
    combatStyle: combatStyle || "hold"
  };
}

function currentKey(design, wiring, combatStyle) {
  return {
    design,
    wiring,
    combatStyle: combatStyle || "hold",
    balanceRevision: currentBalanceRevision()
  };
}

function currentMatches(entry, key) {
  if (!entry) return false;
  return (
    entry.key.design === key.design &&
    entry.key.wiring === key.wiring &&
    entry.key.combatStyle === key.combatStyle &&
    entry.key.balanceRevision === key.balanceRevision
  );
}

export function getCachedBlueprintAnalysis({ blueprint, wiring, combatStyle } = {}) {
  const key = currentKey(blueprint, wiring, combatStyle);
  if (currentMatches(currentEntry, key)) {
    counters.cacheHit++;
    return currentEntry.value;
  }
  return undefined;
}

export function analyseBlueprintOnce({ blueprint, wiring, combatStyle = "hold" } = {}) {
  const key = currentKey(blueprint, wiring, combatStyle);
  if (currentMatches(currentEntry, key)) {
    counters.cacheHit++;
    return currentEntry.value;
  }
  counters.cacheMiss++;
  const value = analyseRaw({ blueprint: blueprint || [], wiring, combatStyle });
  currentEntry = { key, value };
  return value;
}

function savedMatches(entry, saved, balanceRevision) {
  if (!entry) return false;
  return (
    entry.savedId === saved.id &&
    entry.blueprintRef === saved.blueprint &&
    entry.wiringRef === saved.wiring &&
    entry.combatStyle === (saved.combatStyle || "hold") &&
    entry.updatedAt === saved.updatedAt &&
    entry.balanceRevision === balanceRevision
  );
}

function getSavedAnalysis(saved) {
  const balanceRevision = currentBalanceRevision();
  const cached = savedCache.get(saved.id);
  if (savedMatches(cached, saved, balanceRevision)) {
    counters.cacheHit++;
    return cached.value;
  }
  return undefined;
}

export function analyseSavedBlueprintOnce(saved) {
  const balanceRevision = currentBalanceRevision();
  const cached = getSavedAnalysis(saved);
  if (cached !== undefined) {
    return cached;
  }
  counters.cacheMiss++;
  const value = analyseRaw({
    blueprint: saved?.blueprint,
    wiring: saved?.wiring,
    combatStyle: saved?.combatStyle || "hold"
  });
  savedCache.set(saved.id, {
    savedId: saved.id,
    blueprintRef: saved.blueprint,
    wiringRef: saved.wiring,
    combatStyle: saved.combatStyle || "hold",
    updatedAt: saved.updatedAt,
    balanceRevision,
    value
  });
  return value;
}

export function getCachedSavedBlueprintAnalysis(saved) {
  return getSavedAnalysis(saved);
}

export function invalidateCurrentBlueprintAnalysis() {
  currentEntry = null;
}

export function invalidateSavedBlueprintAnalysis(id) {
  if (id === undefined || id === null) {
    savedCache.clear();
  } else {
    savedCache.delete(id);
  }
}

export function invalidateAllBlueprintAnalysis() {
  currentEntry = null;
  savedCache.clear();
}

// Convenience helpers for callers that already have a Blueprint object and need
// the same structure whether it is the editor Blueprint or a saved one.
export function getBlueprintAnalysis(source) {
  if (!source) return undefined;
  if (source.id) {
    // looks like a saved design record
    return analyseSavedBlueprintOnce(source);
  }
  return analyseBlueprintOnce({
    blueprint: source.blueprint,
    wiring: source.wiring,
    combatStyle: source.combatStyle
  });
}
