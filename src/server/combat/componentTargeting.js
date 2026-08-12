"use strict";

const { PARTS } = require("../components");
const { normalizeRotation } = require("../shipDesign");
const { getOccupiedCells } = require("../footprint");
const {
  getShipCollisionGeometry,
  COMPONENT_CELL_COLLISION_RADIUS
} = require("../componentGeometry");
const { segmentCircleHit } = require("../projectiles");
const { isComponentAlive } = require("../componentHealth");
const { getCommandAuraMultiplier } = require("../commandAuras");
const { PRIORITY_COMPONENT_TYPES } = require("../repairCache");
const { stationAttackPoint } = require("../stationCollision");
const {
  moduleLocalPosition,
  moduleFootprintLocalPosition,
  weaponModuleWorldPosition
} = require("./weaponGeometry");
const { roomCombatRandom } = require("./random");

const MODULE_SCALE = 13;
const COMPONENT_RETARGET_MIN_MS = 2500;
const COMPONENT_RETARGET_SPAN_MS = 1500;
const STRUCTURAL_COMPONENT_TYPES = new Set(["armor", "compositeArmor", "bulkhead", "frame", "weaponMount"]);

function componentAimLocalPosition(ship, index) {

  const module = ship?.design?.[index];

  if (!module) return null;

  return moduleFootprintLocalPosition(module, ship?.moduleScale || MODULE_SCALE);

}



function componentAimWorldPosition(ship, index) {

  const local = componentAimLocalPosition(ship, index);

  if (!local) return null;

  const cos = Math.cos(ship.angle || 0);

  const sin = Math.sin(ship.angle || 0);

  return {

    x: ship.x + local.x * cos - local.y * sin,

    y: ship.y + local.x * sin + local.y * cos

  };

}



function targetAttackPoint(originX, originY, target) {
  if (target?.entityType === "station") return stationAttackPoint(originX, originY, target);
  return { x: target?.x ?? 0, y: target?.y ?? 0 };
}

function targetCoreAimWorldPosition(target, originX = 0, originY = 0) {

  if (target?.entityType === "station") return stationAttackPoint(originX, originY, target);

  if (!target?.alive || !target.design?.length) return null;



  for (let i = 0; i < target.design.length; i += 1) {

    if (target.design[i].type === "core" && isComponentAlive(target, i)) {

      const pos = componentAimWorldPosition(target, i);

      if (pos) return { ...pos, componentIndex: i };

    }

  }



  for (let i = 0; i < target.design.length; i += 1) {

    const type = target.design[i].type;

    if ((type === "backupCore" || type === "emergencyCore" || type === "commandCore" || type === "emergencyCommandCore") && isComponentAlive(target, i)) {

      const pos = componentAimWorldPosition(target, i);

      if (pos) return { ...pos, componentIndex: i };

    }

  }



  const livingCells = [];

  for (let i = 0; i < target.design.length; i += 1) {

    if (!isComponentAlive(target, i)) continue;

    const module = target.design[i];

    const part = PARTS[module.type] || PARTS.frame;

    const cells = getOccupiedCells(module.x, module.y, part.footprint || { width: 1, height: 1 }, normalizeRotation(module.rotation));

    livingCells.push(...cells);

  }



  if (!livingCells.length) return null;



  let sumX = 0;

  let sumY = 0;

  for (const cell of livingCells) {

    const local = moduleLocalPosition(cell);

    sumX += local.x;

    sumY += local.y;

  }

  const avgLocal = { x: sumX / livingCells.length, y: sumY / livingCells.length };

  const cos = Math.cos(target.angle || 0);

  const sin = Math.sin(target.angle || 0);

  return {

    x: target.x + avgLocal.x * cos - avgLocal.y * sin,

    y: target.y + avgLocal.x * sin + avgLocal.y * cos,

    componentIndex: -1

  };

}


function findBeamRayIntersections(target, x1, y1, x2, y2, beamRadius = 0) {

  if (!target?.alive || !target.design?.length) return [];



  // Footprint-aware, shared with projectile collision so beam and bullet

  // geometry can never drift apart. Every occupied cell is tested; the earliest

  // cell hit represents the component.

  const geometry = getShipCollisionGeometry(target);

  const cellCoords = geometry.worldCells;

  const hitMap = new Map();

  for (const i of geometry.liveComponentIndices) {

    if (!isComponentAlive(target, i)) continue;

    const cells = cellCoords[i] || [];

    for (const cell of cells) {

      const hit = segmentCircleHit(x1, y1, x2, y2, cell.x, cell.y, COMPONENT_CELL_COLLISION_RADIUS + beamRadius);

      if (hit) {

        const existing = hitMap.get(i);

        if (!existing || hit.t < existing.t) {

          hitMap.set(i, { index: i, hit, t: hit.t });

        }

      }

    }

  }



  const intersections = Array.from(hitMap.values());

  intersections.sort((a, b) => {

    if (Math.abs(a.t - b.t) > 1e-6) return a.t - b.t;

    const ay = a.hit?.y ?? 0;

    const by = b.hit?.y ?? 0;

    if (Math.abs(ay - by) > 1e-6) return by - ay;

    return a.index - b.index;

  });



  return intersections;

}



function isComponentExposed(ship, index) {

  const module = ship?.design?.[index];

  if (!module) return false;

  const part = PARTS[module.type] || PARTS.frame;

  const cells = getOccupiedCells(module.x, module.y, part.footprint || { width: 1, height: 1 }, normalizeRotation(module.rotation));

  const cellIndex = ship.componentCellIndex;

  if (!cellIndex) return true;

  for (const cell of cells) {

    const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    for (const [dx, dy] of neighbors) {

      const x = cell.x + dx;

      const y = cell.y + dy;

      if (x < 0 || y < 0 || x >= 15 || y >= 15) return true;

      const neighborIndex = cellIndex.get(x * 15 + y);

      if (neighborIndex === undefined || !isComponentAlive(ship, neighborIndex)) return true;

    }

  }

  return false;

}



