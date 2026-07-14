import { PART_DEFS, PART_STATS, isRotatablePart } from "../design/parts.js";
import { moduleRotationToRadians, normalizeRotation } from "../design/rotation.js";
import { drawModule, drawFootprintComponent, drawStaticComponentBase, drawStaticWeaponMount } from "./componentArt.js";
import { isRotatingWeaponPart } from "./weaponAim.js";

export function drawPlacedStaticComponent(ctx, { part, place, unit, color, trim, includeWeaponTop = false }) {
  const def = PART_DEFS[part?.type] || PART_DEFS.frame;
  const bodyColor = color || def.color;
  const weapon = isRotatingWeaponPart(part?.type) || Boolean(PART_STATS[part?.type]?.weapon && isRotatablePart(part?.type));
  ctx.save();
  ctx.translate(place.cx, place.cy);
  if (weapon) {
    ctx.rotate(place.longAxisAngle);
    drawStaticComponentBase({ type: part.type, unit, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: bodyColor, trim });
    drawStaticWeaponMount({ type: part.type, unit, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: bodyColor });
    if (includeWeaponTop) drawFootprintComponent({ type: part.type, unit, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: bodyColor, trim, drawBase: false });
  } else if (place.multi) {
    ctx.rotate(place.longAxisAngle);
    drawFootprintComponent({ type: part.type, unit, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: bodyColor, trim });
  } else if (isRotatablePart(part?.type) || part?.type === "maneuverThruster") {
    ctx.rotate(moduleRotationToRadians(normalizeRotation(part.rotation)));
    drawModule({ x: 0, y: 0, size: unit, color: bodyColor, type: part.type, trim });
  } else {
    drawModule({ x: 0, y: 0, size: unit, color: bodyColor, type: part.type, trim });
  }
  ctx.restore();
}
