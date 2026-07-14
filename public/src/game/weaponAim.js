// Renderer-neutral turret aiming math: which parts are rotating weapons, the
// authoritative ship-relative weapon angle for a design slot, relative/world
// angle conversion, and the shared traverse-rate lookup. No Canvas, no Pixi,
// no DOM — both renderers (and tests) import these.

import { PART_STATS, isRotatablePart } from "../design/parts.js";
import { moduleRotationToRadians, normalizeRotation } from "../design/rotation.js";
import { angleDifference } from "../shared/math.js";

// A part whose weapon top visually tracks targets: rotatable AND an actual
// weapon. Rotatable structural silhouettes (wings, diagonal halves) are static
// hull artwork drawn at their blueprint rotation, not turrets.
export function isRotatingWeaponPart(type) {
  return isRotatablePart(type) && Boolean(PART_STATS[type]?.weapon);
}

// Design indices of every rotating weapon in a design (uncompressed: these are
// the same indices the server uses for ship.weaponAngles).
export function rotatingWeaponIndices(design) {
  const indices = [];
  if (!Array.isArray(design)) return indices;
  for (let i = 0; i < design.length; i += 1) {
    if (isRotatingWeaponPart(design[i]?.type)) indices.push(i);
  }
  return indices;
}

// The blueprint-facing angle of a part, ship-relative.
export function defaultWeaponRelativeAngle(part) {
  return moduleRotationToRadians(normalizeRotation(part?.rotation));
}

// The latest authoritative ship-relative weapon angle for design[index]:
// the server's ship.weaponAngles entry when present, else the blueprint facing.
export function authoritativeWeaponAngle(ship, index, part) {
  const angle = ship?.weaponAngles?.[index];
  if (Number.isFinite(angle)) return angle;
  return defaultWeaponRelativeAngle(part || ship?.design?.[index]);
}

// Ship-relative -> world weapon angle. World = hull rotation + relative.
export function weaponRelativeToWorld(hullAngle, relativeAngle) {
  return (Number(hullAngle) || 0) + (Number(relativeAngle) || 0);
}

// World -> ship-relative weapon angle, normalized to (-PI, PI].
export function weaponWorldToRelative(hullAngle, worldAngle) {
  return angleDifference(Number(hullAngle) || 0, Number(worldAngle) || 0);
}

// Traverse rate (rad/s) for a weapon stat object or family string.
// Single source of truth shared with the server (src/server/combat.js): the
// turret sprites must sweep at exactly the rate the server aims, otherwise
// the visible barrel and the actual shot direction drift apart.
export function getWeaponTurnRate(weapon) {
  return globalThis.TurretRules.turnRateFor(weapon);
}
