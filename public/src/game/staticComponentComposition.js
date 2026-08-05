import { PART_DEFS, PART_STATS, isRotatablePart } from "../design/parts.js";
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
  drawRotatingWeaponTop
} from "./componentArt.js";

import {
  defaultWeaponRelativeAngle,
  isRotatingWeaponPart
} from "./weaponAim.js";

export function drawPlacedStaticComponent(ctx, { part, place, unit, color, trim, includeWeaponTop = false, visualState }) {
  const def = PART_DEFS[part?.type] || PART_DEFS.frame;
  const bodyColor = color || def.color;
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
    ctx.rotate(artAngle);
    drawFootprintComponent({ type: part.type, unit, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: bodyColor, trim, visualState });
  } else if (isRotatablePart(part?.type) || part?.type === "maneuverThruster") {
    ctx.rotate(moduleRotationToRadians(normalizeRotation(part.rotation)));
    drawModule({ x: 0, y: 0, size: unit, color: bodyColor, type: part.type, trim, visualState });
  } else {
    drawModule({ x: 0, y: 0, size: unit, color: bodyColor, type: part.type, trim, visualState });
  }
  ctx.restore();
}
