"use strict";

const { PARTS } = require("./components");

function getShipComponentIndexes(ship) {
  const design = ship?.design || [];
  const designRevision = Number(ship?.designRevision) || 1;
  let cache = ship?._derivedComponentIndexes;
  if (!cache || cache.designSource !== design || cache.designRevision !== designRevision) {
    cache = {
      designSource: design,
      designRevision,
      weaponIndices: [],
      pointDefenseIndices: [],
      repairIndices: [],
      // Movement and thermal ticks previously re-scanned the whole design every
      // tick to find these; a design is immutable after spawn, so the lists are
      // derived once alongside the existing ones.
      thrustIndices: [],
      maneuverThrusterIndices: [],
      gyroscopeIndices: [],
      shieldRegenIndices: [],
      mainCoreIndex: -1,
      backupCoreIndex: -1
    };
    for (let i = 0; i < design.length; i += 1) {
      const module = design[i];
      const part = PARTS[module.type] || PARTS.frame;
      if (module.type === "core" && cache.mainCoreIndex < 0) cache.mainCoreIndex = i;
      if (module.type === "backupCore" && cache.backupCoreIndex < 0) cache.backupCoreIndex = i;
      if (part.weapon || module.type === "repairBeam") cache.weaponIndices.push(i);
      if (part.weapon?.type === "pointDefense") cache.pointDefenseIndices.push(i);
      if ((Number(part.repairRate) || 0) > 0) {
        cache.repairIndices.push(i);
      }
      if ((Number(part.thrust) || 0) > 0) cache.thrustIndices.push(i);
      if (module.type === "maneuverThruster") cache.maneuverThrusterIndices.push(i);
      if (module.type === "gyroscope") cache.gyroscopeIndices.push(i);
      if ((Number(part.shieldRegen) || 0) > 0) cache.shieldRegenIndices.push(i);
    }
    ship._derivedComponentIndexes = cache;
  }
  return cache;
}

function invalidateShipComponentIndexes(ship) {
  if (ship) ship._derivedComponentIndexes = null;
}

module.exports = { getShipComponentIndexes, invalidateShipComponentIndexes };
