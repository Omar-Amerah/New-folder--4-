"use strict";

// Immutable ship templates for multi-ship purchases.  Templates contain only
// design data, explicit Data Links, and cloned runtime state; Power is universal
// and has no persisted topology to cache.

const { computeStats } = require("./shipStats");
const { createShipBlueprintSnapshot } = require("./shipDesign");
const { PARTS } = require("./components");
const { getOccupiedCells } = require("./footprint");
const EngineExhaustRules = require("../../public/src/shared/engineExhaust.js");
const HeatRules = require("../../public/src/shared/heatRules.js");
const { initializeComponentPower, effectiveShieldStats } = require("./componentPower");
const { initShipHeat } = require("./heat");
const { buildThermalTopology } = require("./thermalTopology");

const templateCache = new Map();

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  return value;
}

function canonicalBlueprintSignature(design, dataLinks = []) {
  const blueprint = createShipBlueprintSnapshot(design, dataLinks);
  return canonicalize({
    design: blueprint.design,
    dataLinks: blueprint.dataLinks
  });
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function templateKey(playerId, design, dataLinks, signature) {
  return `${playerId}:${JSON.stringify(signature || canonicalBlueprintSignature(design, dataLinks))}`;
}

function invalidatePlayerTemplates(playerId) {
  for (const key of templateCache.keys()) if (key.startsWith(`${playerId}:`)) templateCache.delete(key);
}

function createImmutableShipTemplate(design, dataLinks, stats) {
  const blueprint = createShipBlueprintSnapshot(design, dataLinks);
  const normalizedDesign = blueprint.design;
  const normalizedDataLinks = blueprint.dataLinks;
  const weaponIndices = [];
  const engineIndices = [];
  const droneBayIndices = [];
  const decoyLauncherIndices = [];
  const shieldIndices = [];
  const repairIndices = [];
  const componentCellIndex = new Map();

  for (let i = 0; i < normalizedDesign.length; i += 1) {
    const module = normalizedDesign[i];
    const part = PARTS[module.type] || {};
    if (part.weapon) weaponIndices.push(i);
    if (part.category === "Engines" && part.thrust > 0) engineIndices.push(i);
    if (module.type === "droneBay") droneBayIndices.push(i);
    if (part.decoyConfig) decoyLauncherIndices.push(i);
    if (part.shieldRegen > 0) shieldIndices.push(i);
    if (part.repair > 0) repairIndices.push(i);
    for (const cell of getOccupiedCells(module.x, module.y, part.footprint || { width: 1, height: 1 }, module.rotation || 0)) {
      componentCellIndex.set(cell.x * 15 + cell.y, i);
    }
  }

  const exhaustAnalysis = EngineExhaustRules.analyze(normalizedDesign, PARTS, { alive: normalizedDesign.map(() => true) });
  const rawHp = normalizedDesign.map((module) => Math.max(1, (PARTS[module.type] || PARTS.frame).hp || 1));
  const rawSum = rawHp.reduce((sum, hp, i) => normalizedDesign[i].type === "core" ? sum : sum + hp, 0) || 1;
  const scale = (stats?.maxHp || rawSum) / rawSum;
  const componentMaxHp = rawHp.map((hp, i) => normalizedDesign[i].type === "core" ? (PARTS.core?.hp || 340) : hp * scale);
  const componentBaseThermals = normalizedDesign.map((module) => HeatRules.profile(module.type, PARTS[module.type] || {}));
  const componentBaseHeatCapacity = componentBaseThermals.map((thermal) => thermal.capacity);
  const thermalTopology = buildThermalTopology(normalizedDesign);

  const prebuilt = {
    componentMaxHp,
    componentHp: componentMaxHp.slice(),
    thermalTopology,
    _thermalTopologyShared: true,
    componentCellIndex,
    componentStorageCharge: normalizedDesign.map((module) => {
      const part = PARTS[module?.type] || {};
      return Number(part.energyCapacity ?? part.energyStorage ?? part.energy) || 0;
    }),
    stats: { ...stats },
    hp: stats?.maxHp || 0,
    maxHp: stats?.maxHp || 0,
    coreDestroyed: false,
    componentAliveRevision: 1,
    dirtyComponents: new Set(),
    proximityChargeDetonated: normalizedDesign.map(() => 0),
    proximityChargeRevision: 1,
    dataLinks: normalizedDataLinks
  };
  prebuilt.design = normalizedDesign;
  initializeComponentPower(prebuilt);
  initShipHeat(prebuilt);
  const shield = effectiveShieldStats(prebuilt);
  prebuilt.maxShield = Math.max(0, shield.capacity);
  prebuilt.shield = prebuilt.maxShield;
  delete prebuilt.design;
  delete prebuilt.stats;

  return deepFreeze({
    design: normalizedDesign.map((part) => ({ ...part })),
    dataLinks: normalizedDataLinks.map((link) => ({ ...link })),
    stats: { ...stats },
    weaponIndices,
    engineIndices,
    droneBayIndices,
    decoyLauncherIndices,
    shieldIndices,
    repairIndices,
    componentCellIndex,
    exhaustAnalysis,
    componentMaxHp,
    thermalTopology,
    componentBaseHeatCapacity,
    radius: stats?.radius || 0,
    unitCost: stats?.unitCost || 0,
    maxHp: stats?.maxHp || 0,
    prebuiltShipState: prebuilt
  });
}

function getOrCreateTemplate(playerId, design, dataLinks, stats, blueprintSignature) {
  const key = templateKey(playerId, design, dataLinks, blueprintSignature);
  let template = templateCache.get(key);
  if (!template) {
    template = createImmutableShipTemplate(design, dataLinks, stats);
    templateCache.set(key, template);
    if (templateCache.size > 128) templateCache.delete(templateCache.keys().next().value);
  }
  return template;
}

function clearTemplateCache() { templateCache.clear(); }

module.exports = {
  getOrCreateTemplate,
  invalidatePlayerTemplates,
  clearTemplateCache,
  createImmutableShipTemplate,
  canonicalBlueprintSignature,
  canonicalize
};
