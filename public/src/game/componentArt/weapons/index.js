// Weapon mounts and rotating artwork. Weapon subfamilies share one drawing
// pipeline so static sockets, muzzle geometry, and charge-stage baking stay aligned.

import { ctx } from "../../../ui/dom.js";
import {
  drawComponentCubeBase,
  drawFootprintPanel,
  drawFootprintSeams,
  drawRecessedPanel,
  getModuleGradient,
  mixColor,
  roundRect
} from "../common.js";
import { STRUCTURAL_PARTS } from "../structure.js";
import { drawBallisticMultiWeaponTop, drawBallisticWeaponTop, drawSimpleTurntable } from "./ballistic.js";
import { drawBeamMultiWeaponTop, drawBeamWeaponTop } from "./beam.js";
import { weaponBodyFill, weaponFine, weaponLine, weaponMetals, drawTurretCap } from "./common.js";
import { drawDefensiveMultiWeaponTop, drawDefensiveWeaponTop } from "./defensive.js";
import { drawMissileMultiWeaponTop, drawMissileWeaponTop, drawTorpedoCradle } from "./missile.js";
import { drawSpecialMultiWeaponTop } from "./special.js";

const SINGLE_WEAPON_TOP_DRAWERS = Object.freeze({
  blaster: drawBallisticWeaponTop,
  autocannon: drawBallisticWeaponTop,
  scatterCannon: drawBallisticWeaponTop,
  railgun: drawBallisticWeaponTop,
  pointDefense: drawDefensiveWeaponTop,
  flakCannon: drawDefensiveWeaponTop,
  aegisProjector: drawDefensiveWeaponTop,
  interceptorPod: drawDefensiveWeaponTop,
  missile: drawMissileWeaponTop,
  swarmMissile: drawMissileWeaponTop,
  torpedo: drawMissileWeaponTop,
  beamEmitter: drawBeamWeaponTop,
  repairBeam: drawBeamWeaponTop,
  thermalInductionLance: drawBeamWeaponTop
});

const MULTI_WEAPON_TOP_DRAWERS = Object.freeze({
  railgun: drawBallisticMultiWeaponTop,
  empCannon: drawSpecialMultiWeaponTop,
  plasmaCannon: drawSpecialMultiWeaponTop,
  fragmentationCannon: drawSpecialMultiWeaponTop,
  spinalAccelerator: drawSpecialMultiWeaponTop,
  beamEmitter: drawBeamMultiWeaponTop,
  repairBeam: drawBeamMultiWeaponTop,
  thermalInductionLance: drawBeamMultiWeaponTop,
  torpedo: drawMissileMultiWeaponTop,
  swarmMissile: drawMissileMultiWeaponTop,
  aegisProjector: drawDefensiveMultiWeaponTop
});


const COMPONENT_ART_ALIASES = Object.freeze({
  lightFrame: "frame",
  heavyFrame: "frame",
  bulkhead: "armor",
  lightMount: "weaponMount",
  heavyMount: "weaponMount",
  smallReactor: "reactor",
  heavyReactor: "reactor",
  microThruster: "maneuverThruster",
  lightShield: "shield",
  heavyShield: "shield",
  regenShield: "shield",
  lightBlaster: "blaster",
  heavyBlaster: "blaster",
  lightMissile: "missile",
  lightRailgun: "railgun",
  heavyRailgun: "railgun",
  pointDefenseLaser: "pointDefense"
});

export function componentArtType(type) {
  return COMPONENT_ART_ALIASES[type] || type;
}

export const WEAPON_ART_TYPES = new Set([
  "blaster", "autocannon", "pointDefense", "flakCannon", "missile",
  "railgun", "swarmMissile", "torpedo", "beamEmitter", "thermalInductionLance", "repairBeam",
  "aegisProjector", "interceptorPod",
  "scatterCannon", "plasmaCannon", "fragmentationCannon", "spinalAccelerator", "empCannon"
]);