function componentAimWeight(ship, index, previousIndex = null) {
  const module = ship?.design?.[index];
  if (!module || !isComponentAlive(ship, index)) return 0;
  const type = module.type;
  let weight = 1;
  if (isComponentExposed(ship, index)) weight += 4;
  if (PRIORITY_COMPONENT_TYPES.has(type) || PARTS[type]?.weapon) weight += 3;
  if (STRUCTURAL_COMPONENT_TYPES.has(type)) weight += 1.2;
  if (type === "core") weight *= 0.25;
  if (previousIndex !== null && index === previousIndex) weight *= 0.2;
  return weight;
}

function selectComponentAimIndex(room, target, previousIndex = null) {
  if (!target?.alive || !target.design?.length || !target.componentHp) return -1;
  const living = [];
  const livingNonCore = [];
  for (let i = 0; i < target.design.length; i += 1) {
    if (!isComponentAlive(target, i)) continue;
    if (!componentAimLocalPosition(target, i)) continue;
    living.push(i);
    if (target.design[i].type !== "core") livingNonCore.push(i);
  }
  let candidates = livingNonCore.length ? livingNonCore : living;
  if (candidates.length > 1 && previousIndex !== null) {
    const different = candidates.filter((idx) => idx !== previousIndex);
    if (different.length) candidates = different;
  }
  if (!candidates.length) return -1;
  let total = 0;
  const weighted = candidates.map((idx) => {
    const weight = Math.max(0.01, componentAimWeight(target, idx, previousIndex));
    total += weight;
    return { idx, weight };
  });
  let roll = roomCombatRandom(room)() * total;
  for (const entry of weighted) {
    roll -= entry.weight;
    if (roll <= 0) return entry.idx;
  }
  return weighted[weighted.length - 1].idx;
}



function nextComponentRetargetAt(room, ship, now) {

  const retentionMult = getCommandAuraMultiplier(ship, "componentAimRetentionMultiplier");

  const base = COMPONENT_RETARGET_MIN_MS + Math.floor(roomCombatRandom(room)() * COMPONENT_RETARGET_SPAN_MS);

  return now + (retentionMult !== 1 ? Math.round(base * retentionMult) : base);

}



function clearWeaponComponentAim(ship, weaponIndex) {

  if (ship?.weaponComponentTargetIds) ship.weaponComponentTargetIds[weaponIndex] = null;

  if (ship?.weaponComponentTargetIndices) ship.weaponComponentTargetIndices[weaponIndex] = -1;

  if (ship?.weaponComponentRetargetAt) ship.weaponComponentRetargetAt[weaponIndex] = 0;

}



function weaponComponentAimPoint(room, ship, weaponIndex, target, now) {

  // Stations are compound structures, never ship component targets. Keep the
  // station id as the selected target but aim at the live shield circumference
  // or nearest solid hull point from this weapon's actual muzzle origin.
  if (target?.entityType === "station") {
    clearWeaponComponentAim(ship, weaponIndex);
    const origin = weaponModuleWorldPosition(ship, ship.design?.[weaponIndex]);
    return { ...stationAttackPoint(origin.x, origin.y, target), componentIndex: -1 };
  }

  if (!target?.alive) {

    clearWeaponComponentAim(ship, weaponIndex);

    return target ? { x: target.x, y: target.y, componentIndex: -1 } : null;

  }

  if (!ship.weaponComponentTargetIds) ship.weaponComponentTargetIds = new Array(ship.design ? ship.design.length : 0).fill(null);

  if (!ship.weaponComponentTargetIndices) ship.weaponComponentTargetIndices = new Array(ship.design ? ship.design.length : 0).fill(-1);

  if (!ship.weaponComponentRetargetAt) ship.weaponComponentRetargetAt = new Array(ship.design ? ship.design.length : 0).fill(0);



  const currentTargetId = ship.weaponComponentTargetIds[weaponIndex];

  let currentIndex = ship.weaponComponentTargetIndices[weaponIndex];

  const targetChanged = currentTargetId !== target.id;

  const invalid = currentIndex === undefined || currentIndex < 0 || !isComponentAlive(target, currentIndex);

  const expired = now >= (ship.weaponComponentRetargetAt[weaponIndex] || 0);

  if (targetChanged || invalid || expired) {

    const previous = targetChanged ? null : currentIndex;
    currentIndex = selectComponentAimIndex(room, target, previous);

    ship.weaponComponentTargetIds[weaponIndex] = target.id;

    ship.weaponComponentTargetIndices[weaponIndex] = currentIndex;

    ship.weaponComponentRetargetAt[weaponIndex] = nextComponentRetargetAt(room, ship, now);

  }

  const point = currentIndex >= 0 ? componentAimWorldPosition(target, currentIndex) : null;

  return point ? { ...point, componentIndex: currentIndex } : { x: target.x, y: target.y, componentIndex: -1 };

}

module.exports = {
  STRUCTURAL_COMPONENT_TYPES,
  componentAimWorldPosition,
  targetAttackPoint,
  targetCoreAimWorldPosition,
  findBeamRayIntersections,
  isComponentExposed,
  selectComponentAimIndex,
  clearWeaponComponentAim,
  weaponComponentAimPoint
};
