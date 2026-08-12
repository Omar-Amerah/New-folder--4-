"use strict";

const { PARTS } = require("../components");
const { normalizeRotation } = require("../shipDesign");
const { getOccupiedCells } = require("../footprint");
const TurretRules = require("../../../public/src/shared/turretRules");

const MODULE_SCALE = 13;


const moduleRotationToRadians = require("../../../public/src/shared/rotationRules").moduleRotationToRadians;



function moduleLocalPosition(module, scale = MODULE_SCALE) {

  // 7 = center of the 15x15 build grid (core position), keeping module world

  // coordinates centered on the ship origin.

  return {

    x: (7 - module.y) * scale,

    y: (module.x - 7) * scale

  };

}



function moduleFootprintLocalPosition(module, scale = MODULE_SCALE) {

  const footprint = PARTS[module.type]?.footprint || { width: 1, height: 1 };

  const cells = getOccupiedCells(module.x, module.y, footprint, normalizeRotation(module.rotation));

  if (cells.length <= 1) return moduleLocalPosition(module, scale);

  let x = 0;

  let y = 0;

  for (const cell of cells) {

    const local = moduleLocalPosition(cell, scale);

    x += local.x;

    y += local.y;

  }

  return { x: x / cells.length, y: y / cells.length };

}



function weaponFacingAngle(ship, module, hullAngle = ship.angle) {

  return hullAngle + moduleRotationToRadians(normalizeRotation(module.rotation));

}



function weaponModuleWorldPosition(ship, module, hullAngle = ship.angle) {

  // Multi-cell turret artwork pivots around the footprint centre, not the

  // blueprint anchor tile. Keep server targeting/projectiles on that same pivot.

  const local = moduleFootprintLocalPosition(module);

  const cos = Math.cos(hullAngle);

  const sin = Math.sin(hullAngle);

  return {

    x: ship.x + local.x * cos - local.y * sin,

    y: ship.y + local.x * sin + local.y * cos

  };

}



function weaponMuzzleDistance(module, family, scale = MODULE_SCALE) {

  // Barrel-tip distances live in the shared TurretRules so projectiles spawn

  // exactly where the client draws the muzzle.

  const footprint = PARTS[module.type]?.footprint || { width: 1, height: 1 };

  const longTiles = Math.max(footprint.width || 1, footprint.height || 1);

  return TurretRules.muzzleTiles(module.type, family, longTiles) * scale;

}



function weaponMuzzleWorldPosition(ship, module, angle, family, barrelIndex = 0) {

  const origin = weaponModuleWorldPosition(ship, module);

  const distance = weaponMuzzleDistance(module, family);

  // Multi-barrel weapons (autocannon) stagger their shots across the tubes, so
  // the round leaves the barrel that fired it rather than the pivot between
  // them. Zero for every single-barrel weapon.

  const lateral = TurretRules.barrelLateralTiles(module.type, barrelIndex) * MODULE_SCALE;

  return {

    x: origin.x + Math.cos(angle) * distance - Math.sin(angle) * lateral,

    y: origin.y + Math.sin(angle) * distance + Math.cos(angle) * lateral

  };

}




module.exports = {
  moduleRotationToRadians,
  moduleLocalPosition,
  moduleFootprintLocalPosition,
  weaponFacingAngle,
  weaponModuleWorldPosition,
  weaponMuzzleDistance,
  weaponMuzzleWorldPosition
};
