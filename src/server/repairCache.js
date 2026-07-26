"use strict";

const { PARTS } = require("./components");

const PRIORITY_COMPONENT_TYPES = new Set([
  "engine", "maneuverThruster", "reactor", "nuclearReactor", "auxGenerator", "battery",
  "capacitor", "shield", "aegisProjector", "repair", "repairBeam", "fireControl"
]);

function markShipRepairCacheDirty(ship) {
  if (!ship) return;
  ship.repairCacheRevision = (Number(ship.repairCacheRevision) || 0) + 1;
}

function computeShipRepairCache(ship) {
  const revision = Number(ship?.repairCacheRevision) || 0;
  if (!ship || !ship.alive) return { need: 0, importantDamageFraction: 0, revision };
  let need = Math.max(0, (Number(ship.maxHp) || 0) - (Number(ship.hp) || 0));
  const design = ship.design || [];
  const hp = ship.componentHp || [];
  const max = ship.componentMaxHp || [];
  let important = 0;
  let damagedImportant = 0;
  for (let i = 0; i < hp.length; i += 1) {
    const componentHp = Number(hp[i]) || 0;
    const componentMaxHp = Number(max[i]) || 0;
    need += Math.max(0, componentMaxHp - componentHp);
    const type = design[i]?.type;
    if (!(type === "core" || PRIORITY_COMPONENT_TYPES.has(type) || PARTS[type]?.weapon)) continue;
    important += 1;
    if (componentMaxHp > 0 && componentHp < componentMaxHp - 0.01) damagedImportant += 1;
  }
  return {
    need,
    importantDamageFraction: important > 0 ? damagedImportant / important : 0,
    revision,
    aggregateHp: Number(ship.hp) || 0,
    aggregateMaxHp: Number(ship.maxHp) || 0
  };
}

function getShipRepairCache(ship) {
  const revision = Number(ship?.repairCacheRevision) || 0;
  if (!ship || !ship.alive) {
    if (ship) ship.repairTargetCache = { need: 0, importantDamageFraction: 0, revision };
    return ship?.repairTargetCache || { need: 0, importantDamageFraction: 0, revision };
  }
  if (!ship?.repairTargetCache
    || ship.repairTargetCache.revision !== revision
    || ship.repairTargetCache.aggregateHp !== (Number(ship.hp) || 0)
    || ship.repairTargetCache.aggregateMaxHp !== (Number(ship.maxHp) || 0)) {
    if (ship) ship.repairTargetCache = computeShipRepairCache(ship);
  }
  return ship?.repairTargetCache || { need: 0, importantDamageFraction: 0, revision };
}

function clearShipRepairCache(ship) {
  if (!ship) return;
  ship.repairTargetCache = null;
  markShipRepairCacheDirty(ship);
}

module.exports = {
  PRIORITY_COMPONENT_TYPES,
  markShipRepairCacheDirty,
  computeShipRepairCache,
  getShipRepairCache,
  clearShipRepairCache
};
