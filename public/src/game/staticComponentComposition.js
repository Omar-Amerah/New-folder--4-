import { PART_DEFS, PART_STATS, isRotatablePart, isFlippablePart } from "../design/parts.js";
import {
  directionalFootprintToShipRadians,
  moduleRotationToRadians,
  normalizeRotation
} from "../design/rotation.js";
import {
  drawModule,
  drawFootprintComponent,
  drawStaticComponentBase,
  drawStaticWeaponMount,
  drawRotatingWeaponTop,
  STRUCTURAL_PARTS
} from "./componentArt.js";

import {
  defaultWeaponRelativeAngle,
  isRotatingWeaponPart
} from "./weaponAim.js";

// connectionMask is the ship-local coolant connection mask for this placement
// (design/coolantLayout.js shipLocalCoolantMasks). Only thermal-plumbing art
// reads it; every other part ignores it.
export function drawPlacedStaticComponent(ctx, { part, place, unit, color, trim, includeWeaponTop = false, visualState, connectionMask = 0 }) {
  const def = PART_DEFS[part?.type] || PART_DEFS.frame;
  const bodyColor = color || def.color;
  // A mirrored placement is drawn mirrored: the art helpers apply the same
  // mirror-then-rotate order the placement geometry uses.
  const flipped = isFlippablePart(part?.type) && part?.flipped === true;
  const weapon = isRotatingWeaponPart(part?.type) || Boolean(PART_STATS[part?.type]?.weapon && isRotatablePart(part?.type));
  ctx.save();
  ctx.translate(place.cx, place.cy);
  if (weapon) {
    // Static footprint and circular/non-directional mount.
    ctx.save();
    ctx.rotate(place.longAxisAngle);

    drawStaticComponentBase({
      type: part.type,
      unit,
      tilesLong: place.tilesLong,
      tilesCross: place.tilesCross,
      color: bodyColor,
      trim
    });

    drawStaticWeaponMount({
      type: part.type,
      unit,
      tilesLong: place.tilesLong,
      tilesCross: place.tilesCross,
      color: bodyColor
    });

    ctx.restore();

    // Directional turret top.
    if (includeWeaponTop) {
      ctx.save();
      ctx.rotate(defaultWeaponRelativeAngle(part));

      drawRotatingWeaponTop({
        type: part.type,
        unit,
        tilesLong: place.tilesLong,
        tilesCross: place.tilesCross,
        color: bodyColor
      });

      ctx.restore();
    }
  } else if (place.multi) {
    const stat = PART_STATS[part.type] || {};
    const artAngle = stat.sensorRole === "directed"
      ? directionalFootprintToShipRadians(
        normalizeRotation(part.rotation),
        stat.footprint
      )
      : place.longAxisAngle;
    if (part.type.startsWith("longWedge")) {
      // Long wedge needs the same shape/material split as 1-cell bevels, but its
      // material routine is interleaved with frame bracing. Keep rotating the full
      // canvas for now to avoid a visual regression while the single-cell fix lands.
      // The canvas already carries the rotation, so the mirror passed below is
      // applied inside it : still mirror first, rotation second.
      ctx.rotate(artAngle);
      drawFootprintComponent({ type: part.type, unit, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: bodyColor, trim, visualState, flipped });
    } else if (STRUCTURAL_PARTS.has(part.type)) {
      drawFootprintComponent({ type: part.type, unit, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: bodyColor, trim, visualState, rotation: artAngle, flipped });
    } else {
      ctx.rotate(artAngle);
      drawFootprintComponent({ type: part.type, unit, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: bodyColor, trim, visualState });
    }
  } else if (isRotatablePart(part?.type) || part?.type === "maneuverThruster") {
    if (STRUCTURAL_PARTS.has(part?.type)) {
      drawModule({ x: 0, y: 0, size: unit, color: bodyColor, type: part.type, trim, visualState, rotation: normalizeRotation(part.rotation), flipped });
    } else {
      ctx.rotate(moduleRotationToRadians(normalizeRotation(part.rotation)));
      drawModule({ x: 0, y: 0, size: unit, color: bodyColor, type: part.type, trim, visualState, connectionMask });
    }
  } else {
    drawModule({ x: 0, y: 0, size: unit, color: bodyColor, type: part.type, trim, visualState, connectionMask });
  }
  ctx.restore();
}