export function drawWeaponBase(size) {
  ctx.save();
  ctx.fillStyle = "rgba(6,10,16,0.88)";
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(0, 0, size * 0.33, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.save();
  ctx.strokeStyle = "rgba(226,232,240,0.22)";
  ctx.lineWidth = Math.max(0.6, size * 0.03);
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.27, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(9,14,22,0.9)";
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.13, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}







export function drawStaticComponentBase({ type, unit, tilesLong = 1, tilesCross = 1, color, trim }) {
  const structural = STRUCTURAL_PARTS.has(type);
  const bodyColor = trim && structural ? mixColor(color, trim, 0.24) : color;
  const multi = tilesLong > 1 || tilesCross > 1;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(0.9, unit * 0.08);
  ctx.strokeStyle = "rgba(3,6,12,0.72)";
  if (!multi) {
    drawComponentCubeBase(unit, bodyColor);
  } else {
    const hl = (tilesLong * unit) / 2;
    const hc = (tilesCross * unit) / 2;
    // Keep the outside half of the outline inside the occupied footprint.
    // Arena textures are not cell-clipped, so this prevents a multi-cell body
    // from bleeding a dark stroke into an adjacent component at any zoom.
    const edgeInset = ctx.lineWidth * 0.5;
    const radius = Math.min(unit * 0.1, hc * 0.22);
    ctx.fillStyle = getModuleGradient(Math.max(hl, hc) * 2, bodyColor);
    roundRect(ctx, {
      x: -hl + edgeInset,
      y: -hc + edgeInset,
      width: hl * 2 - edgeInset * 2,
      height: hc * 2 - edgeInset * 2,
      radius
    });
    ctx.fill();
    ctx.stroke();
    // Same lit top-left / dark bottom-right bevel the 1x1 cube carries, so a
    // multi-cell weapon slab is made of the same metal as every other tile
    // instead of reading as a flat painted panel next to them.
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = Math.max(0.7, unit * 0.045);
    ctx.beginPath();
    ctx.moveTo(-hl + radius, -hc + unit * 0.03);
    ctx.lineTo(hl - radius, -hc + unit * 0.03);
    ctx.moveTo(-hl + unit * 0.03, -hc + radius);
    ctx.lineTo(-hl + unit * 0.03, hc - radius);
    ctx.stroke();
    ctx.strokeStyle = "rgba(3,6,12,0.45)";
    ctx.beginPath();
    ctx.moveTo(-hl + radius, hc - unit * 0.03);
    ctx.lineTo(hl - radius, hc - unit * 0.03);
    ctx.moveTo(hl - unit * 0.03, -hc + radius);
    ctx.lineTo(hl - unit * 0.03, hc - radius);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

export function drawStaticWeaponMount({ type, unit, tilesLong = 1, tilesCross = 1, color }) {
  const artType = componentArtType(type);
  const multi = tilesLong > 1 || tilesCross > 1;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(0.9, unit * 0.08);
  ctx.strokeStyle = "rgba(3,6,12,0.72)";
  ctx.fillStyle = getModuleGradient(unit, color);

  if (multi) {
    const hl = (tilesLong * unit) / 2;
    const hc = (tilesCross * unit) / 2;
    if (artType === "railgun") {
      // Same recessed bay as the rest of the catalogue. This used to be a
      // bright machined plate, which left an open-frame weapon sitting on a
      // flat silver slab with nothing behind it to read against. It still gets
      // no bearing ring : an open frame has nowhere to hide one, and a disc in
      // the middle of the bore just reads as a stray circle.
      drawFootprintPanel(unit, hl, hc, 0.94, 0.88, 0.09);
      drawFootprintSeams(unit, hl, hc, tilesLong);
    } else if (artType === "torpedo") {
      drawFootprintPanel(unit, hl, hc, 0.94, 0.88, 0.09);
      drawFootprintSeams(unit, hl, hc, tilesLong);
      drawTorpedoCradle(unit, hl, hc);
    } else if (artType === "swarmMissile") {
      // Pod, not turret: no bearing ring under it. A circular base made the
      // launcher read as a gun mount with a box sitting on top.
      drawFootprintPanel(unit, hl, hc, 0.96, 0.92, 0.08);
      drawFootprintSeams(unit, hl, hc, tilesLong);
    } else if (artType === "spinalAccelerator") {
      // A spinal mount is not a turret: it is a gun the ship is built around.
      // The hull under it carries a long recessed race with heavy cross frames,
      // and deliberately no bearing ring : a disc in the middle of a twelve-cell
      // weapon reads as a decal, exactly as it did on the railgun.
      drawFootprintPanel(unit, hl, hc, 0.96, 0.9, 0.08);
      drawFootprintSeams(unit, hl, hc, tilesLong);
      ctx.save();
      ctx.strokeStyle = "rgba(3,6,12,0.6)";
      ctx.lineWidth = Math.max(1, unit * 0.09);
      ctx.lineCap = "butt";
      for (let frame = 1; frame < tilesLong; frame += 1) {
        const fx = -hl + (hl * 2 * frame) / tilesLong;
        ctx.beginPath();
        ctx.moveTo(fx, -hc * 0.86);
        ctx.lineTo(fx, hc * 0.86);
        ctx.stroke();
      }
      ctx.restore();
    } else if (artType === "empCannon") {
      // Low collar, not the wide bearing ring the ballistic mounts use: the EMP
      // top carries its mass in the rear capacitor bank and only a thin coil
      // spine crosses the pivot, so a wide ring drew an exposed black circle
      // around that spine and read as a symbol printed on the hull.
      drawFootprintPanel(unit, hl, hc, 0.94, 0.88, 0.09);
      drawFootprintSeams(unit, hl, hc, tilesLong);
      drawWeaponBase(Math.min(hl, hc) * 0.95);
    } else if (artType === "beamEmitter" || artType === "repairBeam" || artType === "thermalInductionLance") {
      // The beam family pivots on a low collar, not the wide bearing ring: at
      // this footprint the ring drew a black circle right through the middle of
      // the weapon, which read as a symbol printed on the hull.
      drawFootprintPanel(unit, hl, hc, 0.94, 0.88, 0.09);
      drawFootprintSeams(unit, hl, hc, tilesLong);
      drawWeaponBase(Math.min(hl, hc) * 0.95);
    } else {
      drawFootprintPanel(unit, hl, hc, 0.94, 0.88, 0.09);
      drawFootprintSeams(unit, hl, hc, tilesLong);
      // Central bearing ring the gun assembly pivots on.
      drawWeaponBase(Math.min(hl, hc) * 1.7);
    }
    ctx.restore();
    return;
  }

  const size = unit;

  // Every weapon opens with the same recessed bay the system modules use, so a
  // weapon tile is built like a reactor or engine tile: coloured cube, dark
  // inset working area, hardware on top. Weapons used to skip this and paint
  // their socket straight onto the cube, which is a large part of why they read
  // as a different art set in the grid.
  drawRecessedPanel(size, 0.88, 0.88, 0.09);
  ctx.fillStyle = getModuleGradient(unit, color);

  if (artType === "flakCannon") {
    // Twin small sockets: one per mini-turret.
    ctx.save();
    ctx.translate(0, -size * 0.22);
    drawWeaponBase(size * 0.65);
    ctx.restore();
    ctx.save();
    ctx.fillStyle = getModuleGradient(unit, color);
    ctx.translate(0, size * 0.22);
    drawWeaponBase(size * 0.65);
    ctx.restore();
  } else if (artType === "missile") {
    drawWeaponBase(size * 0.62);
  } else if (artType === "railgun") {
    drawWeaponBase(size * 0.66);
  } else if (artType === "swarmMissile") {
    // No bearing ring: a launch pod is a block bolted to the hull, and a
    // circular turret base under it made it read as a gun mount.
  } else if (artType === "interceptorPod") {
    drawWeaponBase(size * 0.62);
  } else if (artType === "torpedo") {
    drawWeaponBase(size * 0.6);
  } else if (artType === "aegisProjector") {
    drawWeaponBase(size * 0.62);
  } else if (artType === "autocannon" || artType === "scatterCannon") {
    drawSimpleTurntable(size, color);
  } else {
    // blaster / pointDefense / beamEmitter / repairBeam / unknown
    drawWeaponBase(size * 0.86);
  }
  ctx.restore();
}



export function drawRotatingWeaponTop({ type, unit, tilesLong = 1, tilesCross = 1, color, chargeProgress = null }) {
  const artType = componentArtType(type);
  const size = unit;
  const hl = (Math.max(1, tilesLong) * unit) / 2;
  const hc = (Math.max(1, tilesCross) * unit) / 2;
  const multi = tilesLong > 1 || tilesCross > 1;
  const M = weaponMetals(color);

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = weaponLine(unit);
  ctx.strokeStyle = "rgba(3,6,12,0.72)";

  if (multi) {
    drawMultiCellWeaponTop(artType, unit, hl, hc, color, chargeProgress);
    ctx.restore();
    return;
  }

  const drawFamilyTop = SINGLE_WEAPON_TOP_DRAWERS[artType];
  if (drawFamilyTop) drawFamilyTop(artType, size, color, M);
  ctx.restore();
}

export const WEAPON_CHARGE_STAGES = 8;

export function weaponChargeStage(progress) {
  const value = Number(progress);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(WEAPON_CHARGE_STAGES - 1, Math.round(Math.min(1, value) * (WEAPON_CHARGE_STAGES - 1)));
}


function drawMultiCellWeaponTop(artType, unit, hl, hc, color, chargeProgress = null) {
  const fine = weaponFine(unit);
  const M = weaponMetals(color);
  const drawFamilyTop = MULTI_WEAPON_TOP_DRAWERS[artType];
  if (drawFamilyTop) {
    drawFamilyTop(artType, unit, hl, hc, color, chargeProgress, M, fine);
    return;
  }

    // Generic elongated barrel out to the forward footprint edge.
    ctx.fillStyle = weaponBodyFill(M);
    roundRect(ctx, { x: -hl * 0.3, y: -hc * 0.24, width: hl * 1.24, height: hc * 0.48, radius: unit * 0.08 });
    ctx.fill();
    ctx.stroke();
    drawTurretCap(unit * Math.min(2, (hc * 2) / unit), color, 0.2);
}
